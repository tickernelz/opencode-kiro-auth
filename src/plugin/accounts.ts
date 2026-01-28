import { createHash, randomBytes } from 'node:crypto'
import { decodeRefreshToken, encodeRefreshToken } from '../kiro/auth'
import { isPermanentError } from './health'
import * as logger from './logger'
import { kiroDb } from './storage/sqlite'
import { writeToKiroCli } from './sync/kiro-cli'
import type {
  AccountSelectionStrategy,
  KiroAuthDetails,
  ManagedAccount,
  RefreshParts
} from './types'

export function generateAccountId(): string {
  return randomBytes(16).toString('hex')
}

export function createDeterministicAccountId(
  email: string,
  method: string,
  clientId?: string,
  profileArn?: string
): string {
  return createHash('sha256')
    .update(`${email}:${method}:${clientId || ''}:${profileArn || ''}`)
    .digest('hex')
}

export class AccountManager {
  private accounts: ManagedAccount[]
  private cursor: number
  private strategy: AccountSelectionStrategy
  private lastToastTime = 0
  private lastUsageToastTime = 0
  constructor(accounts: ManagedAccount[], strategy: AccountSelectionStrategy = 'sticky') {
    this.accounts = accounts
    this.cursor = 0
    this.strategy = strategy
  }
  static async loadFromDisk(strategy?: AccountSelectionStrategy): Promise<AccountManager> {
    const rows = kiroDb.getAccounts()
    const accounts: ManagedAccount[] = rows.map((r: any) => ({
      id: r.id,
      email: r.email,
      authMethod: r.auth_method as any,
      region: r.region as any,
      clientId: r.client_id,
      clientSecret: r.client_secret,
      profileArn: r.profile_arn,
      refreshToken: r.refresh_token,
      accessToken: r.access_token,
      expiresAt: r.expires_at,
      rateLimitResetTime: r.rate_limit_reset,
      isHealthy: r.is_healthy === 1,
      unhealthyReason: r.unhealthy_reason,
      recoveryTime: r.recovery_time,
      failCount: r.fail_count || 0,
      lastUsed: r.last_used,
      usedCount: r.used_count,
      limitCount: r.limit_count
    }))
    return new AccountManager(accounts, strategy || 'sticky')
  }
  getAccountCount(): number {
    return this.accounts.length
  }
  getAccounts(): ManagedAccount[] {
    return [...this.accounts]
  }
  shouldShowToast(debounce = 10000): boolean {
    if (Date.now() - this.lastToastTime < debounce) return false
    this.lastToastTime = Date.now()
    return true
  }
  shouldShowUsageToast(debounce = 10000): boolean {
    if (Date.now() - this.lastUsageToastTime < debounce) return false
    this.lastUsageToastTime = Date.now()
    return true
  }
  getMinWaitTime(): number {
    const now = Date.now()
    const waits = this.accounts.map((a) => (a.rateLimitResetTime || 0) - now).filter((t) => t > 0)
    return waits.length > 0 ? Math.min(...waits) : 0
  }
  getCurrentOrNext(): ManagedAccount | null {
    const now = Date.now()
    const available = this.accounts.filter((a) => {
      if (!a.isHealthy) {
        if (isPermanentError(a.unhealthyReason)) {
          return false
        }
        if (a.failCount < 10 && a.recoveryTime && now >= a.recoveryTime) {
          a.isHealthy = true
          delete a.unhealthyReason
          delete a.recoveryTime
          return true
        }
        return false
      }
      return !(a.rateLimitResetTime && now < a.rateLimitResetTime)
    })
    let selected: ManagedAccount | undefined
    if (available.length > 0) {
      if (this.strategy === 'sticky') {
        selected = available.find((_, i) => i === this.cursor) || available[0]
      } else if (this.strategy === 'round-robin') {
        selected = available[this.cursor % available.length]
        this.cursor = (this.cursor + 1) % available.length
      } else if (this.strategy === 'lowest-usage') {
        selected = [...available].sort(
          (a, b) => (a.usedCount || 0) - (b.usedCount || 0) || (a.lastUsed || 0) - (b.lastUsed || 0)
        )[0]
      }
    }
    if (!selected) {
      const fallback = this.accounts
        .filter((a) => !a.isHealthy && a.failCount < 10 && !isPermanentError(a.unhealthyReason))
        .sort(
          (a, b) => (a.usedCount || 0) - (b.usedCount || 0) || (a.lastUsed || 0) - (b.lastUsed || 0)
        )[0]
      if (fallback) {
        fallback.isHealthy = true
        delete fallback.unhealthyReason
        delete fallback.recoveryTime
        selected = fallback
      }
    }
    if (selected) {
      selected.lastUsed = now
      selected.usedCount = (selected.usedCount || 0) + 1
      this.cursor = this.accounts.indexOf(selected)
      return selected
    }
    return null
  }
  updateUsage(id: string, meta: { usedCount: number; limitCount: number; email?: string }): void {
    const a = this.accounts.find((x) => x.id === id)
    if (a) {
      a.usedCount = meta.usedCount
      a.limitCount = meta.limitCount
      if (meta.email) a.email = meta.email
      if (!isPermanentError(a.unhealthyReason)) {
        a.failCount = 0
      }
      kiroDb.upsertAccount(a).catch(() => {})
    }
  }
  addAccount(a: ManagedAccount): void {
    const i = this.accounts.findIndex((x) => x.id === a.id)
    if (i === -1) this.accounts.push(a)
    else this.accounts[i] = a
    kiroDb.upsertAccount(a).catch(() => {})
  }
  removeAccount(a: ManagedAccount): void {
    const removedIndex = this.accounts.findIndex((x) => x.id === a.id)
    if (removedIndex === -1) return
    this.accounts = this.accounts.filter((x) => x.id !== a.id)
    kiroDb.deleteAccount(a.id).catch(() => {})
    if (this.accounts.length === 0) this.cursor = 0
    else if (this.cursor >= this.accounts.length) this.cursor = this.accounts.length - 1
    else if (removedIndex <= this.cursor && this.cursor > 0) this.cursor--
  }
  updateFromAuth(a: ManagedAccount, auth: KiroAuthDetails): void {
    const acc = this.accounts.find((x) => x.id === a.id)
    if (acc) {
      acc.accessToken = auth.access
      acc.expiresAt = auth.expires
      acc.lastUsed = Date.now()
      if (auth.email) acc.email = auth.email
      const p = decodeRefreshToken(auth.refresh)
      acc.refreshToken = p.refreshToken
      if (p.profileArn) acc.profileArn = p.profileArn
      if (p.clientId) acc.clientId = p.clientId
      acc.failCount = 0
      acc.isHealthy = true
      delete acc.unhealthyReason
      delete acc.recoveryTime
      kiroDb.upsertAccount(acc).catch(() => {})
      writeToKiroCli(acc).catch(() => {})
    }
  }
  markRateLimited(a: ManagedAccount, ms: number): void {
    const acc = this.accounts.find((x) => x.id === a.id)
    if (acc) {
      acc.rateLimitResetTime = Date.now() + ms
      kiroDb.upsertAccount(acc).catch(() => {})
    }
  }
  markUnhealthy(a: ManagedAccount, reason: string, recovery?: number): void {
    const acc = this.accounts.find((x) => x.id === a.id)
    if (!acc) return

    const isPermanent = isPermanentError(reason)

    if (isPermanent) {
      logger.warn('Account marked as permanently unhealthy', {
        email: acc.email,
        reason,
        accountId: acc.id
      })
      acc.failCount = 10
      acc.isHealthy = false
      acc.unhealthyReason = reason
      delete acc.recoveryTime
    } else {
      acc.failCount = (acc.failCount || 0) + 1
      acc.unhealthyReason = reason
      acc.lastUsed = Date.now()
      if (acc.failCount >= 10) {
        acc.isHealthy = false
        acc.recoveryTime = recovery || Date.now() + 3600000
      }
    }

    kiroDb.upsertAccount(acc).catch(() => {})
  }
  async saveToDisk(): Promise<void> {
    await kiroDb.batchUpsertAccounts(this.accounts)
  }
  toAuthDetails(a: ManagedAccount): KiroAuthDetails {
    const p: RefreshParts = {
      refreshToken: a.refreshToken,
      profileArn: a.profileArn,
      clientId: a.clientId,
      clientSecret: a.clientSecret,
      authMethod: a.authMethod
    }
    return {
      refresh: encodeRefreshToken(p),
      access: a.accessToken,
      expires: a.expiresAt,
      authMethod: a.authMethod,
      region: a.region,
      profileArn: a.profileArn,
      clientId: a.clientId,
      clientSecret: a.clientSecret,
      email: a.email
    }
  }
}
