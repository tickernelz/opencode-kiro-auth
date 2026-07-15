import { describe, expect, test } from 'bun:test'
import { TokenRefresher } from '../core/auth/token-refresher.js'
import { KiroTokenRefreshError } from '../plugin/errors.js'
import type { KiroAuthDetails, ManagedAccount } from '../plugin/types.js'

function account(): ManagedAccount {
  return {
    id: 'account-1',
    email: 'user@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: 'old-refresh',
    accessToken: 'old-access',
    expiresAt: 0,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0
  }
}

function auth(acc: ManagedAccount): KiroAuthDetails {
  return {
    refresh: acc.refreshToken,
    access: acc.accessToken,
    expires: acc.expiresAt,
    authMethod: acc.authMethod,
    region: acc.region,
    email: acc.email
  }
}

describe('TokenRefresher', () => {
  test('returns refreshed auth and shares one refresh across concurrent requests', async () => {
    const acc = account()
    const accounts = [acc]
    let refreshCalls = 0
    let releaseRefresh!: () => void
    const refreshGate = new Promise<void>((resolve) => {
      releaseRefresh = resolve
    })
    const refreshed: KiroAuthDetails = {
      ...auth(acc),
      refresh: 'new-refresh',
      access: 'new-access',
      expires: Date.now() + 3600000
    }
    const manager = {
      getAccounts: () => accounts,
      updateFromAuth: (target: ManagedAccount, next: KiroAuthDetails) => {
        target.refreshToken = next.refresh
        target.accessToken = next.access
        target.expiresAt = next.expires
      },
      toAuthDetails: auth,
      markUnhealthy: () => {},
      addAccount: () => {},
      removeAccount: () => {}
    }
    const repository = {
      batchSave: async () => {},
      invalidateCache: () => {},
      findAll: async () => accounts
    }
    const refresher = new TokenRefresher(
      {
        token_expiry_buffer_ms: 300000,
        auto_sync_kiro_cli: false,
        account_selection_strategy: 'sticky'
      },
      manager as any,
      async () => {},
      repository as any,
      async () => {
        refreshCalls++
        await refreshGate
        return refreshed
      }
    )

    const first = refresher.refreshIfNeeded(acc, auth(acc), () => {})
    const second = refresher.refreshIfNeeded(acc, auth(acc), () => {})
    releaseRefresh()
    const results = await Promise.all([first, second])

    expect(refreshCalls).toBe(1)
    expect(results.map((result) => result.auth.access)).toEqual(['new-access', 'new-access'])
    expect(acc.accessToken).toBe('new-access')
  })

  test('installs and immediately uses synced credentials when the account ID changed', async () => {
    const acc: ManagedAccount = {
      ...account(),
      profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ABC'
    }
    const replacement: ManagedAccount = {
      ...acc,
      id: 'replacement-id',
      accessToken: 'recovered-access',
      expiresAt: Date.now() + 3600000
    }
    const managed: ManagedAccount[] = [acc]
    const manager = {
      getAccounts: () => managed,
      updateFromAuth: () => {},
      toAuthDetails: auth,
      markUnhealthy: () => {},
      removeAccount: (target: ManagedAccount) => {
        const index = managed.indexOf(target)
        if (index >= 0) managed.splice(index, 1)
      },
      addAccount: (target: ManagedAccount) => managed.push(target)
    }
    const repository = {
      batchSave: async () => {},
      invalidateCache: () => {},
      findAll: async () => [acc, replacement]
    }
    const refresher = new TokenRefresher(
      {
        token_expiry_buffer_ms: 300000,
        auto_sync_kiro_cli: true,
        account_selection_strategy: 'sticky'
      },
      manager as any,
      async () => {},
      repository as any,
      async () => {
        throw new Error('refresh failed')
      }
    )

    const result = await refresher.refreshIfNeeded(acc, auth(acc), () => {})

    expect(result.account).toBe(replacement)
    expect(result.auth.access).toBe('recovered-access')
    expect(result.shouldContinue).toBe(false)
    expect(managed).toEqual([replacement])
  })

  test('does not recover a different profile that only shares the OIDC client', async () => {
    const acc: ManagedAccount = {
      ...account(),
      clientId: 'shared-client',
      profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ONE'
    }
    const otherProfile: ManagedAccount = {
      ...acc,
      id: 'other-profile',
      profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/TWO',
      accessToken: 'other-access',
      expiresAt: Date.now() + 3600000
    }
    let markedUnhealthy = false
    const manager = {
      getAccounts: () => [acc],
      updateFromAuth: () => {},
      toAuthDetails: auth,
      markUnhealthy: () => {
        markedUnhealthy = true
      },
      removeAccount: () => {},
      addAccount: () => {}
    }
    const repository = {
      batchSave: async () => {},
      invalidateCache: () => {},
      findAll: async () => [acc, otherProfile]
    }
    const refresher = new TokenRefresher(
      {
        token_expiry_buffer_ms: 300000,
        auto_sync_kiro_cli: true,
        account_selection_strategy: 'sticky'
      },
      manager as any,
      async () => {},
      repository as any,
      async () => {
        throw new KiroTokenRefreshError('Invalid refresh token provided', 'InvalidTokenException')
      }
    )

    const result = await refresher.refreshIfNeeded(acc, auth(acc), () => {})

    expect(result.account).toBe(acc)
    expect(result.shouldContinue).toBe(true)
    expect(markedUnhealthy).toBe(true)
  })
})
