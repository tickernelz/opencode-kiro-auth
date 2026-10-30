import { tool } from '@opencode-ai/plugin'
import type { AccountManager } from './plugin/accounts.js'
import { bootstrapAuthIfNeeded } from './plugin/auth-bootstrap.js'
import type { KiroConfig } from './plugin/config/index.js'
import { buildModelRegistry } from './plugin/model-registry.js'
import {
  createKiroRuntime,
  isWebSearchAvailable,
  KIRO_PROVIDER_ID,
  runWebSearch,
  WEB_SEARCH_DESCRIPTION,
  WEB_SEARCH_QUERY_DESCRIPTION,
  WEB_SEARCH_TOOL_NAME,
  type ToastFunction
} from './runtime.js'

// Register Kiro's server-side web search as a custom tool, when enabled and the
// active account is Pro (has a profileArn). Returns an empty object otherwise so
// nothing is advertised to the model on free accounts.
function buildTools(config: KiroConfig, accountManager: AccountManager): Record<string, any> {
  if (!isWebSearchAvailable(config, accountManager)) return {}

  return {
    [WEB_SEARCH_TOOL_NAME]: tool({
      description: WEB_SEARCH_DESCRIPTION,
      args: {
        query: tool.schema.string().describe(WEB_SEARCH_QUERY_DESCRIPTION)
      },
      async execute(args: { query: string }) {
        return runWebSearch(accountManager, args.query)
      }
    })
  }
}

/** OpenCode V1 entrypoint: one function returning the V1 hook object. */
export const createKiroPlugin =
  (id: string) =>
  async ({ client, directory }: any) => {
    const { config, accountManager, authHandler, requestHandler, baseURL } =
      await createKiroRuntime(directory, client)

    const showToast: ToastFunction = (message, variant) => {
      client.tui.showToast({ body: { message, variant } }).catch(() => {})
    }

    return {
      config: async (input: any) => {
        // Ensure there's an auth entry so OpenCode calls the loader on startup.
        // This is a no-op if the entry already exists.
        bootstrapAuthIfNeeded(id)

        if (!input.provider) input.provider = {}
        if (!input.provider[id]) input.provider[id] = {}
        // Always set npm and api — these must be present regardless of whether
        // the user has already defined the provider in their opencode.json.
        input.provider[id].npm = '@ai-sdk/openai-compatible'
        // Set the base URL at the provider level. OpenCode reads provider.api as
        // model.api.url, which resolveSDK() uses to construct the endpoint URL.
        // Only set if not already overridden by the user.
        if (!input.provider[id].api) {
          input.provider[id].api = baseURL
        }
        if (!input.provider[id].models) {
          input.provider[id].models = buildModelRegistry()
        }
      },
      auth: {
        provider: id,
        loader: async (getAuth: any) => {
          await getAuth()
          await authHandler.initialize(showToast)

          return {
            apiKey: '',
            // Provide baseURL explicitly so the @ai-sdk/openai-compatible provider
            // always has a valid URL. The custom fetch below intercepts all Kiro
            // API calls, so this value is only used for URL construction.
            baseURL,
            fetch: (input: any, init?: any) => requestHandler.handle(input, init, showToast)
          }
        },
        methods: authHandler.getMethods()
      },
      provider: {
        id,
        models: async (provider: any) => {
          const models = provider?.models || {}
          const normalized: Record<string, any> = {}

          for (const [modelID, model] of Object.entries(models)) {
            const modelInfo = model as any
            normalized[modelID] = {
              ...modelInfo,
              api: {
                ...(modelInfo.api || {}),
                npm: '@ai-sdk/openai-compatible',
                // Ensure url is always set. modelInfo.api.url should already be
                // populated from the config hook's provider.api field, but we
                // set it explicitly as a fallback for any edge cases.
                url: modelInfo.api?.url || baseURL
              }
            }
          }

          return normalized
        }
      },
      tool: buildTools(config, accountManager)
    }
  }

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID)
