import type { AccountRepository } from '../../infrastructure/database/account-repository'
import type { AccountManager } from '../../plugin/accounts'
import * as logger from '../../plugin/logger'
import type { KiroAuthDetails, ManagedAccount } from '../../plugin/types'
import { fetchUsageLimits, updateAccountQuota } from '../../plugin/usage'

interface UsageTrackerConfig {
  usage_tracking_enabled: boolean
  usage_sync_max_retries: number
  usage_sync_cooldown_ms?: number
}

export class UsageTracker {
  private lastSyncTime = new Map<string, number>()
  private readonly cooldownMs: number

  constructor(
    private config: UsageTrackerConfig,
    private accountManager: AccountManager,
    private repository: AccountRepository
  ) {
    this.cooldownMs = config.usage_sync_cooldown_ms ?? 60000
  }

  async syncUsage(account: ManagedAccount, auth: KiroAuthDetails): Promise<void> {
    if (!this.config.usage_tracking_enabled) return

    const last = this.lastSyncTime.get(account.id) ?? 0
    if (Date.now() - last < this.cooldownMs) return

    this.lastSyncTime.set(account.id, Date.now())
    this.syncWithRetry(account, auth, 0).catch((e) => {
      logger.warn('Usage sync failed after all retries', {
        accountId: account.id,
        error: e instanceof Error ? e.message : String(e)
      })
    })
  }

  // Fetch usage once and persist it, bypassing the cooldown/retry loop. Used by
  // the startup refresh, where the caller handles token refresh and fallback.
  async syncNow(account: ManagedAccount, auth: KiroAuthDetails): Promise<void> {
    const u = await fetchUsageLimits(auth)
    updateAccountQuota(account, u, this.accountManager)
    await this.repository.batchSave(this.accountManager.getAccounts())
  }

  private async syncWithRetry(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    attempt: number
  ): Promise<void> {
    try {
      await this.syncNow(account, auth)
    } catch (e: any) {
      const msg = e?.message || ''

      // Don't retry rate-limit errors — that just amplifies the problem.
      const isRateLimit =
        msg.includes('429') ||
        msg.includes('ThrottlingException') ||
        msg.includes('TooManyRequests')

      if (!isRateLimit && attempt < this.config.usage_sync_max_retries) {
        await this.sleep(1000 * Math.pow(2, attempt))
        return this.syncWithRetry(account, auth, attempt + 1)
      }

      if (msg.includes('FEATURE_NOT_SUPPORTED')) {
        // Some IDC profiles don't expose getUsageLimits — not an error.
        return
      }

      if (isRateLimit) {
        // Don't penalize the account; the request flow has its own 429 handler.
        logger.warn('Usage sync rate-limited; skipping until next cooldown', {
          accountId: account.id
        })
        return
      }

      if (msg.includes('403') || msg.includes('invalid') || msg.includes('bearer token')) {
        this.accountManager.markUnhealthy(account, msg)
        this.repository.save(account).catch(() => {})
      }

      throw e
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms))
  }
}
