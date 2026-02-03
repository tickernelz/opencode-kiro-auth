import { KIRO_CONSTANTS } from './constants.js'
import { AuthHandler } from './core/auth/auth-handler.js'
import { RequestHandler } from './core/request/request-handler.js'
import { AccountCache } from './infrastructure/database/account-cache.js'
import { AccountRepository } from './infrastructure/database/account-repository.js'
import { AccountManager } from './plugin/accounts.js'
import { loadConfig } from './plugin/config/index.js'

type ToastFunction = (message: string, variant: string) => void

const KIRO_PROVIDER_ID = 'kiro'

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

    const requestHandler = new RequestHandler(accountManager, config, repository)

    return {
      auth: {
        provider: id,
        loader: async (getAuth: any) => {
          const stored = (await getAuth()) || {}
          await authHandler.initialize()

          return {
            // OpenCode uses apiKey presence to determine "connected".
            // We don't require an OpenAI-style key for requests, but returning the stored
            // key (set by the auth method callback) makes the UI reflect connection state.
            apiKey: stored.apiKey || stored.key || '',
            baseURL: KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
              '{{region}}',
              config.default_region || 'us-east-1'
            ),
            fetch: (input: any, init?: any) => requestHandler.handle(input, init, showToast)
          }
        },
        methods: authHandler.getMethods()
      }
    }
  }

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID)
