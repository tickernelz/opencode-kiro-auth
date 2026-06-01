import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import type { KiroConfig } from '../../plugin/config'
import { isPermanentError } from '../../plugin/health'
import * as logger from '../../plugin/logger'
import { transformToSdkRequest } from '../../plugin/request'
import { createSdkClient } from '../../plugin/sdk-client'
import { kiroDb } from '../../plugin/storage/sqlite'
import { syncFromKiroCli } from '../../plugin/sync/kiro-cli'
import type { KiroAuthDetails, ManagedAccount, SdkPreparedRequest } from '../../plugin/types'
import { AccountSelector } from '../account/account-selector'
import { UsageTracker } from '../account/usage-tracker'
import { TokenRefresher } from '../auth/token-refresher'
import { ErrorHandler } from './error-handler'
import { ResponseHandler } from './response-handler'
import { RetryStrategy } from './retry-strategy'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

const KIRO_API_PATTERN = /^(https?:\/\/)?q\.[a-z0-9-]+\.amazonaws\.com/
const REAUTH_FAILURE_COOLDOWN_MS = 60000
const REAUTH_TIMEOUT_MS = 90_000

export class RequestHandler {
  private accountSelector: AccountSelector
  private tokenRefresher: TokenRefresher
  private errorHandler: ErrorHandler
  private responseHandler: ResponseHandler
  private usageTracker: UsageTracker
  private retryStrategy: RetryStrategy
  private reauthInFlight: Promise<boolean> | null = null
  private lastFailedReauthAt = 0

  constructor(
    private accountManager: AccountManager,
    private config: KiroConfig,
    private repository: AccountRepository,
    private client?: any,
    private workspace = ''
  ) {
    this.accountSelector = new AccountSelector(accountManager, config, syncFromKiroCli, repository)
    this.tokenRefresher = new TokenRefresher(config, accountManager, syncFromKiroCli, repository)
    this.errorHandler = new ErrorHandler(config, accountManager, repository)
    this.responseHandler = new ResponseHandler()
    this.usageTracker = new UsageTracker(config, accountManager, repository)
    this.retryStrategy = new RetryStrategy(config)
  }

  async handle(input: any, init: any, showToast: ToastFunction): Promise<Response> {
    const url = typeof input === 'string' ? input : input.url

    if (!KIRO_API_PATTERN.test(url)) {
      return fetch(input, init)
    }

    return this.handleKiroRequest(url, init, showToast)
  }

  private async handleKiroRequest(
    url: string,
    init: any,
    showToast: ToastFunction
  ): Promise<Response> {
    const body = init?.body ? JSON.parse(init.body) : {}
    const model = this.extractModel(url) || body.model || 'claude-sonnet-4-5'
    const think = model.endsWith('-thinking') || !!body.providerOptions?.thinkingConfig
    const budget = body.providerOptions?.thinkingConfig?.thinkingBudget || 20000

    let retry = 0
    let consecutiveNullAccounts = 0
    let forceNewConversation = false
    const retryContext = this.retryStrategy.createContext()

    while (true) {
      const check = this.retryStrategy.shouldContinue(retryContext)
      if (!check.canContinue) {
        throw new Error(check.error)
      }

      if (this.allAccountsPermanentlyUnhealthy()) {
        const reauthed = await this.triggerReauth(showToast)
        if (!reauthed) {
          throw new Error('All accounts are permanently unhealthy. Please re-authenticate.')
        }
        continue
      }

      let acc = await this.accountSelector.selectHealthyAccount(showToast).catch(async (e) => {
        if (e instanceof Error && e.message.includes('reauth required')) {
          const reauthed = await this.triggerReauth(showToast)
          if (!reauthed)
            throw new Error('All accounts are unhealthy or rate-limited. Please re-authenticate.')
          return null
        }
        throw e
      })
      if (!acc) {
        consecutiveNullAccounts++
        const backoffDelay = Math.min(1000 * Math.pow(2, consecutiveNullAccounts - 1), 10000)
        await this.sleep(backoffDelay)
        continue
      }

      consecutiveNullAccounts = 0
      const auth = this.accountManager.toAuthDetails(acc)

      const tokenResult = await this.tokenRefresher.refreshIfNeeded(acc, auth, showToast)
      if (tokenResult.shouldContinue) {
        acc = tokenResult.account
        await this.sleep(500)
        continue
      }

      const sdkPrep = this.prepareSdkRequest(body, model, auth, think, budget, showToast)

      const histLen = (sdkPrep.conversationState as any).history?.length || 0
      const agentContId = (sdkPrep.conversationState as any).agentContinuationId || 'none'
      logger.debug(
        `[REQ] convId=${sdkPrep.conversationId} history=${histLen} agentCont=${agentContId} model=${model}`
      )

      const apiTimestamp = this.config.enable_log_api_request ? logger.getTimestamp() : null
      if (apiTimestamp) {
        this.logSdkRequest(sdkPrep, acc, apiTimestamp)
      }

      try {
        const client = createSdkClient(auth, sdkPrep.region)
        const command = new GenerateAssistantResponseCommand({
          conversationState: sdkPrep.conversationState as any,
          profileArn: sdkPrep.profileArn
        })

        const sdkResponse = await client.send(command)

        if (apiTimestamp) {
          this.logSdkResponse(sdkPrep, apiTimestamp)
        }

        this.handleSuccessfulRequest(acc)
        this.usageTracker.syncUsage(acc, auth)

        const result = await this.responseHandler.handleSdkSuccess(
          sdkResponse,
          model,
          sdkPrep.conversationId,
          sdkPrep.streaming,
          sdkPrep.toolNameMapper
        )
        logger.debug(`[REQ] done convId=${sdkPrep.conversationId}`)
        return result
      } catch (e: any) {
        logger.warn(
          `[REQ] error convId=${sdkPrep.conversationId}: ${e?.name || ''} ${e?.message?.slice(0, 200) || String(e).slice(0, 200)}`
        )
        const httpStatus = e?.$metadata?.httpStatusCode

        if (httpStatus) {
          if (apiTimestamp) {
            this.logSdkError(sdkPrep, e, acc, apiTimestamp)
          }

          const mockResponse = new Response(
            JSON.stringify({ message: e.message, __type: e.name }),
            {
              status: httpStatus,
              statusText: e.name || 'Error',
              headers: { 'Content-Type': 'application/json' }
            }
          )

          const errorResult = await this.errorHandler.handle(
            e,
            mockResponse,
            acc,
            { retry, excludedMs: retryContext.excludedMs },
            showToast
          )

          if (errorResult.shouldRetry) {
            if (errorResult.newContext) {
              retry = errorResult.newContext.retry
              const sleptMs = (errorResult.newContext.excludedMs ?? 0) - retryContext.excludedMs
              if (sleptMs > 0) this.retryStrategy.markSleep(retryContext, sleptMs)
            }
            if (errorResult.switchAccount) {
              continue
            }
            continue
          }

          if (httpStatus === 400 && e?.name === 'ValidationException' && !forceNewConversation) {
            const { workspace, fingerprint } = sdkPrep.conversationKey
            kiroDb.deleteConversationId(workspace, fingerprint)
            logger.warn(
              `[REQ] stale conversationId reset, retrying convId=${sdkPrep.conversationId}`
            )
            forceNewConversation = true
            continue
          }

          if (this.allAccountsPermanentlyUnhealthy()) {
            const reauthed = await this.triggerReauth(showToast)
            if (reauthed) continue
          }

          throw new Error(`Kiro Error: ${httpStatus}`)
        }

        const networkResult = await this.errorHandler.handleNetworkError(e, { retry }, showToast)

        if (networkResult.shouldRetry) {
          if (networkResult.newContext) {
            retry = networkResult.newContext.retry
          }
          continue
        }

        throw e
      }
    }
  }

  private extractModel(url: string): string | null {
    return url.match(/models\/([^/:]+)/)?.[1] || null
  }

  private prepareSdkRequest(
    body: any,
    model: string,
    auth: KiroAuthDetails,
    think: boolean,
    budget: number,
    showToast?: (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void
  ): SdkPreparedRequest {
    return transformToSdkRequest(body, model, auth, think, budget, showToast, this.workspace)
  }

  private handleSuccessfulRequest(acc: ManagedAccount): void {
    if (acc.failCount && acc.failCount > 0) {
      if (!isPermanentError(acc.unhealthyReason)) {
        acc.failCount = 0
        acc.isHealthy = true
        delete acc.unhealthyReason
        delete acc.recoveryTime
        this.repository.save(acc).catch(() => {})
      }
    }
  }

  private logSdkRequest(prep: SdkPreparedRequest, acc: ManagedAccount, timestamp: string): void {
    logger.logApiRequest(
      {
        url: `https://q.${prep.region}.amazonaws.com/generateAssistantResponse`,
        method: 'POST',
        headers: { 'x-amzn-kiro-agent-mode': 'vibe' },
        body: {
          conversationState: {
            chatTriggerType: prep.conversationState.chatTriggerType,
            conversationId: prep.conversationState.conversationId,
            historyLength: (prep.conversationState as any).history?.length || 0,
            currentMessage: prep.conversationState.currentMessage
          },
          profileArn: prep.profileArn
        },
        conversationId: prep.conversationId,
        model: prep.effectiveModel,
        email: acc.email
      },
      timestamp
    )
  }

  private logSdkResponse(prep: SdkPreparedRequest, timestamp: string): void {
    logger.logApiResponse(
      {
        status: 200,
        statusText: 'OK',
        headers: {},
        conversationId: prep.conversationId,
        model: prep.effectiveModel
      },
      timestamp
    )
  }

  private logSdkError(
    prep: SdkPreparedRequest,
    error: any,
    acc: ManagedAccount,
    apiTimestamp: string
  ): void {
    const status = error?.$metadata?.httpStatusCode || 0
    const rData = {
      status,
      statusText: error?.name || 'Error',
      headers: {},
      error: `Kiro Error: ${status} - ${error?.message || 'Unknown'}`,
      conversationId: prep.conversationId,
      model: prep.effectiveModel
    }
    if (!this.config.enable_log_api_request) {
      logger.logApiError(
        {
          url: `https://q.${prep.region}.amazonaws.com/generateAssistantResponse`,
          method: 'POST',
          headers: {},
          body: null,
          conversationId: prep.conversationId,
          model: prep.effectiveModel,
          email: acc.email
        },
        rData,
        logger.getTimestamp()
      )
    } else {
      logger.logApiResponse(rData, apiTimestamp)
    }
  }

  private async triggerReauth(showToast: ToastFunction): Promise<boolean> {
    if (!this.client) return false

    const cooldownRemaining = REAUTH_FAILURE_COOLDOWN_MS - (Date.now() - this.lastFailedReauthAt)
    if (cooldownRemaining > 0) {
      showToast(
        'Recent re-authentication failed. Please complete authentication manually.',
        'error'
      )
      return false
    }

    if (this.reauthInFlight) {
      return this.reauthInFlight
    }

    if (!kiroDb.acquireReauthLock()) {
      logger.warn('Reauth lock held by another instance — polling for completion')
      showToast('Another session is re-authenticating. Please wait...', 'info')
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        await this.sleep(1000)
        if (kiroDb.isReauthLockHeld()) continue
        this.repository.invalidateCache()
        const accounts = await this.repository.findAll()
        for (const acc of accounts) this.accountManager.addAccount(acc)
        return this.hasUsableAccount(accounts)
      }
      showToast('Re-authentication timed out. Please try again.', 'error')
      return false
    }

    this.reauthInFlight = this.performReauth(showToast)
    const success = await this.reauthInFlight.finally(() => {
      this.reauthInFlight = null
      kiroDb.releaseReauthLock()
    })
    if (!success) this.lastFailedReauthAt = Date.now()
    return success
  }

  private async performReauth(showToast: ToastFunction): Promise<boolean> {
    try {
      showToast('Session expired. Re-authenticating...', 'warning')
      logger.warn('Reauth: starting oauth flow')

      const withTimeout = <T>(promise: Promise<T>, label: string): Promise<T> => {
        let timer: ReturnType<typeof setTimeout> | undefined
        return Promise.race([
          promise.finally(() => clearTimeout(timer)),
          new Promise<T>(
            (_, reject) =>
              (timer = setTimeout(
                () => reject(new Error(`Reauth timed out waiting for ${label}`)),
                REAUTH_TIMEOUT_MS
              ))
          )
        ])
      }

      await withTimeout(
        this.client.provider.oauth.authorize({ path: { id: 'kiro' }, body: { method: 0 } }),
        'oauth.authorize'
      )

      await withTimeout(
        this.client.provider.oauth.callback({ path: { id: 'kiro' }, body: { method: 0 } }),
        'oauth.callback'
      )

      this.repository.invalidateCache()
      const accounts = await this.repository.findAll()
      for (const acc of accounts) {
        this.accountManager.addAccount(acc)
      }

      if (!this.hasUsableAccount(accounts)) {
        logger.warn('Re-auth completed but no usable Kiro account was found')
        showToast('Re-authentication completed but no usable Kiro account was found.', 'error')
        return false
      }

      showToast('Re-authentication successful.', 'success')
      return true
    } catch (e) {
      logger.error('Re-auth failed', e instanceof Error ? e : new Error(String(e)))
      showToast(
        e instanceof Error && e.message.includes('timed out')
          ? 'Re-authentication timed out. Please try again.'
          : 'Re-authentication failed. Please try again.',
        'error'
      )
      return false
    }
  }

  private hasUsableAccount(accounts: ManagedAccount[]): boolean {
    const now = Date.now()
    return accounts.some(
      (acc) => acc.isHealthy && acc.expiresAt > now && !isPermanentError(acc.unhealthyReason)
    )
  }

  private allAccountsPermanentlyUnhealthy(): boolean {
    const accounts = this.accountManager.getAccounts()
    if (accounts.length === 0) {
      return false
    }
    return accounts.every((acc) => !acc.isHealthy && isPermanentError(acc.unhealthyReason))
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}
