import type Libsql from 'libsql'

type Database = Libsql.Database

export function runMigrations(db: Database): void {
  migrateToUniqueRefreshToken(db)
  migrateRealEmailColumn(db)
  migrateUsageTable(db)
  migrateStartUrlColumn(db)
  migrateOidcRegionColumn(db)
  migrateDropRefreshTokenUniqueIndex(db)
  migrateConversationsTable(db)
  migrateReauthLockTable(db)
  migrateConversationsAgentContinuationId(db)
}

function migrateConversationsTable(db: Database): void {
  const hasTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='conversations'")
    .get()
  if (hasTable) return

  db.exec(`
    CREATE TABLE conversations (
      workspace   TEXT    NOT NULL,
      fingerprint TEXT    NOT NULL,
      conv_id     TEXT    NOT NULL,
      last_used   INTEGER NOT NULL,
      PRIMARY KEY (workspace, fingerprint)
    )
  `)
  db.exec('CREATE INDEX idx_conversations_last_used ON conversations(last_used)')
}

function migrateReauthLockTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS reauth_lock (
      id      INTEGER PRIMARY KEY CHECK (id = 1),
      pid     INTEGER NOT NULL,
      acquired_at INTEGER NOT NULL
    )
  `)
}

function migrateConversationsAgentContinuationId(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(conversations)').all() as any[]
  const names = new Set(columns.map((c: any) => c.name))
  if (!names.has('agent_continuation_id')) {
    db.exec('ALTER TABLE conversations ADD COLUMN agent_continuation_id TEXT')
  }
}

function migrateToUniqueRefreshToken(db: Database): void {
  const hasIndex = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='idx_refresh_token_unique'"
    )
    .get()

  if (hasIndex) return

  db.exec('BEGIN TRANSACTION')
  try {
    const duplicates = db
      .prepare(
        `
        SELECT refresh_token, COUNT(*) as count 
        FROM accounts 
        GROUP BY refresh_token 
        HAVING count > 1
      `
      )
      .all() as any[]

    for (const dup of duplicates) {
      const accounts = db
        .prepare(
          'SELECT * FROM accounts WHERE refresh_token = ? ORDER BY last_used DESC, expires_at DESC'
        )
        .all(dup.refresh_token) as any[]

      if (accounts.length > 1) {
        const keep = accounts[0]
        const remove = accounts.slice(1)

        const mergedUsedCount = Math.max(...accounts.map((a: any) => a.used_count || 0))
        const mergedLimitCount = Math.max(...accounts.map((a: any) => a.limit_count || 0))
        const mergedLastUsed = Math.max(...accounts.map((a: any) => a.last_used || 0))
        const mergedFailCount = Math.max(...accounts.map((a: any) => a.fail_count || 0))

        db.prepare(
          `
            UPDATE accounts SET 
              used_count = ?, 
              limit_count = ?, 
              last_used = ?,
              fail_count = ?
            WHERE id = ?
          `
        ).run(mergedUsedCount, mergedLimitCount, mergedLastUsed, mergedFailCount, keep.id)

        for (const acc of remove) {
          db.prepare('DELETE FROM accounts WHERE id = ?').run(acc.id)
        }
      }
    }

    db.exec('CREATE UNIQUE INDEX idx_refresh_token_unique ON accounts(refresh_token)')
    db.exec('COMMIT')
  } catch (e) {
    db.exec('ROLLBACK')
    throw e
  }
}

function migrateRealEmailColumn(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(accounts)').all() as any[]
  const names = new Set(columns.map((c) => c.name))
  if (names.has('real_email')) {
    db.exec('BEGIN TRANSACTION')
    try {
      db.exec(
        "UPDATE accounts SET email = real_email WHERE real_email IS NOT NULL AND real_email != '' AND email LIKE 'builder-id@aws.amazon.com%'"
      )
      db.exec(`
          CREATE TABLE accounts_new (
            id TEXT PRIMARY KEY, email TEXT NOT NULL, auth_method TEXT NOT NULL,
            region TEXT NOT NULL, oidc_region TEXT, client_id TEXT, client_secret TEXT, profile_arn TEXT,
            start_url TEXT,
            refresh_token TEXT NOT NULL, access_token TEXT NOT NULL, expires_at INTEGER NOT NULL,
            rate_limit_reset INTEGER DEFAULT 0, is_healthy INTEGER DEFAULT 1, unhealthy_reason TEXT,
            recovery_time INTEGER, fail_count INTEGER DEFAULT 0, last_used INTEGER DEFAULT 0,
            used_count INTEGER DEFAULT 0, limit_count INTEGER DEFAULT 0, last_sync INTEGER DEFAULT 0
          )
        `)
      db.exec(`
          INSERT INTO accounts_new (id, email, auth_method, region, oidc_region, client_id, client_secret, profile_arn, start_url, refresh_token, access_token, expires_at, rate_limit_reset, is_healthy, unhealthy_reason, recovery_time, fail_count, last_used, used_count, limit_count, last_sync)
          SELECT id, email, auth_method, region, NULL, client_id, client_secret, profile_arn, NULL, refresh_token, access_token, expires_at, COALESCE(rate_limit_reset, 0), COALESCE(is_healthy, 1), unhealthy_reason, recovery_time, COALESCE(fail_count, 0), COALESCE(last_used, 0), 0, 0, 0 FROM accounts
        `)
      db.exec('DROP TABLE accounts')
      db.exec('ALTER TABLE accounts_new RENAME TO accounts')
      db.exec('COMMIT')
    } catch (e) {
      db.exec('ROLLBACK')
    }
  } else {
    const needed: Record<string, string> = {
      fail_count: 'INTEGER DEFAULT 0',
      used_count: 'INTEGER DEFAULT 0',
      limit_count: 'INTEGER DEFAULT 0',
      last_sync: 'INTEGER DEFAULT 0'
    }
    for (const [n, d] of Object.entries(needed)) {
      if (!names.has(n)) db.exec(`ALTER TABLE accounts ADD COLUMN ${n} ${d}`)
    }
  }
}

function migrateUsageTable(db: Database): void {
  const hasUsageTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='usage'")
    .get()
  if (hasUsageTable) {
    db.exec(`
        UPDATE accounts SET 
          used_count = COALESCE((SELECT used_count FROM usage WHERE usage.account_id = accounts.id), used_count),
          limit_count = COALESCE((SELECT limit_count FROM usage WHERE usage.account_id = accounts.id), limit_count),
          last_sync = COALESCE((SELECT last_sync FROM usage WHERE usage.account_id = accounts.id), last_sync)
      `)
    db.exec('DROP TABLE usage')
  }
}

function migrateStartUrlColumn(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(accounts)').all() as any[]
  const names = new Set(columns.map((c) => c.name))
  if (!names.has('start_url')) {
    db.exec('ALTER TABLE accounts ADD COLUMN start_url TEXT')
  }
}

function migrateOidcRegionColumn(db: Database): void {
  const columns = db.prepare('PRAGMA table_info(accounts)').all() as any[]
  const names = new Set(columns.map((c) => c.name))
  if (!names.has('oidc_region')) {
    db.exec('ALTER TABLE accounts ADD COLUMN oidc_region TEXT')
  }
  // Backfill: historically `region` was used for both service + OIDC.
  db.exec("UPDATE accounts SET oidc_region = region WHERE oidc_region IS NULL OR oidc_region = ''")
}

function migrateDropRefreshTokenUniqueIndex(db: Database): void {
  // Drop the UNIQUE index on refresh_token — it was only needed for ON CONFLICT(refresh_token)
  // upsert mechanics. Now that we use ON CONFLICT(id), this index is unnecessary and actively
  // harmful: duplicate rows (same account, different legacy vs hash id) share the same
  // refresh_token, causing UNIQUE constraint violations on every upsert.
  db.exec('DROP INDEX IF EXISTS idx_refresh_token_unique')

  // Clean up duplicate rows: same email + same refresh_token but different ids.
  // Keep the deterministic hash id (64-char hex), delete legacy kiro-cli-sync-* rows.
  const duplicates = db
    .prepare(
      `SELECT email, refresh_token FROM accounts
       GROUP BY email, refresh_token
       HAVING COUNT(*) > 1`
    )
    .all() as any[]

  for (const dup of duplicates) {
    const rows = db
      .prepare(
        `SELECT id FROM accounts WHERE email = ? AND refresh_token = ?
         ORDER BY
           CASE WHEN id LIKE 'kiro-cli-sync-%' THEN 1 ELSE 0 END ASC,
           last_used DESC, expires_at DESC`
      )
      .all(dup.email, dup.refresh_token) as any[]

    // Keep the first row (deterministic hash id preferred), delete the rest
    for (const row of rows.slice(1)) {
      db.prepare('DELETE FROM accounts WHERE id = ?').run(row.id)
    }
  }
}
