import { describe, expect, test } from 'bun:test'
import { mergeAccounts } from '../plugin/storage/locked-operations.js'
import type { ManagedAccount } from '../plugin/types.js'

function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'account-1',
    email: 'user@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: 'refresh',
    accessToken: 'access',
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    usedCount: 210.05,
    limitCount: 2000,
    subscriptionPlan: 'KIRO PRO+',
    lastSync: 1000,
    ...overrides
  }
}

describe('mergeAccounts', () => {
  test('keeps existing quota when incoming snapshot is not newer', () => {
    const [merged] = mergeAccounts(
      [account()],
      [
        account({
          usedCount: 211,
          limitCount: 2000,
          lastSync: 1000,
          lastUsed: 2000
        })
      ]
    )

    expect(merged?.usedCount).toBe(210.05)
    expect(merged?.limitCount).toBe(2000)
    expect(merged?.lastUsed).toBe(2000)
  })

  test('accepts newer remote quota snapshots even when usage decreases', () => {
    const [merged] = mergeAccounts(
      [account({ usedCount: 211, lastSync: 1000 })],
      [account({ usedCount: 210.05, lastSync: 2000 })]
    )

    expect(merged?.usedCount).toBe(210.05)
    expect(merged?.lastSync).toBe(2000)
  })
})
