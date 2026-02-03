import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import type { ManagedAccount } from '../../plugin/types'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

interface RequestContext {
  reductionFactor: number
  retry: number
}

interface ErrorHandlerConfig {
  rate_limit_max_retries: number
  rate_limit_retry_delay_ms: number
}

export class ErrorHandler {
  constructor(
    private config: ErrorHandlerConfig,
    private accountManager: AccountManager,
    private repository: AccountRepository
  ) {}

  async handle(
    error: any,
    response: Response,
    account: ManagedAccount,
    context: RequestContext,
    showToast: ToastFunction
  ): Promise<{ shouldRetry: boolean; newContext?: RequestContext; switchAccount?: boolean }> {
    if (response.status === 400 && context.reductionFactor > 0.4) {
      const newFactor = context.reductionFactor - 0.2
      showToast(`Context too long. Retrying with ${Math.round(newFactor * 100)}%...`, 'warning')
      return {
        shouldRetry: true,
        newContext: { ...context, reductionFactor: newFactor }
      }
    }

    if (response.status === 401 && context.retry < this.config.rate_limit_max_retries) {
      return {
        shouldRetry: true,
        newContext: { ...context, retry: context.retry + 1 }
      }
    }

    if (response.status === 500) {
      account.failCount = (account.failCount || 0) + 1
      let errorMessage = 'Internal Server Error'
      try {
        const errorBody = await response.text()
        const errorData = JSON.parse(errorBody)
        if (errorData.message) {
          errorMessage = errorData.message
        } else if (errorData.Message) {
          errorMessage = errorData.Message
        }
      } catch (e) {}

      if (account.failCount < 5) {
        const delay = 1000 * Math.pow(2, account.failCount - 1)
        showToast(
          `Server Error (500): ${errorMessage}. Retrying in ${Math.ceil(delay / 1000)}s...`,
          'warning'
        )
        await this.sleep(delay)
        return { shouldRetry: true }
      } else {
        this.accountManager.markUnhealthy(
          account,
          `Server Error (500) after 5 attempts: ${errorMessage}`
        )
        await this.repository.batchSave(this.accountManager.getAccounts())
        showToast(
          `Server Error (500): ${errorMessage}. Marking account as unhealthy and switching...`,
          'warning'
        )
        return { shouldRetry: true, switchAccount: true }
      }
    }

    if (response.status === 429) {
      const w = parseInt(response.headers.get('retry-after') || '60') * 1000
      this.accountManager.markRateLimited(account, w)
      await this.repository.batchSave(this.accountManager.getAccounts())
      const count = this.accountManager.getAccountCount()
      if (count > 1) {
        showToast(`Rate limited (${account.email}). Switching account...`, 'warning')
        return { shouldRetry: true, switchAccount: true }
      }
      showToast(`Rate limited. Waiting ${Math.ceil(w / 1000)}s...`, 'warning')
      await this.sleep(w)
      return { shouldRetry: true }
    }

    if (
      (response.status === 402 || response.status === 403) &&
      this.accountManager.getAccountCount() > 1
    ) {
      let errorReason = response.status === 402 ? 'Quota' : 'Forbidden'
      let isPermanent = false
      try {
        const errorBody = await response.text()
        try {
          const errorData = JSON.parse(errorBody)
          if (errorData.reason === 'INVALID_MODEL_ID') {
            throw new Error(`Invalid model: ${errorData.message}`)
          }
          if (errorData.reason === 'TEMPORARILY_SUSPENDED') {
            errorReason = 'Account Suspended'
            isPermanent = true
          } else if (errorData.reason || errorData.message) {
            const detail = errorData.reason
              ? `${errorData.reason}${errorData.message ? `: ${errorData.message}` : ''}`
              : errorData.message
            errorReason = `${errorReason} (${detail})`
          }
        } catch (parseError) {
          if (errorBody) {
            const trimmed = errorBody.replace(/\s+/g, ' ').trim().slice(0, 160)
            if (trimmed) errorReason = `${errorReason} (${trimmed})`
          }
        }
      } catch (e) {
        if (e instanceof Error && e.message.includes('Invalid model')) {
          throw e
        }
      }
      if (isPermanent) {
        account.failCount = 10
      }
      this.accountManager.markUnhealthy(account, errorReason)
      await this.repository.batchSave(this.accountManager.getAccounts())
      showToast(`${errorReason} (${account.email}). Switching account...`, 'warning')
      return { shouldRetry: true, switchAccount: true }
    }

    return { shouldRetry: false }
  }

  async handleNetworkError(
    error: any,
    context: RequestContext,
    showToast: ToastFunction
  ): Promise<{ shouldRetry: boolean; newContext?: RequestContext }> {
    if (this.isNetworkError(error) && context.retry < this.config.rate_limit_max_retries) {
      const d = this.config.rate_limit_retry_delay_ms * Math.pow(2, context.retry)
      showToast(`Network error. Retrying in ${Math.ceil(d / 1000)}s...`, 'warning')
      await this.sleep(d)
      return {
        shouldRetry: true,
        newContext: { ...context, retry: context.retry + 1 }
      }
    }
    return { shouldRetry: false }
  }

  private isNetworkError(e: any): boolean {
    return (
      e instanceof Error && /econnreset|etimedout|enotfound|network|fetch failed/i.test(e.message)
    )
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}
