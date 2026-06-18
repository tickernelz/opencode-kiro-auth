import { describe, expect, mock, test } from 'bun:test'
import { ErrorHandler } from '../core/request/error-handler.js'
import { AccountManager } from '../plugin/accounts.js'
import type { ManagedAccount } from '../plugin/types.js'

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

const defaultConfig = { rate_limit_max_retries: 3, rate_limit_retry_delay_ms: 100 }
const noToast = () => {}

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

function makeRepo(accounts: ManagedAccount[]) {
  return {
    findAll: async () => accounts,
    batchSave: async () => {},
    save: async () => {},
    invalidateCache: () => {}
  } as any
}

function makeResponse(status: number, body: any, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers }
  })
}

// ── 400 ───────────────────────────────────────────────────────────────────────

describe('ErrorHandler: 400', () => {
  test('returns shouldRetry=false', async () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    const handler = new ErrorHandler(defaultConfig, mgr, makeRepo([acc]))
    const res = makeResponse(400, { message: 'Bad Request' })
    const result = await handler.handle(null, res, acc, { retry: 0 }, noToast)
    expect(result.shouldRetry).toBe(false)
  })
})

// ── 401 ───────────────────────────────────────────────────────────────────────

describe('ErrorHandler: 401', () => {
  test('retries when under max retries', async () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    const handler = new ErrorHandler(defaultConfig, mgr, makeRepo([acc]))
    const res = makeResponse(401, { message: 'Unauthorized' })
    const result = await handler.handle(null, res, acc, { retry: 0 }, noToast)
    expect(result.shouldRetry).toBe(true)
    expect(result.newContext?.retry).toBe(1)
  })

  test('stops retrying at max retries', async () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    const handler = new ErrorHandler(defaultConfig, mgr, makeRepo([acc]))
    const res = makeResponse(401, { message: 'Unauthorized' })
    const result = await handler.handle(null, res, acc, { retry: 3 }, noToast)
    expect(result.shouldRetry).toBe(false)
  })
})

// ── 403 single account ────────────────────────────────────────────────────────

describe('ErrorHandler: 403 single account', () => {
  test('bearer token invalid 403 forces token refresh (sets expiresAt=0) and retries', async () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    const handler = new ErrorHandler(defaultConfig, mgr, makeRepo([acc]))
    const res = makeResponse(403, {
      message: 'The bearer token included in the request is invalid'
    })
    const result = await handler.handle(null, res, acc, { retry: 0 }, noToast)
    // Should retry so the token refresher can get a fresh token
    expect(result.shouldRetry).toBe(true)
    // Account stays healthy — refresh will handle it
    expect(acc.isHealthy).toBe(true)
    // expiresAt zeroed so refreshIfNeeded triggers on next iteration
    expect(acc.expiresAt).toBe(0)
  })

  test('TEMPORARILY_SUSPENDED marks account unhealthy', async () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    const handler = new ErrorHandler(defaultConfig, mgr, makeRepo([acc]))
    const res = makeResponse(403, { reason: 'TEMPORARILY_SUSPENDED', message: 'Suspended' })
    const result = await handler.handle(null, res, acc, { retry: 0 }, noToast)
    expect(result.shouldRetry).toBe(false)
    expect(acc.isHealthy).toBe(false)
  })

  test('non-permanent 403 retries with backoff', async () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    const handler = new ErrorHandler(defaultConfig, mgr, makeRepo([acc]))
    const res = makeResponse(403, { message: 'Forbidden' })
    const result = await handler.handle(null, res, acc, { retry: 0 }, noToast)
    expect(result.shouldRetry).toBe(true)
    expect(result.newContext?.retry).toBe(1)
  })

  test('INVALID_MODEL_ID throws immediately', async () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    const handler = new ErrorHandler(defaultConfig, mgr, makeRepo([acc]))
    const res = makeResponse(403, { reason: 'INVALID_MODEL_ID', message: 'bad model' })
    await expect(handler.handle(null, res, acc, { retry: 0 }, noToast)).rejects.toThrow(
      'Invalid model: bad model'
    )
  })
})

// ── 403 multi account ─────────────────────────────────────────────────────────

describe('ErrorHandler: 403 multi account', () => {
  test('switches account on any 403, increments failCount', async () => {
    const a = makeAccount({ id: 'a' })
    const b = makeAccount({ id: 'b', email: 'b@example.com' })
    const mgr = new AccountManager([a, b])
    const handler = new ErrorHandler(defaultConfig, mgr, makeRepo([a, b]))
    const res = makeResponse(403, { message: 'Forbidden' })
    const result = await handler.handle(null, res, a, { retry: 0 }, noToast)
    expect(result.shouldRetry).toBe(true)
    expect(result.switchAccount).toBe(true)
    // non-permanent 403: failCount incremented but account still available
    expect(a.failCount).toBe(1)
    expect(a.isHealthy).toBe(true)
  })
})

// ── 429 ───────────────────────────────────────────────────────────────────────

describe('ErrorHandler: 429', () => {
  test('marks account rate-limited', async () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    const handler = new ErrorHandler(defaultConfig, mgr, makeRepo([acc]))
    const res = new Response('', {
      status: 429,
      headers: { 'retry-after': '1' } // 1s not 30s
    })
    const result = await handler.handle(null, res, acc, { retry: 0 }, noToast)
    expect(result.shouldRetry).toBe(true)
    expect(acc.rateLimitResetTime).toBeGreaterThan(Date.now() - 100)
  })

  test('with single account, sleep is excluded from request timeout budget', async () => {
    const acc = makeAccount()
    const mgr = new AccountManager([acc])
    const handler = new ErrorHandler(defaultConfig, mgr, makeRepo([acc]))
    const res = new Response('', {
      status: 429,
      headers: { 'retry-after': '1' } // 1s sleep
    })
    const result = await handler.handle(null, res, acc, { retry: 0 }, noToast)
    expect(result.shouldRetry).toBe(true)
    expect(result.newContext?.excludedMs).toBeGreaterThanOrEqual(1000)
  })

  test('with multiple accounts, switches without sleeping', async () => {
    const acc1 = makeAccount({ id: 'a' })
    const acc2 = makeAccount({ id: 'b' })
    const mgr = new AccountManager([acc1, acc2])
    const handler = new ErrorHandler(defaultConfig, mgr, makeRepo([acc1, acc2]))
    const res = new Response('', { status: 429, headers: { 'retry-after': '60' } })
    const start = Date.now()
    const result = await handler.handle(null, res, acc1, { retry: 0 }, noToast)
    const elapsed = Date.now() - start
    expect(result.switchAccount).toBe(true)
    expect(elapsed).toBeLessThan(500) // didn't sleep
  })
})

// ── 500 ───────────────────────────────────────────────────────────────────────

describe('ErrorHandler: 500', () => {
  test('retries with backoff on first failure', async () => {
    const acc = makeAccount({ failCount: 0 })
    const mgr = new AccountManager([acc])
    const handler = new ErrorHandler(defaultConfig, mgr, makeRepo([acc]))
    const res = makeResponse(500, { message: 'Internal Server Error' })
    const result = await handler.handle(null, res, acc, { retry: 0 }, noToast)
    expect(result.shouldRetry).toBe(true)
    expect(acc.failCount).toBe(1)
  })

  test('marks unhealthy after 5 failures', async () => {
    const acc = makeAccount({ failCount: 4 })
    const mgr = new AccountManager([acc])
    const handler = new ErrorHandler(defaultConfig, mgr, makeRepo([acc]))
    const res = makeResponse(500, { message: 'Internal Server Error' })
    const result = await handler.handle(null, res, acc, { retry: 0 }, noToast)
    expect(result.switchAccount).toBe(true)
    expect(acc.isHealthy).toBe(false)
  })
})
