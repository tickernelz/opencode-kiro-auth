import { describe, expect, mock, test } from 'bun:test'

mock.module('../plugin/sync/kiro-cli.js', () => ({
  syncFromKiroCli: () => Promise.resolve(),
  writeToKiroCli: () => Promise.resolve()
}))
mock.module('../kiro/auth.js', () => ({
  decodeRefreshToken: (t: string) => ({ refreshToken: t }),
  encodeRefreshToken: (p: any) => p.refreshToken,
  accessTokenExpired: () => false
}))

import { AuthHandler } from '../core/auth/auth-handler.js'
import type { KiroAuthDetails, ManagedAccount } from '../plugin/types.js'

function makeAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'acc-1',
    email: 'test@example.com',
    authMethod: 'idc',
    region: 'eu-central-1',
    refreshToken: 'r',
    accessToken: 'a',
    expiresAt: Date.now() + 3600000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    lastUsed: 0,
    usedCount: 0,
    limitCount: 0,
    ...overrides
  }
}

function makeAuth(): KiroAuthDetails {
  return {
    refresh: 'refresh-token',
    access: 'access-token',
    expires: Date.now() + 3600000, // not expired -> no refresh attempted
    authMethod: 'idc',
    region: 'eu-central-1',
    profileArn: 'arn:aws:codewhisperer:eu-central-1:000000:profile/ABC'
  }
}

function makeManager(acc: ManagedAccount) {
  return {
    getAccounts: () => [acc],
    toAuthDetails: () => makeAuth(),
    updateUsage: () => {}
  }
}

const fakeRepo: any = {
  batchSave: async () => {},
  invalidateCache: () => {},
  findAll: async () => []
}

const CREDIT_RESPONSE = JSON.stringify({
  usageBreakdownList: [
    {
      freeTrialInfo: null,
      currentUsage: 70,
      currentUsageWithPrecision: 70.45,
      usageLimit: 10000,
      usageLimitWithPrecision: 10000,
      displayNamePlural: 'Credits',
      resourceType: 'CREDIT'
    }
  ],
  userInfo: { email: 'test@example.com' }
})

describe('AuthHandler.refreshUsageFromApi', () => {
  test('fetches live usage and updates the account with dashboard credits', async () => {
    const acc = makeAccount({ usedCount: 4292, limitCount: 10000 }) // stale prior-period value
    const handler = new AuthHandler(
      { usage_tracking_enabled: true, token_expiry_buffer_ms: 300000, auto_sync_kiro_cli: false },
      fakeRepo
    )
    handler.setAccountManager(makeManager(acc))

    const original = globalThis.fetch
    globalThis.fetch = mock(async () => new Response(CREDIT_RESPONSE, { status: 200 })) as any
    try {
      await handler.refreshUsageFromApi()
      expect(acc.usedCount).toBe(70.45)
      expect(acc.limitCount).toBe(10000)
    } finally {
      globalThis.fetch = original
    }
  })

  test('keeps stored value when the live fetch fails', async () => {
    const acc = makeAccount({ usedCount: 70.45, limitCount: 10000 })
    const handler = new AuthHandler(
      { usage_tracking_enabled: true, token_expiry_buffer_ms: 300000, auto_sync_kiro_cli: false },
      fakeRepo
    )
    handler.setAccountManager(makeManager(acc))

    const original = globalThis.fetch
    globalThis.fetch = mock(async () => new Response('boom', { status: 500 })) as any
    try {
      await handler.refreshUsageFromApi()
      expect(acc.usedCount).toBe(70.45) // unchanged
    } finally {
      globalThis.fetch = original
    }
  })

  test('is a one-time guard (skips the second call)', async () => {
    const acc = makeAccount()
    const handler = new AuthHandler(
      { usage_tracking_enabled: true, token_expiry_buffer_ms: 300000, auto_sync_kiro_cli: false },
      fakeRepo
    )
    handler.setAccountManager(makeManager(acc))

    let calls = 0
    const original = globalThis.fetch
    globalThis.fetch = mock(async () => {
      calls++
      return new Response(CREDIT_RESPONSE, { status: 200 })
    }) as any
    try {
      await handler.refreshUsageFromApi()
      await handler.refreshUsageFromApi()
      expect(calls).toBe(1)
    } finally {
      globalThis.fetch = original
    }
  })
})
