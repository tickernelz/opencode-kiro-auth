import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import { KIRO_PROVIDER_ID, THINKING_BUDGET_BY_EFFORT } from '../../constants'
import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import type { KiroConfig } from '../../plugin/config'
import { isPermanentError } from '../../plugin/health'
import * as logger from '../../plugin/logger'
import { transformToSdkRequest } from '../../plugin/request'
import { createSdkClient, type ResolvedSdkEndpointMode } from '../../plugin/sdk-client'
import { syncFromKiroCli } from '../../plugin/sync/kiro-cli'
import type { KiroAuthDetails, ManagedAccount, SdkPreparedRequest } from '../../plugin/types'
import { AccountSelector } from '../account/account-selector'
import { UsageTracker } from '../account/usage-tracker'
import { TokenRefresher } from '../auth/token-refresher'
import { ErrorHandler } from './error-handler'
import { ResponseHandler } from './response-handler'
import { RetryStrategy } from './retry-strategy'
import { shouldFallbackSdkEndpointError } from './sdk-endpoint-fallback'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

const KIRO_API_PATTERN = /^(https?:\/\/)?q\.[a-z0-9-]+\.amazonaws\.com/
const REAUTH_FAILURE_COOLDOWN_MS = 60000

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
    private client?: any
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
    const effort = this.extractReasoningEffort(body)
    const explicitThinkingBudget = body.providerOptions?.thinkingConfig?.thinkingBudget
    const think = model.endsWith('-thinking') || !!explicitThinkingBudget || !!effort
    const budget =
      explicitThinkingBudget ||
      (effort ? THINKING_BUDGET_BY_EFFORT[effort] : undefined) ||
      (model.endsWith('-thinking') ? THINKING_BUDGET_BY_EFFORT.high : 20000)

    let retry = 0
    let consecutiveNullAccounts = 0
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

      const sdkPrep = this.prepareSdkRequest(init?.body, model, auth, think, budget, showToast)

      let sdkEndpointMode = this.getSdkEndpointModes()[0] || 'sdk-default'
      const apiTimestamp = this.config.enable_log_api_request ? logger.getTimestamp() : null
      if (apiTimestamp) {
        this.logSdkRequest(sdkPrep, acc, apiTimestamp, sdkEndpointMode)
      }

      try {
        const sdkResult = await this.sendSdkRequestWithEndpointFallback(auth, sdkPrep)
        sdkEndpointMode = sdkResult.endpointMode
        const sdkResponse = sdkResult.sdkResponse

        if (apiTimestamp) {
          this.logSdkResponse(sdkPrep, apiTimestamp)
        }

        this.handleSuccessfulRequest(acc)
        this.usageTracker.syncUsage(acc, auth)

        return await this.responseHandler.handleSdkSuccess(
          sdkResponse,
          model,
          sdkPrep.conversationId,
          sdkPrep.streaming,
          think
        )
      } catch (e: any) {
        const httpStatus = e?.$metadata?.httpStatusCode

        if (httpStatus) {
          if (apiTimestamp) {
            this.logSdkError(sdkPrep, e, acc, apiTimestamp, e.__kiroEndpointMode || sdkEndpointMode)
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
            { retry },
            showToast
          )

          if (errorResult.shouldRetry) {
            if (errorResult.newContext) {
              retry = errorResult.newContext.retry
            }
            if (errorResult.switchAccount) {
              continue
            }
            continue
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
    return transformToSdkRequest(body, model, auth, think, budget, showToast)
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

  private async sendSdkRequestWithEndpointFallback(
    auth: KiroAuthDetails,
    prep: SdkPreparedRequest
  ): Promise<{ sdkResponse: any; endpointMode: ResolvedSdkEndpointMode }> {
    const endpointModes = this.getSdkEndpointModes()
    let lastError: any

    for (let i = 0; i < endpointModes.length; i++) {
      const endpointMode = endpointModes[i] || 'sdk-default'
      try {
        const client = createSdkClient(auth, prep.region, endpointMode)
        const command = new GenerateAssistantResponseCommand({
          conversationState: prep.conversationState as any,
          profileArn: prep.profileArn
        })
        const sdkResponse = await client.send(command)
        return { sdkResponse, endpointMode }
      } catch (e: any) {
        e.__kiroEndpointMode = endpointMode
        lastError = e

        if (i < endpointModes.length - 1 && this.shouldFallbackSdkEndpoint(e)) {
          logger.warn('SDK endpoint failed; trying fallback endpoint', {
            endpointMode,
            fallbackEndpointMode: endpointModes[i + 1],
            status: e?.$metadata?.httpStatusCode,
            name: e?.name,
            message: e?.message
          })
          continue
        }

        throw e
      }
    }

    throw lastError
  }

  private getSdkEndpointModes(): ResolvedSdkEndpointMode[] {
    if (this.config.sdk_endpoint_mode === 'legacy-q') return ['legacy-q']
    if (this.config.sdk_endpoint_mode === 'sdk-default') return ['sdk-default']
    return ['sdk-default', 'legacy-q']
  }

  private shouldFallbackSdkEndpoint(error: any): boolean {
    return shouldFallbackSdkEndpointError(error)
  }

  private formatSdkEndpointUrl(region: string, endpointMode: ResolvedSdkEndpointMode): string {
    if (endpointMode === 'legacy-q') {
      return `https://q.${region}.amazonaws.com/generateAssistantResponse`
    }
    return `https://amazoncodewhispererstreamingservice.${region}.amazonaws.com/generateAssistantResponse`
  }

  private logSdkRequest(
    prep: SdkPreparedRequest,
    acc: ManagedAccount,
    timestamp: string,
    endpointMode: ResolvedSdkEndpointMode
  ): void {
    logger.logApiRequest(
      {
        url: this.formatSdkEndpointUrl(prep.region, endpointMode),
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
    apiTimestamp: string,
    endpointMode: ResolvedSdkEndpointMode
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
          url: this.formatSdkEndpointUrl(prep.region, endpointMode),
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

    this.reauthInFlight = this.performReauth(showToast)
    const success = await this.reauthInFlight.finally(() => {
      this.reauthInFlight = null
    })
    if (!success) this.lastFailedReauthAt = Date.now()
    return success
  }

  private async performReauth(showToast: ToastFunction): Promise<boolean> {
    try {
      showToast('Session expired. Re-authenticating...', 'warning')
      await this.client.provider.oauth.authorize({
        path: { id: KIRO_PROVIDER_ID },
        body: { method: 0 }
      })

      await this.client.provider.oauth.callback({
        path: { id: KIRO_PROVIDER_ID },
        body: { method: 0 }
      })

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

  private extractReasoningEffort(body: any): keyof typeof THINKING_BUDGET_BY_EFFORT | undefined {
    const value =
      body?.reasoning_effort ||
      body?.reasoningEffort ||
      body?.providerOptions?.openaiCompatible?.reasoningEffort ||
      body?.providerOptions?.openaiCompatible?.reasoning_effort ||
      body?.providerOptions?.reasoningEffort

    if (typeof value !== 'string') return undefined
    const normalized = value.toLowerCase()
    if (normalized in THINKING_BUDGET_BY_EFFORT) {
      return normalized as keyof typeof THINKING_BUDGET_BY_EFFORT
    }
    return undefined
  }
}
