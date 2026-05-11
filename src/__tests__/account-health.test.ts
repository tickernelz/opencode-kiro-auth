import { describe, expect, test } from 'bun:test'
import { AccountManager } from '../plugin/accounts.js'
import { isPermanentError } from '../plugin/health.js'
import { mergeAccounts } from '../plugin/storage/locked-operations.js'
import type { ManagedAccount } from '../plugin/types.js'

function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: overrides.id || 'acct-1',
    email: overrides.email || 'user@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: 'refresh',
    accessToken: 'access',
    expiresAt: Date.now() + 60000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides
  }
}

describe('Kiro account health gating', () => {
  test('classifies bad credentials and invalid bearer tokens as permanent auth failures', () => {
    expect(isPermanentError('Refresh failed: Bad credentials')).toBe(true)
    expect(isPermanentError('The bearer token included in the request is invalid.')).toBe(true)
    expect(isPermanentError('HTTP_401')).toBe(true)
    expect(isPermanentError('HTTP_403')).toBe(true)
  })

  test('does not revive or select accounts carrying permanent auth failure reasons', () => {
    const manager = new AccountManager(
      [
        account({
          id: 'bad',
          unhealthyReason: 'Refresh failed: Bad credentials',
          failCount: 242
        }),
        account({
          id: 'good',
          email: 'good@example.com',
          usedCount: 10
        })
      ],
      'lowest-usage'
    )

    expect(manager.getCurrentOrNext()?.id).toBe('good')
  })

  test('keeps temporary unhealthy accounts recoverable after recovery time', () => {
    const manager = new AccountManager(
      [
        account({
          id: 'temporary',
          isHealthy: false,
          unhealthyReason: 'Server Error (500)',
          failCount: 1,
          recoveryTime: Date.now() - 1
        })
      ],
      'sticky'
    )

    expect(manager.getCurrentOrNext()?.id).toBe('temporary')
  })

  test('preserves permanent auth quarantine when Kiro CLI sync re-imports an account', () => {
    const existing = account({
      id: 'bad',
      isHealthy: false,
      unhealthyReason: 'The bearer token included in the request is invalid.',
      failCount: 11,
      usedCount: 1783
    })
    const incoming = account({
      id: 'bad',
      isHealthy: true,
      unhealthyReason: undefined,
      failCount: 0,
      usedCount: 1784
    })

    const [merged] = mergeAccounts([existing], [incoming])

    expect(merged).toBeDefined()
    if (!merged) throw new Error('Expected merged account')
    expect(merged.isHealthy).toBe(false)
    expect(merged.unhealthyReason).toBe('The bearer token included in the request is invalid.')
    expect(merged.failCount).toBe(10)
    expect(merged.usedCount).toBe(1784)
  })
})
