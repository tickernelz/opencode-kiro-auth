import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatRequestQuota,
  getSessionProviderID,
  readUsageSnapshot,
  resolveTuiDisplayOptions,
  shouldShowKiroUsage,
  summarizeUsage
} from '../tui-usage.js'

const tempDirs: string[] = []

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-usage-test-'))
  tempDirs.push(dir)
  return join(dir, 'kiro.db')
}

function createAccountsTable(db: Database, withSubscriptionPlan = true): void {
  db.run(`
    CREATE TABLE accounts (
      id TEXT PRIMARY KEY,
      email TEXT NOT NULL,
      auth_method TEXT NOT NULL,
      region TEXT NOT NULL,
      used_count REAL,
      limit_count REAL,
      ${withSubscriptionPlan ? 'subscription_plan TEXT,' : ''}
      is_healthy INTEGER,
      last_sync INTEGER,
      last_used INTEGER
    )
  `)
}

describe('TUI usage data', () => {
  test('reads current quota and subscription plan from the Kiro database', () => {
    const dbPath = tempDbPath()
    const db = new Database(dbPath)
    createAccountsTable(db)
    db.run(
      `INSERT INTO accounts
       (id, email, auth_method, region, used_count, limit_count, subscription_plan, is_healthy, last_sync, last_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['a', 'user@example.com', 'idc', 'us-east-1', 164.127, 2000, 'KIRO PRO+', 1, 1000, 2000]
    )
    db.close()

    const snapshot = readUsageSnapshot(dbPath)
    const summary = summarizeUsage(snapshot)

    expect(snapshot.error).toBeUndefined()
    expect(summary.account?.email).toBe('user@example.com')
    expect(summary.plan).toBe('KIRO PRO+')
    expect(summary.used).toBe(164.127)
    expect(summary.limit).toBe(2000)
    expect(formatRequestQuota(summary)).toBe('Credits: 164.13 / 2000')
  })

  test('keeps legacy databases without subscription_plan readable', () => {
    const dbPath = tempDbPath()
    const db = new Database(dbPath)
    createAccountsTable(db, false)
    db.run(
      `INSERT INTO accounts
       (id, email, auth_method, region, used_count, limit_count, is_healthy, last_sync, last_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ['a', 'legacy@example.com', 'idc', 'us-east-1', 10, 100, 1, 1000, 2000]
    )
    db.close()

    const summary = summarizeUsage(readUsageSnapshot(dbPath))

    expect(summary.account?.email).toBe('legacy@example.com')
    expect(summary.plan).toBe('Q Developer')
    expect(formatRequestQuota(summary)).toBe('Credits: 10.00 / 100')
  })

  test('uses the first healthy account for sidebar usage', () => {
    const dbPath = tempDbPath()
    const db = new Database(dbPath)
    createAccountsTable(db)
    const insert = db.prepare(
      `INSERT INTO accounts
       (id, email, auth_method, region, used_count, limit_count, subscription_plan, is_healthy, last_sync, last_used)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    insert.run(
      'newer-unhealthy',
      'bad@example.com',
      'idc',
      'us-east-1',
      90,
      100,
      'PRO',
      0,
      1000,
      3000
    )
    insert.run(
      'older-healthy',
      'good@example.com',
      'idc',
      'us-east-1',
      20,
      100,
      'KIRO PRO+',
      1,
      1000,
      2000
    )
    db.close()

    const summary = summarizeUsage(readUsageSnapshot(dbPath))

    expect(summary.account?.email).toBe('good@example.com')
    expect(summary.plan).toBe('KIRO PRO+')
    expect(formatRequestQuota(summary)).toBe('Credits: 20.00 / 100')
  })

  test('formats request quota without a limit', () => {
    const summary = summarizeUsage({
      accounts: [
        {
          email: 'usage@example.com',
          authMethod: 'builder',
          region: 'us-east-1',
          usedCount: 42,
          limitCount: 0,
          subscriptionPlan: 'FREE',
          isHealthy: true,
          lastSync: 0,
          lastUsed: 0
        }
      ]
    })

    expect(formatRequestQuota(summary)).toBe('Credits: 42.00')
  })

  test('detects whether the sidebar belongs to a Kiro session', () => {
    expect(
      shouldShowKiroUsage([{ providerID: 'anthropic' }, { providerID: 'kiro' }], 'anthropic/claude')
    ).toBe(true)
    expect(shouldShowKiroUsage([{ model: { providerID: 'anthropic' } }], 'kiro/claude')).toBe(false)
    expect(shouldShowKiroUsage([], 'kiro/claude-sonnet-4-6')).toBe(true)
    expect(shouldShowKiroUsage([], 'anthropic/claude-sonnet-4-6')).toBe(false)
    expect(getSessionProviderID([{ info: { providerID: 'kiro' } }])).toBe('kiro')
  })

  test('returns an empty snapshot for missing databases', () => {
    const snapshot = readUsageSnapshot(join(tempDbPath(), 'missing.db'))

    expect(snapshot).toEqual({ accounts: [] })
  })

  test('resolves TUI display options with compact defaults', () => {
    expect(resolveTuiDisplayOptions()).toEqual({
      showAccountEmail: false,
      showPlan: true,
      showCredits: true
    })

    expect(
      resolveTuiDisplayOptions({
        show_account_email: true,
        show_plan: false,
        show_credits: false
      })
    ).toEqual({
      showAccountEmail: true,
      showPlan: false,
      showCredits: false
    })
  })
})
