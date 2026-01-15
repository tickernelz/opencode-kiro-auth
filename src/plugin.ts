
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
import { authorizeKiroSocial, exchangeKiroSocial } from './kiro/oauth-social';
import { authorizeKiroIDC, exchangeKiroIDC } from './kiro/oauth-idc';
import { startCallbackServer } from './plugin/server';
import { promptAuthMethod, promptRegion, displayAuthUrl } from './plugin/cli';
import { KiroTokenRefreshError } from './plugin/errors';
import type { ManagedAccount, KiroAuthDetails } from './plugin/types';
import { KIRO_CONSTANTS } from './constants';

const KIRO_PROVIDER_ID = 'kiro';
const KIRO_API_PATTERN = /q\.(us-east-1|us-west-2)\.amazonaws\.com/;

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
          async fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

            if (!KIRO_API_PATTERN.test(url)) {
              return fetch(input, init);
            }

            const body = init?.body ? JSON.parse(init.body as string) : {};
            const model = extractModelFromUrl(url) || body.model || 'claude-opus-4-5';

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
                config.thinking_enabled
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

                  const claudeResponse: any = {
                    id: prepared.conversationId,
                    type: 'message',
                    role: 'assistant',
                    model: model,
                    content: [
                      { type: 'text', text: parsed.content }
                    ],
                    usage: {
                      input_tokens: parsed.inputTokens || 0,
                      output_tokens: parsed.outputTokens || 0,
                    },
                    stop_reason: parsed.stopReason || 'end_turn',
                  };

                  if (parsed.toolCalls.length > 0) {
                    claudeResponse.content.push(
                      ...parsed.toolCalls.map(tc => ({
                        type: 'tool_use',
                        id: tc.toolUseId,
                        name: tc.name,
                        input: typeof tc.input === 'string' ? JSON.parse(tc.input) : tc.input,
                      }))
                    );
                    claudeResponse.stop_reason = 'tool_use';
                  }

                  return new Response(JSON.stringify(claudeResponse), {
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
          id: 'social',
          name: 'Google OAuth (Social)',
          type: 'oauth',
          authorize: async () => {
            const region = await promptRegion();
            const { url: callbackUrl, waitForCallback } = await startCallbackServer();
            const auth = await authorizeKiroSocial(region);
            displayAuthUrl(auth.url);
            const { code, state } = await waitForCallback();
            const result = await exchangeKiroSocial(code, state);

            const accountManager = await AccountManager.loadFromDisk();

            const account: ManagedAccount = {
              id: generateAccountId(),
              email: result.email,
              authMethod: 'social',
              region: result.region,
              profileArn: result.profileArn,
              refreshToken: result.refreshToken,
              accessToken: result.accessToken,
              expiresAt: result.expiresAt,
              rateLimitResetTime: 0,
              isHealthy: true,
            };

            accountManager.addAccount(account);
            await accountManager.saveToDisk();

            return accountManager.toAuthDetails(account);
          }
        },
        {
          id: 'idc',
          name: 'AWS Builder ID (IDC)',
          type: 'oauth',
          authorize: async () => {
            const region = await promptRegion();
            const { url: callbackUrl, waitForCallback } = await startCallbackServer();
            const auth = await authorizeKiroIDC(region);
            displayAuthUrl(auth.url);
            const { code, state } = await waitForCallback();
            const result = await exchangeKiroIDC(code, state);

            const accountManager = await AccountManager.loadFromDisk();

            const account: ManagedAccount = {
              id: generateAccountId(),
              email: result.email,
              authMethod: 'idc',
              region: result.region,
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

            return accountManager.toAuthDetails(account);
          }
        }
      ]
    }
  };
};

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID);
