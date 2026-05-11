import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import type { ManagedAccount } from '../../plugin/types'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

interface RequestContext {
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
    const readBody = async (): Promise<string> => {
      try {
        const body = JSON.parse(await response.clone().text())
        return body.message || body.Message || body.__type || JSON.stringify(body)
      } catch {
        return ''
      }
    }

    if (response.status === 400) {
      const reason = await readBody()
      showToast(`400: ${reason || 'unknown'}`, 'error')
      return { shouldRetry: false }
    }

    if (response.status === 401 && context.retry < this.config.rate_limit_max_retries) {
      const reason = await readBody()
      showToast(`401: ${reason || 'Unauthorized'}. Retrying...`, 'warning')
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
        showToast(`500: ${errorMessage}. Retrying in ${Math.ceil(delay / 1000)}s...`, 'warning')
        await this.sleep(delay)
        return { shouldRetry: true }
      } else {
        this.accountManager.markUnhealthy(
          account,
          `Server Error (500) after 5 attempts: ${errorMessage}`
        )
        await this.repository.batchSave(this.accountManager.getAccounts())
        showToast(`500: ${errorMessage}. Marking account as unhealthy and switching...`, 'warning')
        return { shouldRetry: true, switchAccount: true }
      }
    }

    if (response.status === 429) {
      const w = parseInt(response.headers.get('retry-after') || '60') * 1000
      this.accountManager.markRateLimited(account, w)
      await this.repository.batchSave(this.accountManager.getAccounts())
      const usableCount = this.accountManager.getUsableAccountCount()
      if (usableCount > 0) {
        showToast(
          `429: ${account.email || 'account'} rate-limited. Switching account...`,
          'warning'
        )
        return { shouldRetry: true, switchAccount: true }
      }
      throw new Error(`All Kiro accounts are rate-limited. Retry after ${Math.ceil(w / 1000)}s.`)
    }

    if (response.status === 402 || response.status === 403) {
      let errorReason = response.status === 402 ? 'Quota' : 'Forbidden'
      let isPermanent = false
      const errorBody = await response.text()
      const errorData = (() => {
        try {
          return JSON.parse(errorBody)
        } catch {
          return null
        }
      })()
      if (errorData?.message) {
        errorReason = errorData.message
      }
      if (errorData?.reason === 'INVALID_MODEL_ID') {
        throw new Error(`Invalid model: ${errorData.message}`)
      }
      if (errorData?.reason === 'TEMPORARILY_SUSPENDED') {
        errorReason = 'Account Suspended'
        isPermanent = true
      }
      if (
        errorReason.includes('bearer token included in the request is invalid') ||
        errorReason.includes('The bearer token included in the request is invalid')
      ) {
        isPermanent = true
      }
      if (isPermanent) {
        account.failCount = 10
      }

      if (this.accountManager.getAccountCount() > 1) {
        showToast(`${response.status}: ${errorReason}. Switching account...`, 'warning')
        this.accountManager.markUnhealthy(account, errorReason)
        await this.repository.batchSave(this.accountManager.getAccounts())
        return { shouldRetry: true, switchAccount: true }
      }

      if (
        response.status === 403 &&
        !isPermanent &&
        context.retry < this.config.rate_limit_max_retries
      ) {
        const delay = this.config.rate_limit_retry_delay_ms * Math.pow(2, context.retry)
        showToast(`403: ${errorReason}. Retrying in ${Math.ceil(delay / 1000)}s...`, 'warning')
        await this.sleep(delay)
        return {
          shouldRetry: true,
          newContext: { ...context, retry: context.retry + 1 }
        }
      }

      showToast(`${response.status}: ${errorReason}`, 'error')
      return { shouldRetry: false }
    }

    const reason = await readBody()
    showToast(`${response.status}: ${reason || response.statusText}`, 'error')
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
