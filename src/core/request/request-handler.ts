import { execFile } from 'node:child_process'
import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import type { KiroConfig } from '../../plugin/config'
import { isPermanentError } from '../../plugin/health'
import * as logger from '../../plugin/logger'
import { transformToCodeWhisperer } from '../../plugin/request'
import { syncFromKiroCli } from '../../plugin/sync/kiro-cli'
import type { KiroAuthDetails, ManagedAccount, PreparedRequest } from '../../plugin/types'
import { AccountSelector } from '../account/account-selector'
import { UsageTracker } from '../account/usage-tracker'
import { TokenRefresher } from '../auth/token-refresher'
import { ErrorHandler } from './error-handler'
import { ResponseHandler } from './response-handler'
import { RetryStrategy } from './retry-strategy'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

const KIRO_API_PATTERN = /^(https?:\/\/)?q\.[a-z0-9-]+\.amazonaws\.com/

export class RequestHandler {
  private accountSelector: AccountSelector
  private tokenRefresher: TokenRefresher
  private errorHandler: ErrorHandler
  private responseHandler: ResponseHandler
  private usageTracker: UsageTracker
  private retryStrategy: RetryStrategy

  constructor(
    private accountManager: AccountManager,
    private config: KiroConfig,
    private repository: AccountRepository
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

    let reductionFactor = 1.0
    let retry = 0
    let consecutiveNullAccounts = 0
    const retryContext = this.retryStrategy.createContext()

    while (true) {
      const check = this.retryStrategy.shouldContinue(retryContext)
      if (!check.canContinue) {
        throw new Error(check.error)
      }

      if (this.allAccountsPermanentlyUnhealthy()) {
        const reauthed = await this.triggerKiroCliLogin(showToast)
        if (!reauthed) {
          throw new Error(
            'All accounts are permanently unhealthy. Please re-authenticate with kiro-cli login.'
          )
        }
        continue
      }

      let acc = await this.accountSelector.selectHealthyAccount(showToast)
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

      const prep = this.prepareRequest(url, init?.body, model, auth, think, budget, reductionFactor)

      const apiTimestamp = this.config.enable_log_api_request ? logger.getTimestamp() : null
      if (apiTimestamp) {
        this.logRequest(prep, acc, apiTimestamp)
      }

      try {
        const res = await fetch(prep.url, prep.init)

        if (apiTimestamp) {
          this.logResponse(res, prep, apiTimestamp)
        }

        if (res.ok) {
          this.handleSuccessfulRequest(acc)
          this.usageTracker.syncUsage(acc, auth)
          return await this.responseHandler.handleSuccess(
            res,
            model,
            prep.conversationId,
            prep.streaming
          )
        }

        const errorResult = await this.errorHandler.handle(
          null,
          res,
          acc,
          { reductionFactor, retry },
          showToast
        )

        if (errorResult.shouldRetry) {
          if (errorResult.newContext) {
            reductionFactor = errorResult.newContext.reductionFactor
            retry = errorResult.newContext.retry
          }
          if (errorResult.switchAccount) {
            continue
          }
          continue
        }

        this.logError(prep, res, acc, apiTimestamp)
        throw new Error(`Kiro Error: ${res.status}`)
      } catch (e) {
        const networkResult = await this.errorHandler.handleNetworkError(
          e,
          { reductionFactor, retry },
          showToast
        )

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

  private prepareRequest(
    url: string,
    body: any,
    model: string,
    auth: KiroAuthDetails,
    think: boolean,
    budget: number,
    reductionFactor: number
  ): PreparedRequest {
    return transformToCodeWhisperer(url, body, model, auth, think, budget, reductionFactor)
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

  private logRequest(prep: PreparedRequest, acc: ManagedAccount, timestamp: string): void {
    let b = null
    try {
      b = prep.init.body ? JSON.parse(prep.init.body as string) : null
    } catch {}
    logger.logApiRequest(
      {
        url: prep.url,
        method: prep.init.method,
        headers: prep.init.headers,
        body: b,
        conversationId: prep.conversationId,
        model: prep.effectiveModel,
        email: acc.email
      },
      timestamp
    )
  }

  private logResponse(res: Response, prep: PreparedRequest, timestamp: string): void {
    const h: any = {}
    res.headers.forEach((v, k) => {
      h[k] = v
    })
    logger.logApiResponse(
      {
        status: res.status,
        statusText: res.statusText,
        headers: h,
        conversationId: prep.conversationId,
        model: prep.effectiveModel
      },
      timestamp
    )
  }

  private logError(
    prep: PreparedRequest,
    res: Response,
    acc: ManagedAccount,
    apiTimestamp: string | null
  ): void {
    const h: any = {}
    res.headers.forEach((v, k) => {
      h[k] = v
    })
    const rData = {
      status: res.status,
      statusText: res.statusText,
      headers: h,
      error: `Kiro Error: ${res.status}`,
      conversationId: prep.conversationId,
      model: prep.effectiveModel
    }
    let lastB = null
    try {
      lastB = prep.init.body ? JSON.parse(prep.init.body as string) : null
    } catch {}
    if (!this.config.enable_log_api_request) {
      logger.logApiError(
        {
          url: prep.url,
          method: prep.init.method,
          headers: prep.init.headers,
          body: lastB,
          conversationId: prep.conversationId,
          model: prep.effectiveModel,
          email: acc.email
        },
        rData,
        logger.getTimestamp()
      )
    }
  }

  private async triggerKiroCliLogin(showToast: ToastFunction): Promise<boolean> {
    try {
      showToast('Session expired. Launching kiro-cli login...', 'warning')
      logger.log('Triggering kiro-cli login for re-authentication')

      await new Promise<void>((resolve, reject) => {
        execFile('kiro-cli', ['login'], { timeout: 120000 }, (error) => {
          if (error) reject(error)
          else resolve()
        })
      })

      await syncFromKiroCli()
      this.repository.invalidateCache()
      const accounts = await this.repository.findAll()
      for (const acc of accounts) {
        this.accountManager.addAccount(acc)
      }

      const healthy = accounts.some((a) => a.isHealthy)
      if (healthy) {
        showToast('Re-authentication successful.', 'success')
        return true
      }

      logger.warn('kiro-cli login completed but no healthy accounts found')
      return false
    } catch (e) {
      logger.error('kiro-cli login failed', e instanceof Error ? e : new Error(String(e)))
      showToast('Re-authentication failed. Run kiro-cli login manually.', 'error')
      return false
    }
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
