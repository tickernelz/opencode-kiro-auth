import {
  DEFAULT_PROVIDER_MODELS,
  KIRO_CONSTANTS,
  KIRO_LEGACY_PROVIDER_ID,
  KIRO_PROVIDER_ID
} from './constants.js'
import { AuthHandler } from './core/auth/auth-handler.js'
import { RequestHandler } from './core/request/request-handler.js'
import { AccountCache } from './infrastructure/database/account-cache.js'
import { AccountRepository } from './infrastructure/database/account-repository.js'
import { AccountManager } from './plugin/accounts.js'
import { loadConfig } from './plugin/config/index.js'
import { ensureOpenCodeAuthPlaceholder } from './plugin/opencode-auth.js'

type ToastFunction = (message: string, variant: string) => void

function mergeProviderModels(existing: Record<string, any> | undefined): Record<string, any> {
  const merged: Record<string, any> = { ...(existing || {}) }

  for (const [modelID, defaults] of Object.entries(DEFAULT_PROVIDER_MODELS)) {
    const current = merged[modelID] || {}
    merged[modelID] = {
      ...current,
      ...defaults
    }
  }

  return merged
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

    const requestHandler = new RequestHandler(accountManager, config, repository, client)

    await authHandler.initialize(showToast as any)
    if (accountManager.getAccountCount() > 0) {
      ensureOpenCodeAuthPlaceholder(id)
    }

    return {
      config: async (input: any) => {
        if (!input.provider) input.provider = {}
        if (
          id === KIRO_PROVIDER_ID &&
          input.provider[KIRO_LEGACY_PROVIDER_ID] &&
          !input.provider[id]
        ) {
          input.provider[id] = input.provider[KIRO_LEGACY_PROVIDER_ID]
        }
        if (!input.provider[id]) input.provider[id] = {}
        if (!input.provider[id].name) input.provider[id].name = 'Kiro'
        input.provider[id].npm = '@ai-sdk/openai-compatible'
        input.provider[id].models = mergeProviderModels(input.provider[id].models)
      },
      auth: {
        provider: id,
        loader: async (getAuth: any) => {
          await getAuth().catch(() => undefined)
          await authHandler.initialize(showToast as any)

          return {
            apiKey: '',
            baseURL: KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
              '{{region}}',
              config.default_region || 'us-east-1'
            ),
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
                npm: '@ai-sdk/openai-compatible'
              }
            }
          }

          return normalized
        }
      }
    }
  }

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID)
