import { randomBytes } from 'node:crypto'
import { loadAccounts, saveAccounts, loadUsage, saveUsage } from './storage'
import type {
  ManagedAccount,
  AccountMetadata,
  AccountSelectionStrategy,
  KiroAuthDetails,
  RefreshParts,
  UsageMetadata
} from './types'
import { KIRO_CONSTANTS } from '../constants'
import { encodeRefreshToken, decodeRefreshToken } from '../kiro/auth'

export function generateAccountId(): string {
  return randomBytes(16).toString('hex')
}

export class AccountManager {
  private accounts: ManagedAccount[]
  private usage: Record<string, UsageMetadata>
  private cursor: number
  private strategy: AccountSelectionStrategy
  private lastToastTime = 0
  private lastUsageToastTime = 0

  constructor(
    accounts: ManagedAccount[],
    usage: Record<string, UsageMetadata>,
    strategy: AccountSelectionStrategy = 'sticky'
  ) {
    this.accounts = accounts
    this.usage = usage
    this.cursor = 0
    this.strategy = strategy
    for (const a of this.accounts) {
      const m = this.usage[a.id]
      if (m) {
        a.usedCount = m.usedCount
        a.limitCount = m.limitCount
        a.realEmail = m.realEmail
      }
    }
  }

  static async loadFromDisk(strategy?: AccountSelectionStrategy): Promise<AccountManager> {
    const s = await loadAccounts()
    const u = await loadUsage()
    const accounts: ManagedAccount[] = s.accounts.map((m) => ({
      ...m,
      region: m.region || KIRO_CONSTANTS.DEFAULT_REGION
    }))
    return new AccountManager(accounts, u.usage, strategy || 'sticky')
  }

  getAccountCount(): number {
    return this.accounts.length
  }
  getAccounts(): ManagedAccount[] {
    return [...this.accounts]
  }

  shouldShowToast(debounce = 30000): boolean {
    if (Date.now() - this.lastToastTime < debounce) return false
    this.lastToastTime = Date.now()
    return true
  }

  shouldShowUsageToast(debounce = 30000): boolean {
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
        if (a.recoveryTime && now >= a.recoveryTime) {
          a.isHealthy = true
          delete a.unhealthyReason
          delete a.recoveryTime
          return true
        }
        return false
      }
      return !(a.rateLimitResetTime && now < a.rateLimitResetTime)
    })

    if (available.length === 0) return null

    let selected: ManagedAccount | undefined
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

    if (selected) {
      selected.lastUsed = now
      selected.usedCount = (selected.usedCount || 0) + 1
      this.cursor = this.accounts.indexOf(selected)
      return selected
    }
    return null
  }

  updateUsage(
    id: string,
    meta: { usedCount: number; limitCount: number; realEmail?: string }
  ): void {
    const a = this.accounts.find((x) => x.id === id)
    if (a) {
      a.usedCount = meta.usedCount
      a.limitCount = meta.limitCount
      if (meta.realEmail) a.realEmail = meta.realEmail
    }
    this.usage[id] = { ...meta, lastSync: Date.now() }
  }

  addAccount(a: ManagedAccount): void {
    const i = this.accounts.findIndex((x) => x.id === a.id)
    if (i === -1) this.accounts.push(a)
    else this.accounts[i] = a
  }

  removeAccount(a: ManagedAccount): void {
    this.accounts = this.accounts.filter((x) => x.id !== a.id)
    delete this.usage[a.id]
    this.cursor = Math.max(0, Math.min(this.cursor, this.accounts.length - 1))
  }

  updateFromAuth(a: ManagedAccount, auth: KiroAuthDetails): void {
    const acc = this.accounts.find((x) => x.id === a.id)
    if (acc) {
      acc.accessToken = auth.access
      acc.expiresAt = auth.expires
      acc.lastUsed = Date.now()
      if (auth.email && auth.email !== 'builder-id@aws.amazon.com') acc.realEmail = auth.email
      const p = decodeRefreshToken(auth.refresh)
      acc.refreshToken = p.refreshToken
      if (p.profileArn) acc.profileArn = p.profileArn
      if (p.clientId) acc.clientId = p.clientId
    }
  }

  markRateLimited(a: ManagedAccount, ms: number): void {
    const acc = this.accounts.find((x) => x.id === a.id)
    if (acc) acc.rateLimitResetTime = Date.now() + ms
  }

  markUnhealthy(a: ManagedAccount, reason: string, recovery?: number): void {
    const acc = this.accounts.find((x) => x.id === a.id)
    if (acc) {
      acc.isHealthy = false
      acc.unhealthyReason = reason
      acc.recoveryTime = recovery
    }
  }

  async saveToDisk(): Promise<void> {
    const metadata: AccountMetadata[] = this.accounts.map(
      ({ usedCount, limitCount, lastUsed, ...rest }) => rest
    )
    await saveAccounts({ version: 1, accounts: metadata, activeIndex: this.cursor })
    await saveUsage({ version: 1, usage: this.usage })
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
