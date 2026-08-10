import type Libsql from 'libsql'
import Database from 'libsql'
import { existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ManagedAccount } from '../types'
import { deduplicateAccounts, mergeAccounts, withDatabaseLock } from './locked-operations'
import { runMigrations } from './migrations'

function getBaseDir(): string {
  const p = process.platform
  if (p === 'win32')
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
}

export const DB_PATH = join(getBaseDir(), 'kiro.db')

export class KiroDatabase {
  private db: Libsql.Database
  private path: string

  constructor(path: string = DB_PATH) {
    this.path = path
    const dir = join(path, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.db = new Database(path)
    this.db.pragma('busy_timeout = 5000')
    this.init()
  }
  private init() {
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, auth_method TEXT NOT NULL,
        region TEXT NOT NULL, oidc_region TEXT, client_id TEXT, client_secret TEXT, profile_arn TEXT,
        start_url TEXT,
        refresh_token TEXT NOT NULL, access_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
        rate_limit_reset INTEGER DEFAULT 0, is_healthy INTEGER DEFAULT 1, unhealthy_reason TEXT,
        recovery_time INTEGER, fail_count INTEGER DEFAULT 0, last_used INTEGER DEFAULT 0,
        used_count INTEGER DEFAULT 0, limit_count INTEGER DEFAULT 0, last_sync INTEGER DEFAULT 0
      )
    `)
    runMigrations(this.db)
  }

  getAccounts(): any[] {
    return this.db.prepare('SELECT * FROM accounts').all()
  }

  private upsertAccountInternal(acc: any) {
    this.db
      .prepare(
        `
      INSERT INTO accounts (
        id, email, auth_method, region, oidc_region, client_id, client_secret,
        profile_arn, start_url, refresh_token, access_token, expires_at, rate_limit_reset,
        is_healthy, unhealthy_reason, recovery_time, fail_count, last_used,
        used_count, limit_count, last_sync
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        id=excluded.id, email=excluded.email, auth_method=excluded.auth_method,
        region=excluded.region, oidc_region=excluded.oidc_region, client_id=excluded.client_id, client_secret=excluded.client_secret,
        profile_arn=excluded.profile_arn, start_url=excluded.start_url, refresh_token=excluded.refresh_token,
        access_token=excluded.access_token, expires_at=excluded.expires_at,
        rate_limit_reset=excluded.rate_limit_reset, is_healthy=excluded.is_healthy,
        unhealthy_reason=excluded.unhealthy_reason, recovery_time=excluded.recovery_time,
        fail_count=excluded.fail_count, last_used=excluded.last_used,
        used_count=excluded.used_count, limit_count=excluded.limit_count, last_sync=excluded.last_sync
    `
      )
      .run(
        acc.id,
        acc.email,
        acc.authMethod,
        acc.region,
        acc.oidcRegion || null,
        acc.clientId || null,
        acc.clientSecret || null,
        acc.profileArn || null,
        acc.startUrl || null,
        acc.refreshToken,
        acc.accessToken,
        acc.expiresAt,
        acc.rateLimitResetTime || 0,
        acc.isHealthy ? 1 : 0,
        acc.unhealthyReason || null,
        acc.recoveryTime || null,
        acc.failCount || 0,
        acc.lastUsed || 0,
        acc.usedCount || 0,
        acc.limitCount || 0,
        acc.lastSync || 0
      )
  }

  async upsertAccount(acc: ManagedAccount): Promise<void> {
    await withDatabaseLock(this.path, async () => {
      const existing = this.getAccounts().map(this.rowToAccount)
      const merged = mergeAccounts(existing, [acc])
      const deduplicated = deduplicateAccounts(merged)

      this.db.exec('BEGIN TRANSACTION')
      try {
        for (const account of deduplicated) {
          this.upsertAccountInternal(account)
        }
        this.db.exec('COMMIT')
      } catch (e) {
        this.db.exec('ROLLBACK')
        throw e
      }
    })
  }

  async batchUpsertAccounts(accounts: ManagedAccount[]): Promise<void> {
    await withDatabaseLock(this.path, async () => {
      const existing = this.getAccounts().map(this.rowToAccount)
      const merged = mergeAccounts(existing, accounts)
      const deduplicated = deduplicateAccounts(merged)

      this.db.exec('BEGIN TRANSACTION')
      try {
        for (const account of deduplicated) {
          this.upsertAccountInternal(account)
        }
        this.db.exec('COMMIT')
      } catch (e) {
        this.db.exec('ROLLBACK')
        throw e
      }
    })
  }

  async deleteAccount(id: string): Promise<void> {
    await withDatabaseLock(this.path, async () => {
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
    })
  }

  async markAccountsUnhealthy(ids: string[], reason: string): Promise<void> {
    if (ids.length === 0) return

    await withDatabaseLock(this.path, async () => {
      const now = Date.now()

      this.db.exec('BEGIN TRANSACTION')
      try {
        const stmt = this.db.prepare(
          `
            UPDATE accounts
            SET is_healthy = 0,
                unhealthy_reason = ?,
                recovery_time = NULL,
                fail_count = 10,
                rate_limit_reset = 0,
                last_sync = ?
            WHERE id = ?
          `
        )

        for (const id of ids) {
          stmt.run(reason, now, id)
        }

        this.db.exec('COMMIT')
      } catch (e) {
        this.db.exec('ROLLBACK')
        throw e
      }
    })
  }

  async cleanupTestAndStaleAccounts(staleDays = 30): Promise<number> {
    const cutoffMs = Date.now() - staleDays * 24 * 60 * 60 * 1000
    return withDatabaseLock(this.path, async () => {
      const before = (this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number })
        .n
      this.db
        .prepare(
          `DELETE FROM accounts
           WHERE email = 'test@example.com'
              OR email LIKE 'placeholder-%@awsapps.local'
              OR (is_healthy = 0
                  AND unhealthy_reason IN ('Account Suspended', 'ExpiredTokenException')
                  AND (recovery_time IS NULL OR recovery_time < ?))`
        )
        .run(cutoffMs)
      const after = (this.db.prepare('SELECT COUNT(*) AS n FROM accounts').get() as { n: number }).n
      return before - after
    })
  }

  async deleteStaleIdcDuplicates(
    canonicalId: string,
    email: string,
    profileArn: string
  ): Promise<void> {
    await withDatabaseLock(this.path, async () => {
      this.db
        .prepare(
          `DELETE FROM accounts
           WHERE auth_method = 'idc'
             AND email = ?
             AND profile_arn = ?
             AND id != ?`
        )
        .run(email, profileArn, canonicalId)
      // Also clean up placeholder rows for the same profileArn.
      this.db
        .prepare(
          `DELETE FROM accounts
           WHERE auth_method = 'idc'
             AND profile_arn = ?
             AND email LIKE 'placeholder-%'
             AND id != ?`
        )
        .run(profileArn, canonicalId)
    })
  }

  private rowToAccount(row: any): ManagedAccount {
    return {
      id: row.id,
      email: row.email,
      authMethod: row.auth_method,
      region: row.region,
      oidcRegion: row.oidc_region || undefined,
      clientId: row.client_id,
      clientSecret: row.client_secret,
      profileArn: row.profile_arn,
      startUrl: row.start_url || undefined,
      refreshToken: row.refresh_token,
      accessToken: row.access_token,
      expiresAt: row.expires_at,
      rateLimitResetTime: row.rate_limit_reset,
      isHealthy: row.is_healthy === 1,
      unhealthyReason: row.unhealthy_reason,
      recoveryTime: row.recovery_time,
      failCount: row.fail_count,
      lastUsed: row.last_used,
      usedCount: row.used_count,
      limitCount: row.limit_count,
      lastSync: row.last_sync
    }
  }

  private static readonly REAUTH_LOCK_TTL_MS = 120_000

  acquireReauthLock(): boolean {
    const now = Date.now()
    try {
      this.db.exec('BEGIN IMMEDIATE')
    } catch {
      // Another write transaction is active — treat as lock held
      return false
    }
    try {
      const existing = this.db
        .prepare('SELECT pid, acquired_at FROM reauth_lock WHERE id = 1')
        .get() as { pid: number; acquired_at: number } | undefined

      if (existing) {
        const expired = now - existing.acquired_at >= KiroDatabase.REAUTH_LOCK_TTL_MS
        const dead = (() => {
          try {
            process.kill(existing.pid, 0)
            return false
          } catch {
            return true
          }
        })()
        if (expired || dead) {
          this.db.prepare('DELETE FROM reauth_lock WHERE id = 1').run()
        } else {
          this.db.exec('ROLLBACK')
          return false
        }
      }

      // INSERT OR REPLACE handles a race where two instances both saw the
      // same dead/expired lock and both reach this branch.
      this.db
        .prepare('INSERT OR REPLACE INTO reauth_lock (id, pid, acquired_at) VALUES (1, ?, ?)')
        .run(process.pid, now)
      this.db.exec('COMMIT')
      return true
    } catch {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        // already rolled back
      }
      return false
    }
  }

  isReauthLockHeld(): boolean {
    const row = this.db.prepare('SELECT pid FROM reauth_lock WHERE id = 1').get() as
      { pid: number } | undefined
    if (!row) return false
    try {
      process.kill(row.pid, 0)
      return true
    } catch {
      return false
    }
  }

  releaseReauthLock(): void {
    this.db.prepare('DELETE FROM reauth_lock WHERE id = 1 AND pid = ?').run(process.pid)
  }

  close() {
    this.db.close()
  }

  getConversationId(
    workspace: string,
    fingerprint: string
  ): { convId: string; agentContinuationId: string } | undefined {
    const row = this.db
      .prepare(
        'SELECT conv_id, agent_continuation_id FROM conversations WHERE workspace = ? AND fingerprint = ?'
      )
      .get(workspace, fingerprint) as
      { conv_id: string; agent_continuation_id: string | null } | undefined
    return row
      ? { convId: row.conv_id, agentContinuationId: row.agent_continuation_id || '' }
      : undefined
  }

  deleteConversationId(workspace: string, fingerprint: string): void {
    this.db
      .prepare('DELETE FROM conversations WHERE workspace = ? AND fingerprint = ?')
      .run(workspace, fingerprint)
  }

  /**
   * Persist a conversationId and agentContinuationId, clean up entries older than ttlDays (default 7).
   */
  setConversationId(
    workspace: string,
    fingerprint: string,
    convId: string,
    agentContinuationId: string,
    ttlDays = 7
  ): void {
    const now = Date.now()
    const cutoff = now - ttlDays * 24 * 60 * 60 * 1000
    this.db.exec('BEGIN TRANSACTION')
    try {
      this.db
        .prepare(
          `INSERT INTO conversations (workspace, fingerprint, conv_id, agent_continuation_id, last_used)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT(workspace, fingerprint) DO UPDATE SET conv_id = excluded.conv_id, agent_continuation_id = excluded.agent_continuation_id, last_used = excluded.last_used`
        )
        .run(workspace, fingerprint, convId, agentContinuationId, now)
      this.db.prepare('DELETE FROM conversations WHERE last_used < ?').run(cutoff)
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }
}

export function createDatabase(path?: string): KiroDatabase {
  return new KiroDatabase(path)
}

export const kiroDb = new KiroDatabase()
