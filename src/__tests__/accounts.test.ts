import { describe, expect, mock, test } from 'bun:test'
import { AccountManager, createDeterministicAccountId } from '../plugin/accounts.js'
import type { ManagedAccount } from '../plugin/types.js'

// Mock DB and external dependencies
mock.module('../plugin/storage/sqlite.js', () => ({
  kiroDb: {
    getAccounts: () => [],
    upsertAccount: () => Promise.resolve(),
    deleteAccount: () => Promise.resolve(),
    batchUpsertAccounts: () => Promise.resolve()
  }
}))
mock.module('../plugin/sync/kiro-cli.js', () => ({
  syncFromKiroCli: () => Promise.resolve(),
  writeToKiroCli: () => Promise.resolve()
}))
mock.module('../kiro/auth.js', () => ({
  decodeRefreshToken: (t: string) => ({ refreshToken: t }),
  encodeRefreshToken: (p: any) => p.refreshToken,
  accessTokenExpired: () => false
}))

function makeAccount(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: 'test-id',
    email: 'test@example.com',
    authMethod: 'idc',
    region: 'eu-central-1',
    refreshToken: 'refresh',
    accessToken: 'access',
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

// ── createDeterministicAccountId ──────────────────────────────────────────────

describe('createDeterministicAccountId', () => {
  test('IDC uses email + method + profileArn, ignores clientId', () => {
    const id1 = createDeterministicAccountId('a@b.com', 'idc', 'client-1', 'arn:aws:123')
    const id2 = createDeterministicAccountId('a@b.com', 'idc', 'client-2', 'arn:aws:123')
    expect(id1).toBe(id2)
  })

  test('non-IDC uses email + method + clientId + profileArn', () => {
    const id1 = createDeterministicAccountId('a@b.com', 'builderid', 'client-1')
    const id2 = createDeterministicAccountId('a@b.com', 'builderid', 'client-2')
    expect(id1).not.toBe(id2)
  })

  test('different emails produce different IDs', () => {
    const id1 = createDeterministicAccountId('a@b.com', 'idc', 'c', 'arn')
    const id2 = createDeterministicAccountId('x@b.com', 'idc', 'c', 'arn')
    expect(id1).not.toBe(id2)
  })

  test('returns 64-char hex string', () => {
    const id = createDeterministicAccountId('a@b.com', 'idc', 'c', 'arn')
    expect(id).toMatch(/^[a-f0-9]{64}$/)
  })
})

// ── AccountManager ────────────────────────────────────────────────────────────

describe('AccountManager.getCurrentOrNext', () => {
  test('returns healthy account', () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    expect(mgr.getCurrentOrNext()).not.toBeNull()
  })

  test('returns null when no accounts', () => {
    expect(new AccountManager([]).getCurrentOrNext()).toBeNull()
  })

  test('skips permanently unhealthy accounts', () => {
    const acc = makeAccount({ isHealthy: false, unhealthyReason: 'HTTP_403', failCount: 10 })
    expect(new AccountManager([acc]).getCurrentOrNext()).toBeNull()
  })

  test('skips rate-limited accounts', () => {
    const acc = makeAccount({ rateLimitResetTime: Date.now() + 60000 })
    expect(new AccountManager([acc]).getCurrentOrNext()).toBeNull()
  })

  test('recovers unhealthy account past recoveryTime', () => {
    const acc = makeAccount({
      isHealthy: false,
      unhealthyReason: 'temporary',
      failCount: 3,
      recoveryTime: Date.now() - 1000
    })
    const mgr = new AccountManager([acc])
    const selected = mgr.getCurrentOrNext()
    expect(selected).not.toBeNull()
    expect(selected!.isHealthy).toBe(true)
  })

  test('does NOT recover permanently unhealthy account past recoveryTime', () => {
    const acc = makeAccount({
      isHealthy: false,
      unhealthyReason: 'HTTP_403',
      failCount: 10,
      recoveryTime: Date.now() - 1000
    })
    expect(new AccountManager([acc]).getCurrentOrNext()).toBeNull()
  })

  test('increments usedCount and sets lastUsed on selection', () => {
    const acc = makeAccount({ usedCount: 5 })
    const mgr = new AccountManager([acc])
    mgr.getCurrentOrNext()
    expect(acc.usedCount).toBe(6)
    expect(acc.lastUsed).toBeGreaterThan(0)
  })

  test('round-robin cycles through multiple accounts', () => {
    const a = makeAccount({ id: 'a', email: 'a@x.com' })
    const b = makeAccount({ id: 'b', email: 'b@x.com' })
    const mgr = new AccountManager([a, b], 'round-robin')
    const first = mgr.getCurrentOrNext()
    const second = mgr.getCurrentOrNext()
    expect(first!.id).not.toBe(second!.id)
  })

  test('round-robin skips rate-limited account and resumes correct position', () => {
    const a = makeAccount({ id: 'a', email: 'a@x.com' })
    const b = makeAccount({ id: 'b', email: 'b@x.com' })
    const c = makeAccount({ id: 'c', email: 'c@x.com' })
    const mgr = new AccountManager([a, b, c], 'round-robin')
    // a→b→c normal cycle
    expect(mgr.getCurrentOrNext()!.id).toBe('a')
    expect(mgr.getCurrentOrNext()!.id).toBe('b')
    // Now rate-limit b before the next call
    b.rateLimitResetTime = Date.now() + 60_000
    // cursor is at c — c is still available
    expect(mgr.getCurrentOrNext()!.id).toBe('c')
    // cursor wraps: a is next (b skipped)
    expect(mgr.getCurrentOrNext()!.id).toBe('a')
    // b's rate limit expires
    b.rateLimitResetTime = 0
    // cursor is at b — b is available again
    expect(mgr.getCurrentOrNext()!.id).toBe('b')
  })

  test('lowest-usage picks account with fewer usedCount', () => {
    const a = makeAccount({ id: 'a', email: 'a@x.com', usedCount: 10 })
    const b = makeAccount({ id: 'b', email: 'b@x.com', usedCount: 2 })
    const mgr = new AccountManager([a, b], 'lowest-usage')
    expect(mgr.getCurrentOrNext()!.id).toBe('b')
  })
})

describe('AccountManager.markUnhealthy', () => {
  test('permanent error sets isHealthy=false, failCount=10, no recoveryTime', () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    mgr.markUnhealthy(acc, 'ExpiredTokenException')
    expect(acc.isHealthy).toBe(false)
    expect(acc.failCount).toBe(10)
    expect(acc.recoveryTime).toBeUndefined()
  })

  test('non-permanent error increments failCount', () => {
    const acc = makeAccount({ failCount: 2 })
    const mgr = new AccountManager([acc])
    mgr.markUnhealthy(acc, 'Server Error')
    expect(acc.failCount).toBe(3)
    expect(acc.isHealthy).toBe(true)
  })

  test('non-permanent error sets isHealthy=false after 10 failures', () => {
    const acc = makeAccount({ failCount: 9 })
    const mgr = new AccountManager([acc])
    mgr.markUnhealthy(acc, 'Server Error')
    expect(acc.failCount).toBe(10)
    expect(acc.isHealthy).toBe(false)
    expect(acc.recoveryTime).toBeGreaterThan(Date.now())
  })

  test('expired token exception is treated as permanent', () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    mgr.markUnhealthy(acc, 'ExpiredTokenException')
    expect(acc.isHealthy).toBe(false)
    expect(acc.failCount).toBe(10)
    expect(acc.recoveryTime).toBeUndefined()
  })

  test('does nothing for unknown account id', () => {
    const acc = makeAccount({ id: 'known' })
    const mgr = new AccountManager([acc])
    const unknown = makeAccount({ id: 'unknown' })
    mgr.markUnhealthy(unknown, 'HTTP_403')
    expect(acc.isHealthy).toBe(true) // unchanged
  })
})

describe('AccountManager.removeAccount', () => {
  test('removes account from list', () => {
    const a = makeAccount({ id: 'a' })
    const b = makeAccount({ id: 'b' })
    const mgr = new AccountManager([a, b])
    mgr.removeAccount(a)
    expect(mgr.getAccountCount()).toBe(1)
    expect(mgr.getAccounts()[0]!.id).toBe('b')
  })

  test('cursor resets to 0 when list becomes empty', () => {
    const a = makeAccount()
    const mgr = new AccountManager([a])
    mgr.removeAccount(a)
    expect(mgr.getAccountCount()).toBe(0)
    expect(mgr.getCurrentOrNext()).toBeNull()
  })

  test('ignores unknown account', () => {
    const a = makeAccount({ id: 'a' })
    const mgr = new AccountManager([a])
    mgr.removeAccount(makeAccount({ id: 'unknown' }))
    expect(mgr.getAccountCount()).toBe(1)
  })
})

describe('AccountManager.addAccount', () => {
  test('adds new account', () => {
    const mgr = new AccountManager([])
    mgr.addAccount(makeAccount({ id: 'new' }))
    expect(mgr.getAccountCount()).toBe(1)
  })

  test('replaces existing account with same id', () => {
    const original = makeAccount({ id: 'x', email: 'old@x.com' })
    const updated = makeAccount({ id: 'x', email: 'new@x.com' })
    const mgr = new AccountManager([original])
    mgr.addAccount(updated)
    expect(mgr.getAccountCount()).toBe(1)
    expect(mgr.getAccounts()[0]!.email).toBe('new@x.com')
  })
})

describe('AccountManager.getMinWaitTime', () => {
  test('returns 0 with no rate-limited accounts', () => {
    const mgr = new AccountManager([makeAccount()])
    expect(mgr.getMinWaitTime()).toBe(0)
  })

  test('returns minimum wait across rate-limited accounts', () => {
    const a = makeAccount({ id: 'a', rateLimitResetTime: Date.now() + 5000 })
    const b = makeAccount({ id: 'b', rateLimitResetTime: Date.now() + 10000 })
    const mgr = new AccountManager([a, b])
    expect(mgr.getMinWaitTime()).toBeGreaterThan(0)
    expect(mgr.getMinWaitTime()).toBeLessThanOrEqual(5000)
  })
})

// ── updateUsage ───────────────────────────────────────────────────────────────

describe('AccountManager.updateUsage', () => {
  test('updates usedCount and limitCount', () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    mgr.updateUsage(acc.id, { usedCount: 50, limitCount: 500 })
    expect(acc.usedCount).toBe(50)
    expect(acc.limitCount).toBe(500)
  })

  test('updates email when provided', () => {
    const acc = makeAccount({ email: 'old@example.com' })
    const mgr = new AccountManager([acc])
    mgr.updateUsage(acc.id, { usedCount: 0, limitCount: 0, email: 'new@example.com' })
    expect(acc.email).toBe('new@example.com')
  })

  test('resets failCount and marks healthy for non-permanent error', () => {
    const acc = makeAccount({ failCount: 5, isHealthy: false, unhealthyReason: 'transient' })
    const mgr = new AccountManager([acc])
    mgr.updateUsage(acc.id, { usedCount: 0, limitCount: 0 })
    expect(acc.failCount).toBe(0)
    expect(acc.isHealthy).toBe(true)
    expect(acc.unhealthyReason).toBeUndefined()
  })

  test('does not reset health for permanent error', () => {
    const acc = makeAccount({
      failCount: 10,
      isHealthy: false,
      unhealthyReason: 'ExpiredTokenException'
    })
    const mgr = new AccountManager([acc])
    mgr.updateUsage(acc.id, { usedCount: 0, limitCount: 0 })
    expect(acc.isHealthy).toBe(false)
  })

  test('no-ops on unknown id', () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    expect(() => mgr.updateUsage('unknown', { usedCount: 99, limitCount: 99 })).not.toThrow()
    expect(acc.usedCount).toBe(0) // unchanged
  })
})

// ── addAccount / removeAccount ─────────────────────────────────────────────────

describe('AccountManager.addAccount / removeAccount', () => {
  test('addAccount appends new account', () => {
    const mgr = new AccountManager([])
    const acc = makeAccount()
    mgr.addAccount(acc)
    expect(mgr.getAccountCount()).toBe(1)
  })

  test('addAccount replaces existing account with same id', () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    mgr.addAccount({ ...acc, email: 'updated@example.com' })
    expect(mgr.getAccountCount()).toBe(1)
    expect(mgr.getAccounts()[0]!.email).toBe('updated@example.com')
  })

  test('removeAccount removes the account', () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    mgr.removeAccount(acc)
    expect(mgr.getAccountCount()).toBe(0)
  })

  test('removeAccount is no-op for unknown account', () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    mgr.removeAccount(makeAccount({ id: 'unknown' }))
    expect(mgr.getAccountCount()).toBe(1)
  })

  test('cursor adjusts after removeAccount', () => {
    const a = makeAccount({ id: 'a' })
    const b = makeAccount({ id: 'b', email: 'b@example.com' })
    const mgr = new AccountManager([a, b])
    mgr.removeAccount(a)
    expect(mgr.getAccountCount()).toBe(1)
    // Should not throw selecting next account
    expect(mgr.getCurrentOrNext()).toBeDefined()
  })
})

// ── lowest-usage strategy ─────────────────────────────────────────────────────

describe('AccountManager: lowest-usage strategy', () => {
  test('selects account with lowest usedCount', () => {
    const a = makeAccount({ id: 'a', usedCount: 100 })
    const b = makeAccount({ id: 'b', email: 'b@example.com', usedCount: 10 })
    const mgr = new AccountManager([a, b], 'lowest-usage')
    const selected = mgr.getCurrentOrNext()
    expect(selected?.id).toBe('b')
  })

  test('breaks ties by lastUsed', () => {
    const a = makeAccount({ id: 'a', usedCount: 5, lastUsed: 1000 })
    const b = makeAccount({ id: 'b', email: 'b@example.com', usedCount: 5, lastUsed: 500 })
    const mgr = new AccountManager([a, b], 'lowest-usage')
    const selected = mgr.getCurrentOrNext()
    expect(selected?.id).toBe('b') // lower lastUsed = used less recently
  })
})

// ── markRateLimited ───────────────────────────────────────────────────────────

describe('AccountManager.markRateLimited', () => {
  test('sets rateLimitResetTime in the future', () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    mgr.markRateLimited(acc, 30000)
    expect(acc.rateLimitResetTime).toBeGreaterThan(Date.now())
  })

  test('rate-limited account is excluded from getCurrentOrNext', () => {
    const a = makeAccount({ id: 'a' })
    const mgr = new AccountManager([a])
    mgr.markRateLimited(a, 60000)
    expect(mgr.getCurrentOrNext()).toBeNull()
  })
})

// ── shouldShowToast / shouldShowUsageToast ─────────────────────────────────────

describe('AccountManager.shouldShowToast', () => {
  test('returns true on first call', () => {
    const mgr = new AccountManager([makeAccount()])
    expect(mgr.shouldShowToast()).toBe(true)
  })

  test('returns false within debounce window', () => {
    const mgr = new AccountManager([makeAccount()])
    mgr.shouldShowToast(5000)
    expect(mgr.shouldShowToast(5000)).toBe(false)
  })

  test('shouldShowUsageToast returns true on first call', () => {
    const mgr = new AccountManager([makeAccount()])
    expect(mgr.shouldShowUsageToast()).toBe(true)
  })
})

// ── recovery after unhealthy ──────────────────────────────────────────────────

describe('AccountManager: recovery from temporary unhealthy', () => {
  test('account with past recoveryTime becomes available again', () => {
    const acc = makeAccount({
      isHealthy: false,
      failCount: 3,
      recoveryTime: Date.now() - 1000 // past
    })
    const mgr = new AccountManager([acc])
    const selected = mgr.getCurrentOrNext()
    expect(selected).not.toBeNull()
    expect(acc.isHealthy).toBe(true)
  })

  test('account with future recoveryTime is not returned (respects the wait)', () => {
    const acc = makeAccount({
      isHealthy: false,
      failCount: 3,
      recoveryTime: Date.now() + 3_600_000
    })
    const mgr = new AccountManager([acc])
    expect(mgr.getCurrentOrNext()).toBeNull()
  })

  test('fallback returns unhealthy account with no recoveryTime (limbo state)', () => {
    // An account can end up isHealthy=false with no recoveryTime due to incremental
    // failCount increases that haven't yet hit the threshold. The fallback rescues it.
    const acc = makeAccount({
      isHealthy: false,
      failCount: 3
      // no recoveryTime
    })
    const mgr = new AccountManager([acc])
    const selected = mgr.getCurrentOrNext()
    expect(selected).not.toBeNull()
    expect(acc.isHealthy).toBe(true)
    expect(acc.recoveryTime).toBeUndefined()
  })

  test('permanently unhealthy account is never returned', () => {
    const acc = makeAccount({
      isHealthy: false,
      failCount: 10,
      unhealthyReason: 'bearer token included in the request is invalid'
    })
    const mgr = new AccountManager([acc])
    expect(mgr.getCurrentOrNext()).toBeNull()
  })
})
