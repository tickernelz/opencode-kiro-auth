import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KiroDatabase } from '../plugin/storage/sqlite.js'
import type { ManagedAccount } from '../plugin/types.js'

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

let dir: string
let dbPath: string
let db: KiroDatabase

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kiro-test-'))
  dbPath = join(dir, 'test.db')
  db = new KiroDatabase(dbPath)
})

afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// ── accounts CRUD ─────────────────────────────────────────────────────────────

describe('KiroDatabase: accounts', () => {
  test('starts empty', () => {
    expect(db.getAccounts()).toHaveLength(0)
  })

  test('upsertAccount stores and retrieves account', async () => {
    const acc = makeAccount()
    await db.upsertAccount(acc)
    const rows = db.getAccounts()
    expect(rows).toHaveLength(1)
    expect(rows[0].email).toBe('test@example.com')
    expect(rows[0].is_healthy).toBe(1)
  })

  test('upsertAccount updates token fields on existing account', async () => {
    const acc = makeAccount()
    await db.upsertAccount(acc)
    await db.upsertAccount({ ...acc, accessToken: 'new-token' })
    const rows = db.getAccounts()
    expect(rows).toHaveLength(1)
    expect(rows[0].access_token).toBe('new-token')
  })

  test('upsertAccount with permanent error sets isHealthy=false', async () => {
    const acc = makeAccount()
    await db.upsertAccount(acc)
    await db.upsertAccount({
      ...acc,
      isHealthy: false,
      unhealthyReason: 'ExpiredTokenException'
    })
    const rows = db.getAccounts()
    expect(rows).toHaveLength(1)
    expect(rows[0].is_healthy).toBe(0)
  })

  test('batchUpsertAccounts stores multiple accounts', async () => {
    const a = makeAccount({ id: 'a', email: 'a@example.com' })
    const b = makeAccount({ id: 'b', email: 'b@example.com' })
    await db.batchUpsertAccounts([a, b])
    expect(db.getAccounts()).toHaveLength(2)
  })

  test('deleteAccount removes account', async () => {
    const acc = makeAccount()
    await db.upsertAccount(acc)
    await db.deleteAccount('acc-1')
    expect(db.getAccounts()).toHaveLength(0)
  })

  test('deleteAccount on non-existent id is a no-op', async () => {
    await expect(db.deleteAccount('does-not-exist')).resolves.toBeUndefined()
  })
})

// ── reauth lock ───────────────────────────────────────────────────────────────

describe('KiroDatabase: reauth lock', () => {
  test('acquireReauthLock returns true when no lock held', () => {
    expect(db.acquireReauthLock()).toBe(true)
  })

  test('acquireReauthLock returns false when lock already held by this process', () => {
    db.acquireReauthLock()
    // Same process — process.kill(pid, 0) succeeds, so it's not dead
    expect(db.acquireReauthLock()).toBe(false)
  })

  test('isReauthLockHeld returns false when no lock', () => {
    expect(db.isReauthLockHeld()).toBe(false)
  })

  test('isReauthLockHeld returns true after acquire', () => {
    db.acquireReauthLock()
    expect(db.isReauthLockHeld()).toBe(true)
  })

  test('releaseReauthLock clears the lock', () => {
    db.acquireReauthLock()
    db.releaseReauthLock()
    expect(db.isReauthLockHeld()).toBe(false)
  })

  test('after release, lock can be acquired again', () => {
    db.acquireReauthLock()
    db.releaseReauthLock()
    expect(db.acquireReauthLock()).toBe(true)
  })

  test('stale lock (dead pid) is evicted on acquire', () => {
    // Insert a lock row with a pid that no process uses (high number)
    const { Database } = require('bun:sqlite')
    const rawDb = new Database(dbPath)
    rawDb.prepare('INSERT INTO reauth_lock (id, pid, acquired_at) VALUES (1, 9999999, ?)').run(
      Date.now() - 1000 // recent but dead pid
    )
    rawDb.close()
    // Re-open our db instance
    db.close()
    db = new KiroDatabase(dbPath)
    // Should evict dead-pid lock and acquire
    expect(db.acquireReauthLock()).toBe(true)
  })

  test('expired lock is evicted on acquire', () => {
    const { Database } = require('bun:sqlite')
    const rawDb = new Database(dbPath)
    rawDb.prepare('INSERT INTO reauth_lock (id, pid, acquired_at) VALUES (1, ?, ?)').run(
      process.pid,
      Date.now() - 200_000 // 200s ago, well past 120s TTL
    )
    rawDb.close()
    db.close()
    db = new KiroDatabase(dbPath)
    expect(db.acquireReauthLock()).toBe(true)
  })

  test('race-safe: row-replacement when prior dead-pid row exists', () => {
    // Simulate a row that the SELECT picked up as "expired" but is actually
    // the same one INSERT will try to write. INSERT OR REPLACE handles this.
    const { Database } = require('bun:sqlite')
    const rawDb = new Database(dbPath)
    rawDb
      .prepare('INSERT INTO reauth_lock (id, pid, acquired_at) VALUES (1, 9999998, ?)')
      .run(Date.now() - 200_000)
    rawDb.close()
    db.close()
    db = new KiroDatabase(dbPath)
    // Should not throw on PRIMARY KEY conflict
    expect(db.acquireReauthLock()).toBe(true)
    // The row now belongs to this process
    expect(db.isReauthLockHeld()).toBe(true)
  })
})

// ── conversations ─────────────────────────────────────────────────────────────

describe('KiroDatabase: conversations', () => {
  test('getConversationId returns undefined when not set', () => {
    expect(db.getConversationId('ws', 'fp')).toBeUndefined()
  })

  test('setConversationId and getConversationId round-trip', () => {
    db.setConversationId('ws', 'fp', 'conv-123', 'agent-123')
    expect(db.getConversationId('ws', 'fp')).toEqual({
      convId: 'conv-123',
      agentContinuationId: 'agent-123'
    })
  })

  test('setConversationId updates existing entry', () => {
    db.setConversationId('ws', 'fp', 'conv-1', 'agent-1')
    db.setConversationId('ws', 'fp', 'conv-2', 'agent-2')
    expect(db.getConversationId('ws', 'fp')).toEqual({
      convId: 'conv-2',
      agentContinuationId: 'agent-2'
    })
  })

  test('different fingerprints are independent', () => {
    db.setConversationId('ws', 'fp1', 'conv-A', 'agent-A')
    db.setConversationId('ws', 'fp2', 'conv-B', 'agent-B')
    expect(db.getConversationId('ws', 'fp1')).toEqual({
      convId: 'conv-A',
      agentContinuationId: 'agent-A'
    })
    expect(db.getConversationId('ws', 'fp2')).toEqual({
      convId: 'conv-B',
      agentContinuationId: 'agent-B'
    })
  })

  test('TTL cleanup removes old entries', () => {
    const { Database } = require('bun:sqlite')
    const rawDb = new Database(dbPath)
    rawDb
      .prepare(
        'INSERT INTO conversations (workspace, fingerprint, conv_id, agent_continuation_id, last_used) VALUES (?, ?, ?, ?, ?)'
      )
      .run('ws', 'old', 'conv-old', 'agent-old', Date.now() - 10 * 24 * 3600000) // 10 days old
    rawDb.close()
    db.close()
    db = new KiroDatabase(dbPath)
    // Trigger cleanup by setting a new one (ttlDays=7)
    db.setConversationId('ws', 'new', 'conv-new', 'agent-new', 7)
    expect(db.getConversationId('ws', 'old')).toBeUndefined()
    expect(db.getConversationId('ws', 'new')).toEqual({
      convId: 'conv-new',
      agentContinuationId: 'agent-new'
    })
  })

  test('deleteConversationId removes entry so next lookup returns undefined', () => {
    db.setConversationId('ws', 'fp', 'conv-del', 'agent-del')
    expect(db.getConversationId('ws', 'fp')).toBeDefined()
    db.deleteConversationId('ws', 'fp')
    expect(db.getConversationId('ws', 'fp')).toBeUndefined()
  })

  test('deleteConversationId is a no-op for non-existent entry', () => {
    expect(() => db.deleteConversationId('ws', 'missing')).not.toThrow()
  })
})
