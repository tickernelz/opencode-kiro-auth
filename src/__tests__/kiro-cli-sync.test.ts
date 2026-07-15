import { describe, expect, test } from 'bun:test'
import { mergeAccounts } from '../plugin/storage/locked-operations.js'
import { getStaleKiroCliAccountIds } from '../plugin/sync/stale-accounts.js'
import type { ManagedAccount } from '../plugin/types.js'

function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'account-id',
    email: 'user@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    clientId: 'client-current',
    clientSecret: 'secret',
    profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/current',
    refreshToken: 'refresh',
    accessToken: 'access',
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides
  }
}

describe('Kiro CLI account sync', () => {
  test('healthy CLI credentials recover an account with a previous permanent refresh error', () => {
    const existing = account({
      isHealthy: false,
      failCount: 10,
      unhealthyReason: 'Refresh failed: HTTP_401',
      recoveryTime: Date.now() + 3600000,
      accessToken: 'stale-access'
    })

    const incoming = account({
      accessToken: 'fresh-access',
      isHealthy: true,
      failCount: 0,
      unhealthyReason: undefined,
      recoveryTime: undefined
    })

    const merged = mergeAccounts([existing], [incoming])[0]!

    expect(merged.isHealthy).toBe(true)
    expect(merged.failCount).toBe(0)
    expect(merged.unhealthyReason).toBeUndefined()
    expect(merged.recoveryTime).toBeUndefined()
    expect(merged.accessToken).toBe('fresh-access')
  })

  test('deactivates stale cached CLI account variants after a successful CLI import', () => {
    const synced = {
      id: 'current-id',
      email: 'user@example.com',
      authMethod: 'idc' as const,
      clientId: 'client-current',
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/current'
    }

    const staleSameProfile = {
      id: 'old-id',
      email: 'user@example.com',
      auth_method: 'idc',
      client_id: 'client-old',
      profile_arn: synced.profileArn,
      last_sync: Date.now() - 1000
    }
    const stalePreviouslySynced = {
      id: 'old-cli-synced-id',
      email: 'old@example.com',
      auth_method: 'idc',
      client_id: 'client-old-2',
      profile_arn: 'arn:aws:codewhisperer:us-east-1:123:profile/old',
      last_sync: Date.now() - 1000
    }
    const manualOtherAccount = {
      id: 'manual-id',
      email: 'other@example.com',
      auth_method: 'desktop',
      client_id: 'manual-client',
      profile_arn: 'arn:aws:codewhisperer:us-east-1:123:profile/manual',
      last_sync: 0
    }

    expect(
      getStaleKiroCliAccountIds(
        [synced, staleSameProfile, stalePreviouslySynced, manualOtherAccount],
        [synced]
      )
    ).toEqual(['old-id'])
  })

  test('does not deactivate unrelated previously synced accounts with the same auth method', () => {
    const synced = {
      id: 'current-id',
      email: 'current@example.com',
      authMethod: 'idc' as const,
      clientId: 'current-client',
      profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/current'
    }
    const unrelated = {
      id: 'other-id',
      email: 'other@example.com',
      auth_method: 'idc',
      client_id: 'other-client',
      profile_arn: 'arn:aws:codewhisperer:us-east-1:123:profile/other',
      last_sync: Date.now() - 1000
    }

    expect(getStaleKiroCliAccountIds([synced, unrelated], [synced])).toEqual([])
  })

  test('does not treat a shared email as identity when stable identifiers differ', () => {
    const synced = {
      id: 'current-id',
      email: 'shared@example.com',
      authMethod: 'idc' as const,
      clientId: 'current-client',
      profileArn: 'profile-current'
    }
    const unrelated = {
      id: 'other-id',
      email: 'shared@example.com',
      auth_method: 'idc',
      client_id: 'other-client',
      profile_arn: 'profile-other'
    }

    expect(getStaleKiroCliAccountIds([synced, unrelated], [synced])).toEqual([])
  })
})
