import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import type { ManagedAccount } from '../../plugin/types'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

interface AccountSelectorConfig {
  auto_sync_kiro_cli: boolean
  account_selection_strategy: 'sticky' | 'round-robin' | 'lowest-usage'
  usage_tracking_enabled: boolean
  usage_toast_enabled: boolean
}

export class AccountSelector {
  private triedEmptySync = false
  private circuitBreakerTrips = 0
  private lastCircuitBreakerReset = Date.now()

  constructor(
    private accountManager: AccountManager,
    private config: AccountSelectorConfig,
    private syncFromKiroCli: () => Promise<void>,
    private repository: AccountRepository
  ) {}

  async selectHealthyAccount(showToast: ToastFunction): Promise<ManagedAccount | null> {
    this.checkCircuitBreaker()

    let count = this.accountManager.getAccountCount()

    if (count === 0 && this.config.auto_sync_kiro_cli && !this.triedEmptySync) {
      this.triedEmptySync = true
      await this.handleEmptyAccounts()
      count = this.accountManager.getAccountCount()
    }

    if (count === 0) {
      throw new Error('No accounts')
    }

    let acc = this.accountManager.getCurrentOrNext()

    if (!acc) {
      this.circuitBreakerTrips++
      const wait = this.accountManager.getMinWaitTime()
      if (wait > 0 && wait < 30000) {
        if (this.accountManager.shouldShowToast()) {
          showToast(`All accounts rate-limited. Waiting ${Math.ceil(wait / 1000)}s...`, 'warning')
        }
        await this.sleep(wait)
        return null
      }
      throw new Error('All accounts are unhealthy or rate-limited')
    }

    this.resetCircuitBreaker()

    if (this.accountManager.shouldShowToast()) {
      showToast(
        `Using ${acc.email} (${this.accountManager.getAccounts().indexOf(acc) + 1}/${count})`,
        'info'
      )
    }

    if (
      this.config.usage_tracking_enabled &&
      this.config.usage_toast_enabled &&
      this.accountManager.shouldShowUsageToast() &&
      acc.usedCount !== undefined &&
      acc.limitCount !== undefined
    ) {
      const p = acc.limitCount > 0 ? (acc.usedCount / acc.limitCount) * 100 : 0
      showToast(
        this.formatUsageMessage(acc.usedCount, acc.limitCount, acc.email),
        p >= 80 ? 'warning' : 'info'
      )
    }

    return acc
  }

  private async handleEmptyAccounts(): Promise<void> {
    await this.syncFromKiroCli()
    this.repository.invalidateCache()
    const accounts = await this.repository.findAll()
    for (const a of accounts) {
      this.accountManager.addAccount(a)
    }
  }

  private formatUsageMessage(usedCount: number, limitCount: number, email: string): string {
    if (limitCount > 0) {
      const percentage = Math.round((usedCount / limitCount) * 100)
      return `Usage (${email}): ${usedCount}/${limitCount} (${percentage}%)`
    }
    return `Usage (${email}): ${usedCount}`
  }

  private checkCircuitBreaker(): void {
    if (Date.now() - this.lastCircuitBreakerReset > 60000) {
      this.circuitBreakerTrips = 0
      this.lastCircuitBreakerReset = Date.now()
    }

    if (this.circuitBreakerTrips >= 10) {
      throw new Error('Circuit breaker tripped: Too many consecutive failures selecting accounts')
    }
  }

  private resetCircuitBreaker(): void {
    if (this.circuitBreakerTrips > 0) {
      this.circuitBreakerTrips = 0
      this.lastCircuitBreakerReset = Date.now()
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}
