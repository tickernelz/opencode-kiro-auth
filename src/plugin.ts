
import { loadConfig } from './plugin/config';
import { AccountManager, generateAccountId } from './plugin/accounts';
import { createProactiveRefreshQueue } from './plugin/refresh-queue';
import { createSessionRecoveryHook } from './plugin/recovery';
import { accessTokenExpired, parseRefreshParts, encodeRefreshToken } from './kiro/auth';
import { refreshAccessToken } from './plugin/token';
import { transformToCodeWhisperer } from './plugin/request';
import { parseEventStream } from './plugin/response';
import { transformKiroStream } from './plugin/streaming';
import { fetchUsageLimits, calculateRecoveryTime } from './plugin/usage';
import { updateAccountQuota } from './plugin/quota';
import { authorizeKiroIDC } from './kiro/oauth-idc';
import { startIDCAuthServer } from './plugin/server';
import { KiroTokenRefreshError } from './plugin/errors';
import type { ManagedAccount, KiroAuthDetails } from './plugin/types';
import { KIRO_CONSTANTS } from './constants';

const KIRO_PROVIDER_ID = 'kiro';
const KIRO_API_PATTERN = /^(https?:\/\/)?q\.[a-z0-9-]+\.amazonaws\.com/;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function isNetworkError(error: unknown): boolean {
  if (error instanceof Error) {
    const message = error.message.toLowerCase();
    return message.includes('econnreset') ||
           message.includes('etimedout') ||
           message.includes('enotfound') ||
           message.includes('network') ||
           message.includes('fetch failed');
  }
  return false;
}

function extractModelFromUrl(url: string): string | null {
  const match = url.match(/models\/([^/:]+)/);
  return match?.[1] || null;
}

export const createKiroPlugin = (providerId: string) => async (
  { client, directory }: any
): Promise<any> => {
  const config = loadConfig(directory);

  const sessionRecovery = createSessionRecoveryHook(
    config.session_recovery,
    config.auto_resume
  );

  return {
    event: async (event: any) => {
      if (event.type === 'session.error') {
        await sessionRecovery.handleSessionError(event.error, event.sessionId);
      }
    },
    auth: {
      provider: providerId,
      loader: async (getAuth: any, provider: any) => {
        const auth = await getAuth();

        const accountManager = await AccountManager.loadFromDisk(
          config.account_selection_strategy
        );

        const refreshQueue = createProactiveRefreshQueue({
          enabled: config.proactive_token_refresh,
          checkIntervalSeconds: config.token_refresh_interval_seconds,
          bufferSeconds: config.token_refresh_buffer_seconds,
        });
        refreshQueue.setAccountManager(accountManager);
        refreshQueue.start();

        return {
          apiKey: '',
          baseURL: KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace('{{region}}', config.default_region || 'us-east-1'),
          async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

            if (!KIRO_API_PATTERN.test(url)) {
              if (config.debug) {
                console.debug('[kiro-auth] URL does not match pattern, passing through:', url);
              }
              return fetch(input, init);
            }

            const body = init?.body ? JSON.parse(init.body as string) : {};
            const model = extractModelFromUrl(url) || body.model || 'claude-opus-4-5';
            
            const isThinkingModel = model.endsWith('-thinking');
            const providerOptions = body.providerOptions || {};
            const thinkingConfig = providerOptions.thinkingConfig;
            const thinkingEnabled = isThinkingModel || !!thinkingConfig;
            const thinkingBudget = thinkingConfig?.thinkingBudget || config.thinking_budget_tokens;

            let retryCount = 0;
            const maxRetries = config.rate_limit_max_retries;

            while (retryCount <= maxRetries) {
              const account = accountManager.getCurrentOrNext();
              if (!account) {
                throw new Error('No available Kiro accounts');
              }

              const authDetails = accountManager.toAuthDetails(account);

              if (accessTokenExpired(authDetails)) {
                try {
                  const refreshed = await refreshAccessToken(authDetails);
                  accountManager.updateFromAuth(account, refreshed);
                  await accountManager.saveToDisk();
                } catch (error) {
                  if (error instanceof KiroTokenRefreshError && error.code === 'invalid_grant') {
                    accountManager.removeAccount(account);
                    await accountManager.saveToDisk();
                    continue;
                  }
                  throw error;
                }
              }

              const prepared = transformToCodeWhisperer(
                url,
                init?.body as string,
                model,
                authDetails,
                thinkingEnabled,
                thinkingBudget
              );

              try {
                const response = await fetch(prepared.url, prepared.init);

                if (!response.ok) {
                  const status = response.status;

                  if (status === 401 && retryCount === 0) {
                    const refreshed = await refreshAccessToken(authDetails);
                    accountManager.updateFromAuth(account, refreshed);
                    await accountManager.saveToDisk();
                    retryCount++;
                    continue;
                  }

                  if (status === 402) {
                    const recoveryTime = calculateRecoveryTime();
                    accountManager.markUnhealthy(account, 'Quota exhausted', recoveryTime);
                    await accountManager.saveToDisk();
                    retryCount++;
                    continue;
                  }

                  if (status === 403) {
                    accountManager.markUnhealthy(account, 'Forbidden');
                    await accountManager.saveToDisk();
                    retryCount++;
                    continue;
                  }

                  if (status === 429) {
                    const retryAfter = parseInt(response.headers.get('retry-after') || '60') * 1000;
                    accountManager.markRateLimited(account, retryAfter);
                    await accountManager.saveToDisk();
                    await sleep(config.rate_limit_retry_delay_ms);
                    retryCount++;
                    continue;
                  }

                  throw new Error(`Kiro API error: ${status}`);
                }

                if (config.usage_tracking_enabled) {
                  try {
                    const usage = await fetchUsageLimits(authDetails);
                    updateAccountQuota(account, usage);
                    await accountManager.saveToDisk();
                  } catch (error) {
                    if (config.debug) {
                      console.error('Failed to fetch usage:', error);
                    }
                  }
                }

                if (prepared.streaming) {
                  const stream = transformKiroStream(response, model, prepared.conversationId);
                  return new Response(
                    new ReadableStream({
                      async start(controller) {
                        try {
                          for await (const event of stream) {
                            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
                          }
                          controller.close();
                        } catch (error) {
                          controller.error(error);
                        }
                      }
                    }),
                    {
                      headers: {
                        'Content-Type': 'text/event-stream',
                        'Cache-Control': 'no-cache',
                        'Connection': 'keep-alive',
                      }
                    }
                  );
                } else {
                  const text = await response.text();
                  const parsed = parseEventStream(text);

                  const openaiResponse: any = {
                    id: prepared.conversationId,
                    object: 'chat.completion',
                    created: Math.floor(Date.now() / 1000),
                    model: model,
                    choices: [
                      {
                        index: 0,
                        message: {
                          role: 'assistant',
                          content: parsed.content,
                        },
                        finish_reason: parsed.stopReason === 'tool_use' ? 'tool_calls' : 'stop',
                      }
                    ],
                    usage: {
                      prompt_tokens: parsed.inputTokens || 0,
                      completion_tokens: parsed.outputTokens || 0,
                      total_tokens: (parsed.inputTokens || 0) + (parsed.outputTokens || 0),
                    },
                  };

                  if (parsed.toolCalls.length > 0) {
                    openaiResponse.choices[0].message.tool_calls = parsed.toolCalls.map((tc, index) => ({
                      id: tc.toolUseId,
                      type: 'function',
                      function: {
                        name: tc.name,
                        arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input),
                      },
                    }));
                  }

                  return new Response(JSON.stringify(openaiResponse), {
                    headers: { 'Content-Type': 'application/json' }
                  });
                }
              } catch (error) {
                if (isNetworkError(error) && retryCount < maxRetries) {
                  await sleep(config.rate_limit_retry_delay_ms * Math.pow(2, retryCount));
                  retryCount++;
                  continue;
                }
                throw error;
              }
            }

            throw new Error('Max retries exceeded');
          }
        };
      },
      methods: [
        {
          id: 'idc',
          label: 'AWS Builder ID (IDC)',
          type: 'oauth',
          authorize: async () => {
            return new Promise(async (resolve) => {
              const region = config.default_region;
              
              const authData = await authorizeKiroIDC(region);
              
              const { url, waitForAuth } = await startIDCAuthServer(authData);
              
              resolve({
                url,
                instructions: 'Opening browser for AWS Builder ID authentication...',
                method: 'auto',
                callback: async () => {
                  try {
                    const result = await waitForAuth();
                    
                    const accountManager = await AccountManager.loadFromDisk(
                      config.account_selection_strategy
                    );
                    
                    const account: ManagedAccount = {
                      id: generateAccountId(),
                      email: result.email,
                      authMethod: 'idc',
                      region,
                      clientId: result.clientId,
                      clientSecret: result.clientSecret,
                      refreshToken: result.refreshToken,
                      accessToken: result.accessToken,
                      expiresAt: result.expiresAt,
                      rateLimitResetTime: 0,
                      isHealthy: true,
                    };
                    
                    accountManager.addAccount(account);
                    await accountManager.saveToDisk();
                    
                    return { type: 'success', key: result.accessToken };
                  } catch (error) {
                    return { type: 'failed' };
                  }
                }
              });
            });
          }
        }
      ]
    }
  };
};

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID);
