import type Libsql from 'libsql'
import Database from 'libsql'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ManagedAccount } from '../types'
import {
  deduplicateAccounts,
  mergeAccounts,
  withDatabaseLock,
  withDatabaseLockSync
} from './locked-operations'
import { runMigrations } from './migrations'

function getBaseDir(): string {
  const p = process.platform
  if (p === 'win32')
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
}

export const DB_PATH = join(getBaseDir(), 'kiro.db')

export class KiroDatabase {
  private db!: Libsql.Database
  private path: string

  constructor(path: string = DB_PATH) {
    this.path = path
    const dir = join(path, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    withDatabaseLockSync(path, () => {
      this.db = new Database(path)
      this.db.pragma('busy_timeout = 5000')
      this.init()
    })
    this.secureFiles()
  }
  private init() {
    this.db.pragma('journal_mode = WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, auth_method TEXT NOT NULL,
        region TEXT NOT NULL, oidc_region TEXT, client_id TEXT, client_secret TEXT, profile_arn TEXT,
        start_url TEXT,
        refresh_token TEXT NOT NULL, refresh_token_updated_at INTEGER DEFAULT 0,
        access_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
        rate_limit_reset INTEGER DEFAULT 0, is_healthy INTEGER DEFAULT 1, unhealthy_reason TEXT,
        recovery_time INTEGER, fail_count INTEGER DEFAULT 0, last_used INTEGER DEFAULT 0,
        used_count REAL DEFAULT 0, limit_count REAL DEFAULT 0, subscription_plan TEXT,
        last_sync INTEGER DEFAULT 0
      )
    `)
    runMigrations(this.db)
  }

  private secureFiles() {
    if (process.platform === 'win32') return
    for (const path of [this.path, `${this.path}-wal`, `${this.path}-shm`]) {
      if (existsSync(path)) chmodSync(path, 0o600)
    }
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
        profile_arn, start_url, refresh_token, refresh_token_updated_at, access_token, expires_at, rate_limit_reset,
        is_healthy, unhealthy_reason, recovery_time, fail_count, last_used,
        used_count, limit_count, subscription_plan, last_sync
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        id=excluded.id, email=excluded.email, auth_method=excluded.auth_method,
        region=excluded.region, oidc_region=excluded.oidc_region, client_id=excluded.client_id, client_secret=excluded.client_secret,
        profile_arn=excluded.profile_arn, start_url=excluded.start_url, refresh_token=excluded.refresh_token,
        refresh_token_updated_at=excluded.refresh_token_updated_at,
        access_token=excluded.access_token, expires_at=excluded.expires_at,
        rate_limit_reset=excluded.rate_limit_reset, is_healthy=excluded.is_healthy,
        unhealthy_reason=excluded.unhealthy_reason, recovery_time=excluded.recovery_time,
        fail_count=excluded.fail_count, last_used=excluded.last_used,
        used_count=excluded.used_count, limit_count=excluded.limit_count,
        subscription_plan=excluded.subscription_plan, last_sync=excluded.last_sync
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
        acc.refreshTokenUpdatedAt || 0,
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
        acc.subscriptionPlan || null,
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
      this.secureFiles()
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
      this.secureFiles()
    })
  }

  async deleteAccount(id: string): Promise<void> {
    await withDatabaseLock(this.path, async () => {
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
      this.secureFiles()
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
      this.secureFiles()
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
      refreshTokenUpdatedAt: row.refresh_token_updated_at || 0,
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
      subscriptionPlan: row.subscription_plan || undefined,
      lastSync: row.last_sync
    }
  }

  close() {
    this.db.close()
  }
}

export function createDatabase(path?: string): KiroDatabase {
  return new KiroDatabase(path)
}

export const kiroDb = new KiroDatabase()
