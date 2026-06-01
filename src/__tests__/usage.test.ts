import { describe, expect, mock, test } from 'bun:test'
import type { KiroAuthDetails, ManagedAccount } from '../plugin/types.js'
import { fetchUsageLimits, updateAccountQuota } from '../plugin/usage.js'

function makeAuth(overrides: Partial<KiroAuthDetails> = {}): KiroAuthDetails {
  return {
    refresh: 'refresh-token',
    access: 'access-token',
    expires: Date.now() + 3600000,
    authMethod: 'idc',
    region: 'eu-central-1',
    profileArn: 'arn:aws:codewhisperer:eu-central-1:000000:profile/ABC',
    ...overrides
  }
}

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

// ── updateAccountQuota ────────────────────────────────────────────────────────

describe('updateAccountQuota', () => {
  test('updates usedCount and limitCount on account', () => {
    const acc = makeAccount()
    updateAccountQuota(acc, { usedCount: 150, limitCount: 2000 })
    expect(acc.usedCount).toBe(150)
    expect(acc.limitCount).toBe(2000)
  })

  test('updates email when provided', () => {
    const acc = makeAccount({ email: 'old@example.com' })
    updateAccountQuota(acc, { usedCount: 0, limitCount: 0, email: 'new@example.com' })
    expect(acc.email).toBe('new@example.com')
  })

  test('does not update email when not provided', () => {
    const acc = makeAccount({ email: 'keep@example.com' })
    updateAccountQuota(acc, { usedCount: 5, limitCount: 100 })
    expect(acc.email).toBe('keep@example.com')
  })

  test('calls accountManager.updateUsage when provided', () => {
    const acc = makeAccount()
    const calls: any[] = []
    const mgr = { updateUsage: (id: string, meta: any) => calls.push({ id, meta }) }
    updateAccountQuota(acc, { usedCount: 10, limitCount: 50 }, mgr)
    expect(calls).toHaveLength(1)
    expect(calls[0].id).toBe('acc-1')
    expect(calls[0].meta.usedCount).toBe(10)
    expect(calls[0].meta.limitCount).toBe(50)
  })

  test('handles missing usedCount/limitCount gracefully', () => {
    const acc = makeAccount()
    updateAccountQuota(acc, {})
    expect(acc.usedCount).toBe(0)
    expect(acc.limitCount).toBe(0)
  })
})

// ── fetchUsageLimits ──────────────────────────────────────────────────────────

describe('fetchUsageLimits', () => {
  test('returns usedCount and limitCount from usageBreakdownList', async () => {
    const mockFetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            usageBreakdownList: [
              {
                freeTrialInfo: { currentUsage: 100, usageLimit: 1000 },
                currentUsage: 50,
                usageLimit: 500
              }
            ],
            userInfo: { email: 'test@example.com' }
          }),
          { status: 200 }
        )
    )
    const original = globalThis.fetch
    globalThis.fetch = mockFetch as any
    try {
      const result = await fetchUsageLimits(makeAuth())
      expect(result.usedCount).toBe(150) // 100 + 50
      expect(result.limitCount).toBe(1500) // 1000 + 500
      expect(result.email).toBe('test@example.com')
    } finally {
      globalThis.fetch = original
    }
  })

  test('prefers WithPrecision fields (matches Kiro dashboard credits)', async () => {
    // Mirrors the real Kiro Power getUsageLimits response: the integer
    // currentUsage is rounded, the dashboard shows currentUsageWithPrecision.
    const mockFetch = mock(
      async () =>
        new Response(
          JSON.stringify({
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
          }),
          { status: 200 }
        )
    )
    const original = globalThis.fetch
    globalThis.fetch = mockFetch as any
    try {
      const result = await fetchUsageLimits(makeAuth())
      expect(result.usedCount).toBe(70.45)
      expect(result.limitCount).toBe(10000)
    } finally {
      globalThis.fetch = original
    }
  })

  test('falls back to integer fields when precision absent', async () => {
    const mockFetch = mock(
      async () =>
        new Response(
          JSON.stringify({
            usageBreakdownList: [{ currentUsage: 50, usageLimit: 500 }],
            userInfo: { email: 'test@example.com' }
          }),
          { status: 200 }
        )
    )
    const original = globalThis.fetch
    globalThis.fetch = mockFetch as any
    try {
      const result = await fetchUsageLimits(makeAuth())
      expect(result.usedCount).toBe(50)
      expect(result.limitCount).toBe(500)
    } finally {
      globalThis.fetch = original
    }
  })

  test('retries on FEATURE_NOT_SUPPORTED and succeeds on later attempt', async () => {
    let callCount = 0
    const mockFetch = mock(async () => {
      callCount++
      if (callCount < 3) {
        return new Response('FEATURE_NOT_SUPPORTED', { status: 400 })
      }
      return new Response(JSON.stringify({ usageBreakdownList: [], userInfo: {} }), { status: 200 })
    })
    const original = globalThis.fetch
    globalThis.fetch = mockFetch as any
    try {
      const result = await fetchUsageLimits(makeAuth())
      expect(callCount).toBeGreaterThanOrEqual(3)
      expect(result.usedCount).toBe(0)
    } finally {
      globalThis.fetch = original
    }
  })

  test('throws when all attempts fail', async () => {
    const mockFetch = mock(async () => new Response('Server Error', { status: 500 }))
    const original = globalThis.fetch
    globalThis.fetch = mockFetch as any
    try {
      await expect(fetchUsageLimits(makeAuth())).rejects.toThrow()
    } finally {
      globalThis.fetch = original
    }
  })

  test('does NOT chain to next param combo on 429 (rate limit)', async () => {
    let callCount = 0
    const mockFetch = mock(async () => {
      callCount++
      return new Response(JSON.stringify({ message: 'rate limited' }), {
        status: 429,
        headers: { 'x-amzn-errortype': 'ThrottlingException' }
      })
    })
    const original = globalThis.fetch
    globalThis.fetch = mockFetch as any
    try {
      await expect(fetchUsageLimits(makeAuth())).rejects.toThrow(/429|Throttling/i)
      // Old behaviour would call all 4 attempts. New behaviour stops at 1.
      expect(callCount).toBe(1)
    } finally {
      globalThis.fetch = original
    }
  })

  test('does NOT chain to next param combo on 401', async () => {
    let callCount = 0
    const mockFetch = mock(async () => {
      callCount++
      return new Response(JSON.stringify({ message: 'unauthorized' }), { status: 401 })
    })
    const original = globalThis.fetch
    globalThis.fetch = mockFetch as any
    try {
      await expect(fetchUsageLimits(makeAuth())).rejects.toThrow(/401/)
      expect(callCount).toBe(1)
    } finally {
      globalThis.fetch = original
    }
  })

  test('does NOT retry on network error across all combos', async () => {
    let callCount = 0
    const mockFetch = mock(async () => {
      callCount++
      throw new Error('fetch failed: ECONNRESET')
    })
    const original = globalThis.fetch
    globalThis.fetch = mockFetch as any
    try {
      await expect(fetchUsageLimits(makeAuth())).rejects.toThrow(/ECONNRESET/)
      expect(callCount).toBe(1)
    } finally {
      globalThis.fetch = original
    }
  })
})
