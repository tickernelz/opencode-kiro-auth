import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import type { ManagedAccount } from '../../plugin/types'
import { summarizeUsage } from '../../plugin/usage'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

interface AccountSelectorConfig {
  auto_sync_kiro_cli: boolean
  account_selection_strategy: 'sticky' | 'round-robin' | 'lowest-usage'
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
      throw new Error('All accounts are unhealthy or rate-limited: reauth required')
    }

    this.resetCircuitBreaker()

    const used = acc.usedCount ?? 0
    const limit = acc.limitCount ?? 0
    if (limit > 0 && used / limit >= 0.9 && this.accountManager.shouldShowUsageToast()) {
      showToast(this.formatUsageMessage(used, limit, acc.email || ''), 'warning')
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
    const { used, limit, pct } = summarizeUsage(usedCount, limitCount)
    return limit > 0 ? `Usage (${email}): ${used}/${limit} (${pct}%)` : `Usage (${email}): ${used}`
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
