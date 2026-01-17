import { loadConfig } from "./plugin/config";
import { exec } from "node:child_process";
import { AccountManager, generateAccountId } from "./plugin/accounts";
import { accessTokenExpired, encodeRefreshToken } from "./kiro/auth";
import { refreshAccessToken } from "./plugin/token";
import { transformToCodeWhisperer } from "./plugin/request";
import { parseEventStream } from "./plugin/response";
import { transformKiroStream } from "./plugin/streaming";
import { fetchUsageLimits, updateAccountQuota } from "./plugin/usage";
import { authorizeKiroIDC } from "./kiro/oauth-idc";
import { startIDCAuthServer } from "./plugin/server";
import { KiroTokenRefreshError } from "./plugin/errors";
import type { ManagedAccount } from "./plugin/types";
import { KIRO_CONSTANTS } from "./constants";
import * as logger from "./plugin/logger";

const KIRO_PROVIDER_ID = "kiro";
const KIRO_API_PATTERN = /^(https?:\/\/)?q\.[a-z0-9-]+\.amazonaws\.com/;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const isNetworkError = (e: any) =>
  e instanceof Error &&
  /econnreset|etimedout|enotfound|network|fetch failed/i.test(e.message);
const extractModel = (url: string) =>
  url.match(/models\/([^/:]+)/)?.[1] || null;
const formatUsageMessage = (
  usedCount: number,
  limitCount: number,
  email: string,
): string => {
  if (limitCount > 0) {
    const percentage = Math.round((usedCount / limitCount) * 100);
    return `Usage (${email}): ${usedCount}/${limitCount} (${percentage}%)`;
  }
  return `Usage (${email}): ${usedCount}`;
};

const openBrowser = (url: string) => {
  const escapedUrl = url.replace(/"/g, '\\"');
  const platform = process.platform;
  const command =
    platform === "win32"
      ? `cmd /c start "" "${escapedUrl}"`
      : platform === "darwin"
        ? `open "${escapedUrl}"`
        : `xdg-open "${escapedUrl}"`;

  exec(command, (error) => {
    if (error)
      logger.warn(
        `Failed to open browser automatically: ${error.message}`,
        error,
      );
  });
};

export const createKiroPlugin =
  (id: string) =>
  async ({ client, directory }: any) => {
    const config = loadConfig(directory);
    const showToast = (
      message: string,
      variant: "info" | "warning" | "success" | "error",
    ) => {
      client.tui.showToast({ body: { message, variant } }).catch(() => {});
    };

    return {
      auth: {
        provider: id,
        loader: async (getAuth: any) => {
          await getAuth();
          const am = await AccountManager.loadFromDisk(
            config.account_selection_strategy,
          );
          return {
            apiKey: "",
            baseURL: KIRO_CONSTANTS.BASE_URL.replace(
              "/generateAssistantResponse",
              "",
            ).replace("{{region}}", config.default_region || "us-east-1"),
            async fetch(input: any, init?: any): Promise<Response> {
              const url = typeof input === "string" ? input : input.url;
              if (!KIRO_API_PATTERN.test(url)) return fetch(input, init);

              const body = init?.body ? JSON.parse(init.body) : {};
              const model =
                extractModel(url) || body.model || "claude-opus-4-5";
              const think =
                model.endsWith("-thinking") ||
                !!body.providerOptions?.thinkingConfig;
              const budget =
                body.providerOptions?.thinkingConfig?.thinkingBudget || 20000;

              let retry = 0;
              let iterations = 0;
              const startTime = Date.now();
              const maxIterations = config.max_request_iterations;
              const timeoutMs = config.request_timeout_ms;

              while (true) {
                iterations++;
                const elapsed = Date.now() - startTime;

                if (iterations > maxIterations) {
                  throw new Error(
                    `Request exceeded max iterations (${maxIterations}). All accounts may be unhealthy or rate-limited.`,
                  );
                }

                if (elapsed > timeoutMs) {
                  throw new Error(
                    `Request timeout after ${Math.ceil(elapsed / 1000)}s. Max timeout: ${Math.ceil(timeoutMs / 1000)}s.`,
                  );
                }

                const count = am.getAccountCount();
                if (count === 0) throw new Error("No accounts. Login first.");
                const acc = am.getCurrentOrNext();
                if (!acc) {
                  const w = am.getMinWaitTime() || 60000;
                  showToast(
                    `All accounts rate-limited. Waiting ${Math.ceil(w / 1000)}s...`,
                    "warning",
                  );
                  await sleep(w);
                  continue;
                }

                if (count > 1 && am.shouldShowToast())
                  showToast(
                    `Using ${acc.realEmail || acc.email} (${am.getAccounts().indexOf(acc) + 1}/${count})`,
                    "info",
                  );

                if (
                  am.shouldShowUsageToast() &&
                  acc.usedCount !== undefined &&
                  acc.limitCount !== undefined
                ) {
                  const percentage =
                    acc.limitCount > 0
                      ? (acc.usedCount / acc.limitCount) * 100
                      : 0;
                  const variant = percentage >= 80 ? "warning" : "info";
                  showToast(
                    formatUsageMessage(
                      acc.usedCount,
                      acc.limitCount,
                      acc.realEmail || acc.email,
                    ),
                    variant,
                  );
                }

                let auth = am.toAuthDetails(acc);
                if (accessTokenExpired(auth, config.token_expiry_buffer_ms)) {
                  try {
                    logger.log(
                      `Refreshing token for ${acc.realEmail || acc.email}`,
                    );
                    auth = await refreshAccessToken(auth);
                    am.updateFromAuth(acc, auth);
                    await am.saveToDisk();
                  } catch (e: any) {
                    const msg =
                      e instanceof KiroTokenRefreshError
                        ? e.message
                        : String(e);
                    showToast(
                      `Refresh failed for ${acc.realEmail || acc.email}: ${msg}`,
                      "error",
                    );
                    if (
                      e instanceof KiroTokenRefreshError &&
                      e.code === "invalid_grant"
                    ) {
                      am.removeAccount(acc);
                      await am.saveToDisk();
                      continue;
                    }
                    throw e;
                  }
                }

                const prep = transformToCodeWhisperer(
                  url,
                  init?.body,
                  model,
                  auth,
                  think,
                  budget,
                );

                const apiTimestamp = config.enable_log_api_request
                  ? logger.getTimestamp()
                  : null;

                if (config.enable_log_api_request && apiTimestamp) {
                  let parsedBody: any = null;
                  if (prep.init.body && typeof prep.init.body === "string") {
                    try {
                      parsedBody = JSON.parse(prep.init.body);
                    } catch (e) {
                      parsedBody = prep.init.body;
                    }
                  }

                  logger.logApiRequest(
                    {
                      url: prep.url,
                      method: prep.init.method,
                      headers: prep.init.headers,
                      body: parsedBody,
                      conversationId: prep.conversationId,
                      model: prep.effectiveModel,
                    },
                    apiTimestamp,
                  );
                }

                try {
                  const res = await fetch(prep.url, prep.init);

                  if (config.enable_log_api_request && apiTimestamp) {
                    const responseHeaders: Record<string, string> = {};
                    res.headers.forEach((value, key) => {
                      responseHeaders[key] = value;
                    });

                    logger.logApiResponse(
                      {
                        status: res.status,
                        statusText: res.statusText,
                        headers: responseHeaders,
                        conversationId: prep.conversationId,
                        model: prep.effectiveModel,
                      },
                      apiTimestamp,
                    );
                  }

                  if (res.ok) {
                    if (config.usage_tracking_enabled) {
                      const syncUsage = async (attempt = 0): Promise<void> => {
                        try {
                          const u = await fetchUsageLimits(auth);
                          updateAccountQuota(acc, u, am);
                          await am.saveToDisk();
                        } catch (e: any) {
                          if (attempt < config.usage_sync_max_retries) {
                            const delay = 1000 * Math.pow(2, attempt);
                            await sleep(delay);
                            return syncUsage(attempt + 1);
                          }
                          logger.warn(
                            `Usage sync failed for ${acc.realEmail || acc.email} after ${attempt + 1} attempts: ${e.message}`,
                          );
                        }
                      };
                      syncUsage().catch(() => {});
                    }
                    if (prep.streaming) {
                      const s = transformKiroStream(
                        res,
                        model,
                        prep.conversationId,
                      );
                      return new Response(
                        new ReadableStream({
                          async start(c) {
                            try {
                              for await (const e of s)
                                c.enqueue(
                                  new TextEncoder().encode(
                                    `data: ${JSON.stringify(e)}\n\n`,
                                  ),
                                );
                              c.close();
                            } catch (err) {
                              c.error(err);
                            }
                          },
                        }),
                        { headers: { "Content-Type": "text/event-stream" } },
                      );
                    }
                    const text = await res.text();
                    const p = parseEventStream(text);
                    const oai: any = {
                      id: prep.conversationId,
                      object: "chat.completion",
                      created: Math.floor(Date.now() / 1000),
                      model,
                      choices: [
                        {
                          index: 0,
                          message: { role: "assistant", content: p.content },
                          finish_reason:
                            p.stopReason === "tool_use" ? "tool_calls" : "stop",
                        },
                      ],
                      usage: {
                        prompt_tokens: p.inputTokens || 0,
                        completion_tokens: p.outputTokens || 0,
                        total_tokens:
                          (p.inputTokens || 0) + (p.outputTokens || 0),
                      },
                    };
                    if (p.toolCalls.length > 0)
                      oai.choices[0].message.tool_calls = p.toolCalls.map(
                        (tc) => ({
                          id: tc.toolUseId,
                          type: "function",
                          function: {
                            name: tc.name,
                            arguments:
                              typeof tc.input === "string"
                                ? tc.input
                                : JSON.stringify(tc.input),
                          },
                        }),
                      );
                    return new Response(JSON.stringify(oai), {
                      headers: { "Content-Type": "application/json" },
                    });
                  }

                  if (
                    res.status === 401 &&
                    retry < config.rate_limit_max_retries
                  ) {
                    logger.warn(
                      `Unauthorized (401) on ${acc.realEmail || acc.email}, retrying...`,
                    );
                    retry++;
                    continue;
                  }
                  if (res.status === 429) {
                    const wait =
                      parseInt(res.headers.get("retry-after") || "60") * 1000;
                    am.markRateLimited(acc, wait);
                    await am.saveToDisk();
                    if (count > 1) {
                      showToast(
                        `Rate limited on ${acc.realEmail || acc.email}. Switching account...`,
                        "warning",
                      );
                      continue;
                    } else {
                      showToast(
                        `Rate limited. Retrying in ${Math.ceil(wait / 1000)}s...`,
                        "warning",
                      );
                      await sleep(wait);
                      continue;
                    }
                  }
                  if ((res.status === 402 || res.status === 403) && count > 1) {
                    showToast(
                      `${res.status === 402 ? "Quota exhausted" : "Forbidden"} on ${acc.realEmail || acc.email}. Switching...`,
                      "warning",
                    );
                    am.markUnhealthy(
                      acc,
                      res.status === 402 ? "Quota" : "Forbidden",
                    );
                    await am.saveToDisk();
                    continue;
                  }

                  if (config.enable_log_api_request && apiTimestamp) {
                    const responseHeaders: Record<string, string> = {};
                    res.headers.forEach((value, key) => {
                      responseHeaders[key] = value;
                    });

                    logger.logApiResponse(
                      {
                        status: res.status,
                        statusText: res.statusText,
                        headers: responseHeaders,
                        error: `Kiro Error: ${res.status}`,
                        conversationId: prep.conversationId,
                        model: prep.effectiveModel,
                      },
                      apiTimestamp,
                    );
                  }

                  throw new Error(`Kiro Error: ${res.status}`);
                } catch (e) {
                  if (config.enable_log_api_request && apiTimestamp) {
                    logger.logApiResponse(
                      {
                        error: String(e),
                        conversationId: prep.conversationId,
                        model: prep.effectiveModel,
                      },
                      apiTimestamp,
                    );
                  }

                  if (
                    isNetworkError(e) &&
                    retry < config.rate_limit_max_retries
                  ) {
                    const delay = 5000 * Math.pow(2, retry);
                    showToast(
                      `Network error. Retrying in ${Math.ceil(delay / 1000)}s...`,
                      "warning",
                    );
                    await sleep(delay);
                    retry++;
                    continue;
                  }
                  throw e;
                }
              }
            },
          };
        },
        methods: [
          {
            id: "idc",
            label: "AWS Builder ID (IDC)",
            type: "oauth",
            authorize: async () =>
              new Promise(async (resolve) => {
                const region = config.default_region;
                try {
                  const authData = await authorizeKiroIDC(region);
                  const { url, waitForAuth } = await startIDCAuthServer(
                    authData,
                    config.auth_server_port_start,
                    config.auth_server_port_range,
                  );
                  openBrowser(url);
                  resolve({
                    url,
                    instructions: `Open this URL to continue: ${url}`,
                    method: "auto",
                    callback: async () => {
                      try {
                        const res = await waitForAuth();
                        const am = await AccountManager.loadFromDisk(
                          config.account_selection_strategy,
                        );
                        const acc: ManagedAccount = {
                          id: generateAccountId(),
                          email: res.email,
                          authMethod: "idc",
                          region,
                          clientId: res.clientId,
                          clientSecret: res.clientSecret,
                          refreshToken: res.refreshToken,
                          accessToken: res.accessToken,
                          expiresAt: res.expiresAt,
                          rateLimitResetTime: 0,
                          isHealthy: true,
                        };
                        try {
                          const u = await fetchUsageLimits({
                            refresh: encodeRefreshToken({
                              refreshToken: res.refreshToken,
                              clientId: res.clientId,
                              clientSecret: res.clientSecret,
                              authMethod: "idc",
                            }),
                            access: res.accessToken,
                            expires: res.expiresAt,
                            authMethod: "idc",
                            region,
                            clientId: res.clientId,
                            clientSecret: res.clientSecret,
                            email: res.email,
                          });
                          am.updateUsage(acc.id, {
                            usedCount: u.usedCount,
                            limitCount: u.limitCount,
                            realEmail: u.email,
                          });
                        } catch (e: any) {
                          logger.warn(
                            `Initial usage fetch failed: ${e.message}`,
                            e,
                          );
                        }
                        am.addAccount(acc);
                        await am.saveToDisk();
                        showToast(
                          `Successfully logged in as ${res.email}`,
                          "success",
                        );
                        return { type: "success", key: res.accessToken };
                      } catch (e: any) {
                        logger.error(`Login failed: ${e.message}`, e);
                        showToast(`Login failed: ${e.message}`, "error");
                        return { type: "failed" };
                      }
                    },
                  });
                } catch (e: any) {
                  logger.error(`Authorization failed: ${e.message}`, e);
                  showToast(`Authorization failed: ${e.message}`, "error");
                  resolve({
                    url: "",
                    instructions: "Authorization failed",
                    method: "auto",
                    callback: async () => ({ type: "failed" }),
                  });
                }
              }),
          },
        ],
      },
    };
  };

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID);
