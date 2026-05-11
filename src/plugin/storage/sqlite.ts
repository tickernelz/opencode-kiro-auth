import { Database } from 'bun:sqlite'
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
  private db: Database
  private path: string

  constructor(path: string = DB_PATH) {
    this.path = path
    const dir = join(path, '..')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    this.db = new Database(path)
    this.db.run('PRAGMA busy_timeout = 5000')
    this.init()
  }
  private init() {
    this.db.run('PRAGMA journal_mode = WAL')
    this.db.run(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, email TEXT NOT NULL, auth_method TEXT NOT NULL,
        region TEXT NOT NULL, oidc_region TEXT, client_id TEXT, client_secret TEXT, profile_arn TEXT,
        start_url TEXT,
        refresh_token TEXT NOT NULL, access_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
        rate_limit_reset INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1, is_healthy INTEGER DEFAULT 1, unhealthy_reason TEXT,
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
        enabled, is_healthy, unhealthy_reason, recovery_time, fail_count, last_used,
        used_count, limit_count, last_sync
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        id=excluded.id, email=excluded.email, auth_method=excluded.auth_method,
        region=excluded.region, oidc_region=excluded.oidc_region, client_id=excluded.client_id, client_secret=excluded.client_secret,
        profile_arn=excluded.profile_arn, start_url=excluded.start_url, refresh_token=excluded.refresh_token,
        access_token=excluded.access_token, expires_at=excluded.expires_at,
        rate_limit_reset=excluded.rate_limit_reset, enabled=excluded.enabled, is_healthy=excluded.is_healthy,
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
        acc.enabled === false ? 0 : 1,
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

      this.db.run('BEGIN TRANSACTION')
      try {
        for (const account of deduplicated) {
          this.upsertAccountInternal(account)
        }
        this.db.run('COMMIT')
      } catch (e) {
        this.db.run('ROLLBACK')
        throw e
      }
    })
  }

  async batchUpsertAccounts(accounts: ManagedAccount[]): Promise<void> {
    await withDatabaseLock(this.path, async () => {
      const existing = this.getAccounts().map(this.rowToAccount)
      const merged = mergeAccounts(existing, accounts)
      const deduplicated = deduplicateAccounts(merged)

      this.db.run('BEGIN TRANSACTION')
      try {
        for (const account of deduplicated) {
          this.upsertAccountInternal(account)
        }
        this.db.run('COMMIT')
      } catch (e) {
        this.db.run('ROLLBACK')
        throw e
      }
    })
  }

  async deleteAccount(id: string): Promise<void> {
    await withDatabaseLock(this.path, async () => {
      this.db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
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
      enabled: row.enabled !== 0,
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

  close() {
    this.db.close()
  }
}

export function createDatabase(path?: string): KiroDatabase {
  return new KiroDatabase(path)
}

export const kiroDb = new KiroDatabase()
