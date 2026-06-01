import { KIRO_CONSTANTS } from './constants.js'
import { AuthHandler } from './core/auth/auth-handler.js'
import { RequestHandler } from './core/request/request-handler.js'
import { AccountCache } from './infrastructure/database/account-cache.js'
import { AccountRepository } from './infrastructure/database/account-repository.js'
import { AccountManager } from './plugin/accounts.js'
import { bootstrapAuthIfNeeded } from './plugin/auth-bootstrap.js'
import { loadConfig } from './plugin/config/index.js'

type ToastFunction = (message: string, variant: string) => void

// `kiro-auth` is the recommended provider id. OpenCode is expected to ship a
// built-in `kiro` provider, which would clash with our default — so new installs
// use `kiro-auth`. We still register `kiro` as a back-compat alias so existing
// installs configured against `kiro` keep working.
const KIRO_PROVIDER_ID = 'kiro-auth'
const KIRO_LEGACY_PROVIDER_ID = 'kiro'

const DEFAULT_MODELS: Record<string, any> = {
  auto: {
    name: 'Auto (1.0x)',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
  },
  // Claude Sonnet
  'claude-sonnet-4': {
    name: 'Claude Sonnet 4.0 (1.3x)',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
  },
  'claude-sonnet-4-5': {
    name: 'Claude Sonnet 4.5 (1.3x)',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
  },
  'claude-sonnet-4-6': {
    name: 'Claude Sonnet 4.6 (1.3x)',
    limit: { context: 1000000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
  },
  // Claude Haiku
  'claude-haiku-4-5': {
    name: 'Claude Haiku 4.5 (0.4x)',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text', 'image'], output: ['text'] }
  },
  // Claude Opus
  'claude-opus-4-5': {
    name: 'Claude Opus 4.5 (2.2x)',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
  },
  'claude-opus-4-6': {
    name: 'Claude Opus 4.6 (2.2x)',
    limit: { context: 1000000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
  },
  'claude-opus-4-7': {
    name: 'Claude Opus 4.7 (2.2x)',
    limit: { context: 1000000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
  },
  'claude-opus-4-8': {
    name: 'Claude Opus 4.8 (2.2x)',
    limit: { context: 1000000, output: 64000 },
    modalities: { input: ['text', 'image', 'pdf'], output: ['text'] }
  },
  // Open weight models
  'deepseek-3.2': {
    name: 'DeepSeek 3.2 (0.25x)',
    limit: { context: 128000, output: 64000 },
    modalities: { input: ['text'], output: ['text'] }
  },
  'glm-5': {
    name: 'GLM-5 (0.5x)',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text'], output: ['text'] }
  },
  'minimax-m2.5': {
    name: 'MiniMax M2.5 (0.25x)',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text'], output: ['text'] }
  },
  'minimax-m2.1': {
    name: 'MiniMax M2.1 (0.15x)',
    limit: { context: 200000, output: 64000 },
    modalities: { input: ['text'], output: ['text'] }
  },
  'qwen3-coder-next': {
    name: 'Qwen3 Coder Next (0.05x)',
    limit: { context: 256000, output: 64000 },
    modalities: { input: ['text'], output: ['text'] }
  }
}

export const createKiroPlugin =
  (id: string) =>
  async ({ client, directory }: any) => {
    const config = loadConfig(directory)

    const showToast: ToastFunction = (message: string, variant: string) => {
      client.tui.showToast({ body: { message, variant } }).catch(() => {})
    }

    const cache = new AccountCache(60000)
    const repository = new AccountRepository(cache)

    const authHandler = new AuthHandler(config, repository)
    const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
    authHandler.setAccountManager(accountManager)

    const requestHandler = new RequestHandler(accountManager, config, repository, client, directory)

    // Compute the base URL once so both the config hook and auth loader use the same value
    const baseURL = KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
      '{{region}}',
      config.default_region || 'us-east-1'
    )

    // The custom fetch self-identifies Kiro requests by URL, so a single instance
    // serves any provider id. OpenCode binds auth.loader to one id only, so we
    // attach this fetch via provider.options in the config hook — resolveSDK reads
    // options.fetch per provider, which is how both `kiro-auth` and `kiro` route
    // through us.
    const kiroFetch = (input: any, init?: any) => requestHandler.handle(input, init, showToast)

    const registerProvider = (input: any, providerId: string) => {
      if (!input.provider[providerId]) input.provider[providerId] = {}
      const p = input.provider[providerId]
      p.npm = '@ai-sdk/openai-compatible'
      // OpenCode resolves model.api.url / model.api.npm from these provider-level
      // fields, so the models don't need per-model api entries.
      if (!p.api) p.api = baseURL
      p.options = { ...(p.options ?? {}), fetch: kiroFetch }
      if (!p.models) p.models = { ...DEFAULT_MODELS }
    }

    return {
      config: async (input: any) => {
        // Ensure there's an auth entry so OpenCode calls the loader on startup.
        // This is a no-op if the entry already exists.
        bootstrapAuthIfNeeded(id)

        if (!input.provider) input.provider = {}
        // Primary id (kiro-auth) plus the back-compat alias (kiro), both sharing
        // the same custom fetch.
        registerProvider(input, id)
        registerProvider(input, KIRO_LEGACY_PROVIDER_ID)
      },
      auth: {
        provider: id,
        loader: async (getAuth: any) => {
          await getAuth()
          await authHandler.initialize(showToast as any)

          return {
            apiKey: '',
            // Provide baseURL explicitly so the @ai-sdk/openai-compatible provider
            // always has a valid URL. The custom fetch intercepts all Kiro API
            // calls, so this value is only used for URL construction.
            baseURL,
            fetch: kiroFetch
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
      }
    }
  }

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID)
