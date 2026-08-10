import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import type { KiroConfig } from '../../plugin/config'
import { THINKING_BUDGETS } from '../../plugin/effort'
import { isPermanentError } from '../../plugin/health'
import { imageCache } from '../../plugin/image-cache'
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

// Matches both the standard q.amazonaws.com endpoint and the Pro runtime.kiro.dev endpoint
const KIRO_API_PATTERN =
  /^(https?:\/\/)?(q\.[a-z0-9-]+\.amazonaws\.com|runtime\.[a-z0-9-]+\.kiro\.dev)/
const REAUTH_FAILURE_COOLDOWN_MS = 60000
const REAUTH_TIMEOUT_MS = 90_000

function extractSessionId(headers: unknown): string | undefined {
  if (!headers) return undefined
  const h = headers as Record<string, string>
  return h['x-session-id'] ?? h['x-session-affinity']
}

export class RequestHandler {
  private accountSelector: AccountSelector
  private tokenRefresher: TokenRefresher
  private errorHandler: ErrorHandler
  private responseHandler: ResponseHandler
  private usageTracker: UsageTracker
  private retryStrategy: RetryStrategy
  private reauthInFlight: Promise<boolean> | null = null
  private lastFailedReauthAt = 0
  private static kiroRequestQueue: Promise<void> = Promise.resolve()

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

    const sessionId = extractSessionId(init?.headers)

    return this.enqueueKiroRequest(() => this.handleKiroRequest(url, init, showToast, sessionId))
  }

  private async enqueueKiroRequest<T>(run: () => Promise<T>): Promise<T> {
    const previous = RequestHandler.kiroRequestQueue
    let release!: () => void

    RequestHandler.kiroRequestQueue = new Promise((resolve) => {
      release = resolve
    })

    await previous.catch(() => {})

    try {
      return await run()
    } finally {
      release()
    }
  }

  private async handleKiroRequest(
    url: string,
    init: any,
    showToast: ToastFunction,
    sessionId?: string
  ): Promise<Response> {
    const body = init?.body ? JSON.parse(init.body) : {}
    const model = this.extractModel(url) || body.model || 'claude-sonnet-4-5'

    // Resolve thinking mode + budget.
    //
    // Priority order:
    //   1. Model ID ends with '-thinking'  → adaptive thinking, 'medium' default budget
    //   2. providerOptions["kiro"].reasoningEffort  → adaptive mode, effort-based budget
    //      (OpenCode sends this when the user picks low/medium/high in the UI)
    //   3. providerOptions.thinkingConfig.thinkingBudget → explicit budget (legacy)
    //
    // Budgets come from plugin/effort.ts's THINKING_BUDGETS, the same reference
    // scale getEffectiveEffort uses to map a budget back to an effort level —
    // keeping a second budget table here would let the two drift apart.
    const provOpts = body.providerOptions?.['kiro'] ?? body.providerOptions ?? {}
    const reasoningEffort: string | undefined = provOpts.reasoningEffort
    const thinkingConfig = body.providerOptions?.thinkingConfig

    const think = model.endsWith('-thinking') || !!reasoningEffort || !!thinkingConfig

    let uiEffort: 'low' | 'medium' | 'high' = 'medium'
    if (reasoningEffort === 'low') uiEffort = 'low'
    else if (reasoningEffort === 'high') uiEffort = 'high'

    const budget: number = thinkingConfig?.thinkingBudget || THINKING_BUDGETS[uiEffort]

    let retry = 0
    let bearerRetried = false
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

      const sdkPrep = this.prepareSdkRequest(body, model, auth, think, budget, showToast, sessionId)

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
        const client = createSdkClient(auth, sdkPrep.region, sdkPrep.effort)
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
          sdkPrep.toolNameMap
        )
        logger.debug(`[REQ] done convId=${sdkPrep.conversationId}`)
        return result
      } catch (e: any) {
        logger.warn(
          `[REQ] error convId=${sdkPrep.conversationId}: ${e?.name || ''} ${e?.message?.slice(0, 200) || String(e).slice(0, 200)}`
        )
        const httpStatus = e?.$metadata?.httpStatusCode

        if (httpStatus && apiTimestamp) {
          this.logSdkError(sdkPrep, e, acc, apiTimestamp)
        }

        if (httpStatus === 403 && !bearerRetried) {
          const msg = e?.message || ''
          if (
            msg.includes('bearer token included in the request is invalid') ||
            msg.includes('The bearer token included in the request is invalid')
          ) {
            bearerRetried = true
            logger.warn('403 bearer invalid on first attempt, forcing token refresh and retrying')
            await this.tokenRefresher.forceRefresh(acc, this.accountManager.toAuthDetails(acc))
            continue
          }
        }

        if (httpStatus) {
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
            { retry, bearerRetried, excludedMs: retryContext.excludedMs },
            showToast,
            model
          )

          if (errorResult.shouldRetry) {
            if (errorResult.newContext) {
              retry = errorResult.newContext.retry
              bearerRetried = errorResult.newContext.bearerRetried ?? bearerRetried
              const sleptMs = (errorResult.newContext.excludedMs ?? 0) - retryContext.excludedMs
              if (sleptMs > 0) this.retryStrategy.markSleep(retryContext, sleptMs)
            }
            if (errorResult.forceRefresh) {
              await this.tokenRefresher.forceRefresh(acc, this.accountManager.toAuthDetails(acc))
            }
            if (errorResult.switchAccount) {
              continue
            }
            continue
          }

          const errMsg = e?.message || `Kiro Error: ${httpStatus}`
          if (/input is too long/i.test(errMsg)) {
            return new Response(
              JSON.stringify({
                error: {
                  message: 'input is too long for requested model',
                  type: 'invalid_request_error',
                  code: 'context_length_exceeded'
                }
              }),
              {
                status: 400,
                headers: { 'Content-Type': 'application/json' }
              }
            )
          }

          if (httpStatus === 400 && e?.name === 'ValidationException' && !forceNewConversation) {
            const { workspace, fingerprint } = sdkPrep.conversationKey
            kiroDb.deleteConversationId(workspace, fingerprint)
            // The conversation is starting fresh — drop any carried-forward
            // images too so the new convId doesn't inherit stale state.
            imageCache.delete(workspace, fingerprint)
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
    showToast?: (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void,
    sessionId?: string
  ): SdkPreparedRequest {
    return transformToSdkRequest(
      body,
      model,
      auth,
      think,
      budget,
      showToast,
      this.workspace,
      this.config.image_carry_forward,
      sessionId,
      { effort: this.config.effort, autoEffortMapping: this.config.auto_effort_mapping },
      this.config.max_payload_bytes
    )
  }

  private handleSuccessfulRequest(acc: ManagedAccount): void {
    // Only write to DB if the account was actually degraded — avoids a
    // withDatabaseLock + full merge/dedup round-trip on every healthy request.
    if (acc.failCount && acc.failCount > 0 && !isPermanentError(acc.unhealthyReason)) {
      acc.failCount = 0
      acc.isHealthy = true
      delete acc.unhealthyReason
      delete acc.recoveryTime
      this.repository.save(acc).catch(() => {})
    }
  }

  private logSdkRequest(prep: SdkPreparedRequest, acc: ManagedAccount, timestamp: string): void {
    // Mirrors what the sdk-client middleware injects, so logs reflect the wire body.
    const additionalModelRequestFields = prep.effort
      ? { output_config: { effort: prep.effort } }
      : undefined

    this.logImageDiagnostic(prep)
    logger.logApiRequest(
      {
        url: `${prep.endpoint}/generateAssistantResponse`,
        method: 'POST',
        headers: { 'x-amzn-kiro-agent-mode': 'vibe' },
        body: {
          conversationState: {
            chatTriggerType: prep.conversationState.chatTriggerType,
            conversationId: prep.conversationState.conversationId,
            historyLength: (prep.conversationState as any).history?.length || 0,
            currentMessage: prep.conversationState.currentMessage
          },
          profileArn: prep.profileArn,
          ...(additionalModelRequestFields ? { additionalModelRequestFields } : {})
        },
        conversationId: prep.conversationId,
        model: prep.effectiveModel,
        email: acc.email
      },
      timestamp
    )
  }

  private logImageDiagnostic(prep: SdkPreparedRequest): void {
    const kb = (bytes: number): number => Math.round(bytes / 1024)
    const sumBytes = (imgs: { source?: { bytes?: { byteLength?: number } } }[]): number =>
      imgs.reduce((n, im) => n + (im.source?.bytes?.byteLength ?? 0), 0)

    const cmImgs = prep.conversationState.currentMessage?.userInputMessage?.images ?? []
    const history = (prep.conversationState as any).history ?? []
    const histDetail: string[] = []
    let histImgs = 0
    let histKb = 0
    for (let i = 0; i < history.length; i++) {
      const imgs = history[i]?.userInputMessage?.images ?? []
      if (imgs.length === 0) continue
      const entryKb = kb(sumBytes(imgs))
      histDetail.push(`i=${i}:user:${imgs.length}(${entryKb}KB)`)
      histImgs += imgs.length
      histKb += entryKb
    }

    const detail = histDetail.length ? ` detail=[${histDetail.join(',')}]` : ''
    logger.log(
      `[IMG] convId=${prep.conversationId} cur=${cmImgs.length}(${kb(sumBytes(cmImgs))}KB)` +
        ` hist=${histImgs}/${history.length}(${histKb}KB)${detail}`
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
          url: `${prep.endpoint}/generateAssistantResponse`,
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
