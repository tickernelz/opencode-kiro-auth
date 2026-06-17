import { KIRO_CONSTANTS } from './constants.js'
import { AuthHandler } from './core/auth/auth-handler.js'
import { RequestHandler } from './core/request/request-handler.js'
import { AccountCache } from './infrastructure/database/account-cache.js'
import { AccountRepository } from './infrastructure/database/account-repository.js'
import { AccountManager } from './plugin/accounts.js'
import { bootstrapAuthIfNeeded } from './plugin/auth-bootstrap.js'
import { loadConfig } from './plugin/config/index.js'
import { imageCache } from './plugin/image-cache.js'
import * as logger from './plugin/logger.js'
import { clearSdkClientCache } from './plugin/sdk-client.js'
import { kiroDb } from './plugin/storage/sqlite.js'

type ToastFunction = (message: string, variant: string) => void

// `kiro-auth` is the recommended provider id. OpenCode is expected to ship a
// built-in `kiro` provider, which would clash with our default — so new installs
// use `kiro-auth`. We still register `kiro` as a back-compat alias so existing
// installs configured against `kiro` keep working.
const KIRO_PROVIDER_ID = 'kiro-auth'
const KIRO_LEGACY_PROVIDER_ID = 'kiro'

// OpenCode's config-provider path derives capabilities.input.image/pdf from
// model.modalities (array), not from capabilities.input directly. Both must be
// set or image/pdf attachments are silently replaced with error text.

const CLAUDE_CAPS_BASE = {
  temperature: false,
  reasoning: false,
  attachment: true,
  toolcall: true,
  interleaved: false,
  input: { text: true, image: true, pdf: true, audio: false, video: false },
  output: { text: true, image: false, pdf: false, audio: false, video: false }
}

const CLAUDE_MODALITIES = {
  modalities: {
    input: ['text', 'image', 'pdf'],
    output: ['text']
  }
}

const CLAUDE_CAPS_THINKING = {
  ...CLAUDE_CAPS_BASE,
  reasoning: true
}

const OPEN_WEIGHT_CAPS = {
  temperature: true,
  reasoning: false,
  attachment: false,
  toolcall: true,
  interleaved: false,
  input: { text: true, image: false, pdf: false, audio: false, video: false },
  output: { text: true, image: false, pdf: false, audio: false, video: false }
}

const OPEN_WEIGHT_MODALITIES = {
  modalities: {
    input: ['text'],
    output: ['text']
  }
}

// Thinking variants map to providerOptions["kiro-auth"].reasoningEffort,
// which request-handler translates to adaptive thinking tags in the system prompt.
const THINKING_VARIANTS = {
  low: { reasoningEffort: 'low' },
  medium: { reasoningEffort: 'medium' },
  high: { reasoningEffort: 'high' }
}

// ─── Model definitions ──────────────────────────────────────────────────────
const DEFAULT_MODELS: Record<string, any> = {
  auto: {
    name: 'Auto (1.0x)',
    limit: { context: 200000, output: 64000 },
    capabilities: CLAUDE_CAPS_THINKING,
    ...CLAUDE_MODALITIES,
    variants: THINKING_VARIANTS
  },
  // Claude Sonnet
  'claude-sonnet-4': {
    name: 'Claude Sonnet 4.0 (1.3x)',
    limit: { context: 200000, output: 64000 },
    capabilities: CLAUDE_CAPS_THINKING,
    ...CLAUDE_MODALITIES,
    variants: THINKING_VARIANTS
  },
  'claude-sonnet-4-5': {
    name: 'Claude Sonnet 4.5 (1.3x)',
    limit: { context: 200000, output: 64000 },
    capabilities: CLAUDE_CAPS_THINKING,
    ...CLAUDE_MODALITIES,
    variants: THINKING_VARIANTS
  },
  'claude-sonnet-4-6': {
    name: 'Claude Sonnet 4.6 (1.3x)',
    limit: { context: 1000000, output: 64000 },
    capabilities: CLAUDE_CAPS_THINKING,
    ...CLAUDE_MODALITIES,
    variants: THINKING_VARIANTS
  },
  // Claude Haiku (supports thinking but no PDF)
  'claude-haiku-4-5': {
    name: 'Claude Haiku 4.5 (0.4x)',
    limit: { context: 200000, output: 64000 },
    capabilities: {
      ...CLAUDE_CAPS_THINKING,
      input: { text: true, image: true, pdf: false, audio: false, video: false }
    },
    modalities: { input: ['text', 'image'], output: ['text'] },
    variants: THINKING_VARIANTS
  },
  // Claude Opus
  'claude-opus-4-5': {
    name: 'Claude Opus 4.5 (2.2x)',
    limit: { context: 200000, output: 64000 },
    capabilities: CLAUDE_CAPS_THINKING,
    ...CLAUDE_MODALITIES,
    variants: THINKING_VARIANTS
  },
  'claude-opus-4-6': {
    name: 'Claude Opus 4.6 (2.2x)',
    limit: { context: 1000000, output: 64000 },
    capabilities: CLAUDE_CAPS_THINKING,
    ...CLAUDE_MODALITIES,
    variants: THINKING_VARIANTS
  },
  'claude-opus-4-7': {
    name: 'Claude Opus 4.7 (2.2x)',
    limit: { context: 1000000, output: 64000 },
    capabilities: CLAUDE_CAPS_THINKING,
    ...CLAUDE_MODALITIES,
    variants: THINKING_VARIANTS
  },
  'claude-opus-4-8': {
    name: 'Claude Opus 4.8 (2.2x)',
    limit: { context: 1000000, output: 64000 },
    capabilities: CLAUDE_CAPS_THINKING,
    ...CLAUDE_MODALITIES,
    variants: THINKING_VARIANTS
  },
  // Open weight models — only available on runtime.kiro.dev (Pro accounts)
  'deepseek-3.2': {
    name: 'DeepSeek 3.2 (0.25x)',
    limit: { context: 128000, output: 64000 },
    capabilities: OPEN_WEIGHT_CAPS,
    ...OPEN_WEIGHT_MODALITIES
  },
  'glm-5': {
    name: 'GLM-5 (0.5x)',
    limit: { context: 200000, output: 64000 },
    capabilities: OPEN_WEIGHT_CAPS,
    ...OPEN_WEIGHT_MODALITIES
  },
  'minimax-m2.5': {
    name: 'MiniMax M2.5 (0.25x)',
    limit: { context: 200000, output: 64000 },
    capabilities: OPEN_WEIGHT_CAPS,
    ...OPEN_WEIGHT_MODALITIES
  },
  'minimax-m2.1': {
    name: 'MiniMax M2.1 (0.15x)',
    limit: { context: 200000, output: 64000 },
    capabilities: OPEN_WEIGHT_CAPS,
    ...OPEN_WEIGHT_MODALITIES
  },
  'qwen3-coder-next': {
    name: 'Qwen3 Coder Next (0.05x)',
    limit: { context: 256000, output: 64000 },
    capabilities: OPEN_WEIGHT_CAPS,
    ...OPEN_WEIGHT_MODALITIES
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

    // Always use the standard q.amazonaws.com base URL here — the custom fetch
    // internally routes Pro accounts to runtime.kiro.dev based on profileArn.
    const baseURL = KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
      '{{region}}',
      config.default_region || 'us-east-1'
    )

    // One fetch instance serves both provider ids — OpenCode binds auth.loader
    // to a single id, so we attach via provider.options in the config hook.
    const kiroFetch = (input: any, init?: any) => requestHandler.handle(input, init, showToast)

    const registerProvider = (input: any, providerId: string) => {
      if (!input.provider[providerId]) input.provider[providerId] = {}
      const p = input.provider[providerId]
      p.npm = '@ai-sdk/openai-compatible'
      if (!p.api) p.api = baseURL
      p.options = { ...(p.options ?? {}), fetch: kiroFetch }
      if (!p.models) p.models = { ...DEFAULT_MODELS }
    }

    // No models on the legacy alias — keeps `kiro` invisible in the model
    // picker while still routing saved kiro/* sessions through our fetch.
    const registerLegacyAlias = (input: any, providerId: string) => {
      if (!input.provider[providerId]) input.provider[providerId] = {}
      const p = input.provider[providerId]
      p.npm = '@ai-sdk/openai-compatible'
      if (!p.api) p.api = baseURL
      p.options = { ...(p.options ?? {}), fetch: kiroFetch }
    }

    return {
      config: async (input: any) => {
        bootstrapAuthIfNeeded(id)
        if (!input.provider) input.provider = {}
        registerProvider(input, id)
        registerLegacyAlias(input, KIRO_LEGACY_PROVIDER_ID)
      },
      auth: {
        provider: id,
        loader: async (getAuth: any) => {
          await getAuth()
          await authHandler.initialize(showToast as any)
          return {
            apiKey: '',
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
                url: modelInfo.api?.url || baseURL
              }
            }
          }

          return normalized
        }
      },
      dispose: async () => {
        logger.debug('[DISPOSE] Kiro plugin shutting down')
        try {
          clearSdkClientCache()
        } catch {}
        try {
          imageCache.clear()
        } catch {}
        try {
          kiroDb.close()
        } catch {}
        logger.debug('[DISPOSE] Kiro plugin shutdown complete')
      }
    }
  }

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID)
