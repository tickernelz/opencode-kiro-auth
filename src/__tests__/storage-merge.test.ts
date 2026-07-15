import { describe, expect, test } from 'bun:test'
import Database from 'libsql'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mergeAccounts } from '../plugin/storage/locked-operations.js'
import { runMigrations } from '../plugin/storage/migrations.js'
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

  test('merges access freshness and refresh-token authority independently', () => {
    const now = Date.now()
    const [merged] = mergeAccounts(
      [
        account({
          refreshToken: 'fresh-refresh',
          refreshTokenUpdatedAt: 1000,
          accessToken: 'fresh-access',
          expiresAt: now + 7200000,
          usedCount: 100,
          limitCount: 2000,
          subscriptionPlan: 'KIRO PRO',
          lastSync: 1000,
          isHealthy: true
        })
      ],
      [
        account({
          refreshToken: 'rotated-refresh',
          refreshTokenUpdatedAt: 2000,
          accessToken: 'stale-access',
          expiresAt: now + 3600000,
          usedCount: 120,
          limitCount: 2500,
          subscriptionPlan: 'KIRO PRO+',
          lastSync: 2000
        })
      ]
    )

    expect(merged?.refreshToken).toBe('rotated-refresh')
    expect(merged?.accessToken).toBe('fresh-access')
    expect(merged?.expiresAt).toBe(now + 7200000)
    expect(merged?.usedCount).toBe(120)
    expect(merged?.limitCount).toBe(2500)
    expect(merged?.subscriptionPlan).toBe('KIRO PRO+')
    expect(merged?.lastSync).toBe(2000)
  })

  test('keeps a refresh token from a newer local refresh despite earlier access expiry', () => {
    const now = Date.now()
    const [merged] = mergeAccounts(
      [
        account({
          refreshToken: 'old-refresh',
          refreshTokenUpdatedAt: 3000,
          accessToken: 'longer-access',
          expiresAt: now + 7200000,
          lastUsed: 1000,
          lastSync: 3000
        })
      ],
      [
        account({
          refreshToken: 'rotated-refresh',
          refreshTokenUpdatedAt: 4000,
          accessToken: 'shorter-access',
          expiresAt: now + 3600000,
          lastUsed: 4000,
          lastSync: 2000
        })
      ]
    )

    expect(merged?.refreshToken).toBe('rotated-refresh')
    expect(merged?.accessToken).toBe('longer-access')
    expect(merged?.expiresAt).toBe(now + 7200000)
  })

  test('keeps a locally rotated refresh token when stale CLI credentials are observed later', () => {
    const now = Date.now()
    const [merged] = mergeAccounts(
      [
        account({
          refreshToken: 'local-refresh',
          refreshTokenUpdatedAt: now,
          accessToken: 'local-access',
          expiresAt: now + 7200000
        })
      ],
      [
        account({
          refreshToken: 'stale-cli-refresh',
          refreshTokenUpdatedAt: now,
          accessToken: 'stale-cli-access',
          expiresAt: now + 3600000
        })
      ]
    )

    expect(merged?.refreshToken).toBe('local-refresh')
    expect(merged?.accessToken).toBe('local-access')
  })

  test('does not let a failed usage fetch (newer 0/0 snapshot) clobber real quota', () => {
    const [merged] = mergeAccounts(
      [account({ usedCount: 120.5, limitCount: 2000, lastSync: 1000 })],
      [account({ usedCount: 0, limitCount: 0, lastSync: 2000 })]
    )

    expect(merged?.usedCount).toBe(120.5)
    expect(merged?.limitCount).toBe(2000)
  })

  test('fills empty existing quota from a newer real snapshot', () => {
    const [merged] = mergeAccounts(
      [account({ usedCount: 0, limitCount: 0, lastSync: 1000 })],
      [account({ usedCount: 5, limitCount: 2000, lastSync: 2000 })]
    )

    expect(merged?.usedCount).toBe(5)
    expect(merged?.limitCount).toBe(2000)
  })
})

describe('account storage migrations', () => {
  test('adds the refresh-token authority timestamp idempotently', () => {
    const db = new Database(':memory:')
    db.exec(`
      CREATE TABLE accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, auth_method TEXT NOT NULL,
        region TEXT NOT NULL, oidc_region TEXT, client_id TEXT, client_secret TEXT,
        profile_arn TEXT, start_url TEXT, refresh_token TEXT NOT NULL,
        access_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
        rate_limit_reset INTEGER DEFAULT 0, is_healthy INTEGER DEFAULT 1,
        unhealthy_reason TEXT, recovery_time INTEGER, fail_count INTEGER DEFAULT 0,
        last_used INTEGER DEFAULT 0, used_count REAL DEFAULT 0,
        limit_count REAL DEFAULT 0, subscription_plan TEXT, last_sync INTEGER DEFAULT 0
      )
    `)

    runMigrations(db)
    runMigrations(db)

    const columns = db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>
    expect(columns.filter((column) => column.name === 'refresh_token_updated_at')).toHaveLength(1)
    db.close()
  })

  test('serializes concurrent database initialization across processes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-db-init-'))
    const path = join(dir, 'kiro.db')
    const worker = new URL('./database-init-worker.ts', import.meta.url).pathname

    try {
      const processes = Array.from({ length: 8 }, () =>
        Bun.spawn([process.execPath, worker, path], { stdout: 'pipe', stderr: 'pipe' })
      )
      const exitCodes = await Promise.all(processes.map((process) => process.exited))

      expect(exitCodes).toEqual(Array(8).fill(0))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
