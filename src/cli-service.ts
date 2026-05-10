import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'

export type SqliteDatabase = {
  exec(sql: string): void
  prepare(sql: string): {
    all(...params: unknown[]): unknown[]
    get(...params: unknown[]): unknown
    run(...params: unknown[]): unknown
  }
  close(): void
}

export type AccountRow = {
  id: string
  email: string
  auth_method: string
  region: string
  oidc_region?: string | null
  client_id?: string | null
  client_secret?: string | null
  profile_arn?: string | null
  start_url?: string | null
  refresh_token: string
  access_token: string
  expires_at: number
  rate_limit_reset?: number | null
  enabled?: number | null
  is_healthy?: number | null
  unhealthy_reason?: string | null
  recovery_time?: number | null
  fail_count?: number | null
  last_used?: number | null
  used_count?: number | null
  limit_count?: number | null
  last_sync?: number | null
}

export type CommandResult = {
  exitCode: number
  lines: string[]
}

const require = createRequire(import.meta.url)

function openDatabase(path: string): SqliteDatabase {
  try {
    const sqlite = require('node:sqlite') as {
      DatabaseSync: new (path: string) => SqliteDatabase
    }
    return new sqlite.DatabaseSync(path)
  } catch {
    throw new Error('This CLI requires Node.js with node:sqlite support. Use Node 22.5 or newer.')
  }
}

export function getOpenCodeBaseDir(): string {
  if (platform() === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
}

export function getKiroCliDbPath(): string {
  if (process.env.KIROCLI_DB_PATH) return process.env.KIROCLI_DB_PATH
  if (platform() === 'win32') {
    return join(
      process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
      'kiro-cli',
      'data.sqlite3'
    )
  }
  if (platform() === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3')
  }
  return join(homedir(), '.local', 'share', 'kiro-cli', 'data.sqlite3')
}

export function getPluginDbPath(): string {
  return join(getOpenCodeBaseDir(), 'kiro.db')
}

function normalizeExpiresAt(input: unknown): number {
  if (typeof input === 'number') return input < 10_000_000_000 ? input * 1000 : input
  if (typeof input === 'string' && input.trim()) {
    const time = new Date(input).getTime()
    if (!Number.isNaN(time) && time > 0) return time
    const numberValue = Number(input)
    if (Number.isFinite(numberValue) && numberValue > 0) return normalizeExpiresAt(numberValue)
  }
  return Date.now() + 3600000
}

function safeJsonParse(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string') return null
  try {
    const parsed = JSON.parse(value)
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function findClientCredsRecursive(input: unknown): { clientId?: string; clientSecret?: string } {
  const stack: unknown[] = [input]
  const visited = new Set<unknown>()
  while (stack.length) {
    const current = stack.pop()
    if (!current || typeof current !== 'object' || visited.has(current)) continue
    visited.add(current)
    const record = current as Record<string, unknown>
    const clientId = record.client_id || record.clientId
    const clientSecret = record.client_secret || record.clientSecret
    if (
      typeof clientId === 'string' &&
      typeof clientSecret === 'string' &&
      clientId &&
      clientSecret
    ) {
      return { clientId, clientSecret }
    }
    if (Array.isArray(current)) stack.push(...current)
    else stack.push(...Object.values(record))
  }
  return {}
}

function makePlaceholderEmail(
  authMethod: string,
  region: string,
  clientId?: string,
  profileArn?: string
): string {
  const seed = `${authMethod}:${region}:${clientId || ''}:${profileArn || ''}`
  const hash = createHash('sha256').update(seed).digest('hex').slice(0, 16)
  return `${authMethod}-placeholder+${hash}@awsapps.local`
}

function createAccountId(
  email: string,
  method: string,
  clientId?: string,
  profileArn?: string
): string {
  return createHash('sha256')
    .update(`${email}:${method}:${clientId || ''}:${profileArn || ''}`)
    .digest('hex')
}

export function readKiroCliEmail(): string | undefined {
  const result =
    platform() === 'win32'
      ? spawnSync('cmd.exe', ['/d', '/s', '/c', 'kiro-cli whoami'], { encoding: 'utf8' })
      : spawnSync('kiro-cli', ['whoami'], { encoding: 'utf8' })
  const output = `${result.stdout || ''}\n${result.stderr || ''}`
  const match = output.match(/Email:\s*([^\s]+)/)
  return match?.[1]
}

function initPluginDb(db: SqliteDatabase): void {
  db.exec('PRAGMA busy_timeout = 5000')
  db.exec(`
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
  const columns = db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>
  const names = new Set(columns.map((column) => column.name))
  if (!names.has('enabled')) db.exec('ALTER TABLE accounts ADD COLUMN enabled INTEGER DEFAULT 1')
}

export function readAccounts(): AccountRow[] {
  const dbPath = getPluginDbPath()
  if (!existsSync(dbPath)) return []
  const db = openDatabase(dbPath)
  try {
    initPluginDb(db)
    return db
      .prepare('SELECT * FROM accounts ORDER BY last_used DESC, email ASC')
      .all() as AccountRow[]
  } finally {
    db.close()
  }
}

export function upsertAccount(account: AccountRow): void {
  const dbPath = getPluginDbPath()
  mkdirSync(dirname(dbPath), { recursive: true })
  const db = openDatabase(dbPath)
  try {
    initPluginDb(db)
    db.prepare(
      `
      INSERT INTO accounts (
        id, email, auth_method, region, oidc_region, client_id, client_secret,
        profile_arn, start_url, refresh_token, access_token, expires_at, rate_limit_reset,
        enabled, is_healthy, unhealthy_reason, recovery_time, fail_count, last_used,
        used_count, limit_count, last_sync
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        email=excluded.email, auth_method=excluded.auth_method, region=excluded.region,
        oidc_region=excluded.oidc_region, client_id=excluded.client_id,
        client_secret=excluded.client_secret, profile_arn=excluded.profile_arn,
        start_url=excluded.start_url, refresh_token=excluded.refresh_token,
        access_token=excluded.access_token, expires_at=excluded.expires_at,
        rate_limit_reset=excluded.rate_limit_reset, enabled=excluded.enabled,
        is_healthy=excluded.is_healthy, unhealthy_reason=excluded.unhealthy_reason,
        recovery_time=excluded.recovery_time, fail_count=excluded.fail_count,
        last_used=MAX(last_used, excluded.last_used),
        used_count=MAX(used_count, excluded.used_count),
        limit_count=MAX(limit_count, excluded.limit_count),
        last_sync=MAX(last_sync, excluded.last_sync)
    `
    ).run(
      account.id,
      account.email,
      account.auth_method,
      account.region,
      account.oidc_region || null,
      account.client_id || null,
      account.client_secret || null,
      account.profile_arn || null,
      account.start_url || null,
      account.refresh_token,
      account.access_token,
      account.expires_at,
      account.rate_limit_reset || 0,
      account.enabled === 0 ? 0 : 1,
      account.is_healthy === 0 ? 0 : 1,
      account.unhealthy_reason || null,
      account.recovery_time || null,
      account.fail_count || 0,
      account.last_used || 0,
      account.used_count || 0,
      account.limit_count || 0,
      account.last_sync || Date.now()
    )
  } finally {
    db.close()
  }
}

export function updateAccount(id: string, patch: Partial<AccountRow>): AccountRow {
  const accounts = readAccounts()
  const current = accounts.find((account) => account.id === id)
  if (!current) throw new Error('Account no longer exists')
  const updated = { ...current, ...patch }
  upsertAccount(updated)
  return updated
}

export function deleteAccount(id: string): void {
  const db = openDatabase(getPluginDbPath())
  try {
    initPluginDb(db)
    db.prepare('DELETE FROM accounts WHERE id = ?').run(id)
  } finally {
    db.close()
  }
}

export function getAccountByIndex(indexText: string | undefined): {
  account: AccountRow
  index: number
} {
  const index = Number.parseInt(indexText || '', 10)
  if (!Number.isInteger(index) || index < 1) throw new Error('Expected a 1-based account index')
  const accounts = readAccounts()
  const account = accounts[index - 1]
  if (!account) throw new Error(`No account at index ${index}`)
  return { account, index: index - 1 }
}

export function formatDate(value?: number | null): string {
  if (!value) return '-'
  return new Date(value).toISOString()
}

export function formatWait(value?: number | null): string {
  if (!value) return '-'
  const wait = value - Date.now()
  if (wait <= 0) return 'expired'
  return `${Math.ceil(wait / 1000)}s`
}

export function statusFor(account: AccountRow): string {
  if (account.enabled === 0) return 'disabled'
  if (account.rate_limit_reset && account.rate_limit_reset > Date.now()) return 'rate-limited'
  if (account.is_healthy === 0) return 'unhealthy'
  return 'healthy'
}

export function accountLine(account: AccountRow, index: number): string {
  const used = account.used_count ?? 0
  const limit = account.limit_count ?? 0
  const usage = limit > 0 ? `${used}/${limit}` : `${used}`
  return [
    `${index + 1}.`,
    account.email,
    `status=${statusFor(account)}`,
    `usage=${usage}`,
    `method=${account.auth_method}`,
    `region=${account.region}`,
    `reset=${formatWait(account.rate_limit_reset)}`,
    `lastUsed=${formatDate(account.last_used)}`
  ].join(' ')
}

export function listAccounts(): CommandResult {
  const accounts = readAccounts()
  if (accounts.length === 0) {
    return {
      exitCode: 0,
      lines: ['No Kiro accounts found. Run `kiro-cli login`, then `kiro-auth add`.']
    }
  }
  return { exitCode: 0, lines: accounts.map(accountLine) }
}

export function addCurrentKiroCliAccount(): CommandResult {
  const cliDbPath = getKiroCliDbPath()
  if (!existsSync(cliDbPath)) throw new Error(`Kiro CLI database not found: ${cliDbPath}`)
  const before = readAccounts().length
  const cliDb = openDatabase(cliDbPath)
  try {
    const rows = cliDb.prepare('SELECT key, value FROM auth_kv').all() as Array<{
      key: string
      value: string
    }>
    const registration = rows.find((row) => row.key.includes('device-registration'))
    const creds = findClientCredsRecursive(safeJsonParse(registration?.value))
    const cliEmail = readKiroCliEmail()
    let imported = 0

    for (const row of rows) {
      if (!row.key.includes(':token')) continue
      const data = safeJsonParse(row.value)
      if (!data) continue
      const isIdc = row.key.includes('odic')
      const authMethod = isIdc ? 'idc' : 'desktop'
      const region = String(data.region || 'us-east-1')
      const profileArn = typeof data.profile_arn === 'string' ? data.profile_arn : undefined
      const refreshToken = String(data.refresh_token || data.refreshToken || '')
      if (!refreshToken) continue
      const accessToken = String(data.access_token || data.accessToken || '')
      const clientId = String(data.client_id || data.clientId || creds.clientId || '')
      const clientSecret = String(
        data.client_secret || data.clientSecret || creds.clientSecret || ''
      )
      const email = cliEmail || makePlaceholderEmail(authMethod, region, clientId, profileArn)
      const id = createAccountId(email, authMethod, clientId, profileArn)
      upsertAccount({
        id,
        email,
        auth_method: authMethod,
        region,
        oidc_region: region,
        client_id: clientId || null,
        client_secret: clientSecret || null,
        profile_arn: profileArn || null,
        start_url: typeof data.start_url === 'string' ? data.start_url : null,
        refresh_token: refreshToken,
        access_token: accessToken,
        expires_at: normalizeExpiresAt(data.expires_at || data.expiresAt),
        rate_limit_reset: 0,
        enabled: 1,
        is_healthy: 1,
        fail_count: 0,
        used_count: 0,
        limit_count: 0,
        last_sync: Date.now()
      })
      imported += 1
    }
    const accounts = readAccounts()
    return {
      exitCode: 0,
      lines: [
        `Synced Kiro CLI accounts. before=${before} after=${accounts.length} imported=${imported}`,
        ...accounts.map(accountLine)
      ]
    }
  } finally {
    cliDb.close()
  }
}

export function writeAccountToKiroCli(account: AccountRow): void {
  const cliDbPath = getKiroCliDbPath()
  if (!existsSync(cliDbPath)) throw new Error(`Kiro CLI database not found: ${cliDbPath}`)
  const cliDb = openDatabase(cliDbPath)
  try {
    const rows = cliDb.prepare('SELECT key, value FROM auth_kv').all() as Array<{
      key: string
      value: string
    }>
    const targetKey = account.auth_method === 'idc' ? 'kirocli:odic:token' : 'kirocli:social:token'
    const row = rows.find((item) => item.key === targetKey || item.key.endsWith(targetKey))
    if (!row) throw new Error(`Kiro CLI token row not found for ${account.auth_method}`)
    const data = safeJsonParse(row.value) || {}
    data.access_token = account.access_token
    data.refresh_token = account.refresh_token
    data.expires_at = new Date(account.expires_at).toISOString()
    cliDb.prepare('UPDATE auth_kv SET value = ? WHERE key = ?').run(JSON.stringify(data), row.key)
  } finally {
    cliDb.close()
  }
}

export function switchAccount(indexText: string | undefined): CommandResult {
  const { account, index } = getAccountByIndex(indexText)
  if (account.enabled === 0) throw new Error(`Account ${index + 1} is disabled`)
  writeAccountToKiroCli(account)
  updateAccount(account.id, { last_used: Date.now() })
  return { exitCode: 0, lines: [`Switched Kiro CLI session to ${index + 1}: ${account.email}`] }
}

export function enableAccount(indexText: string | undefined, enabled: boolean): CommandResult {
  const { account, index } = getAccountByIndex(indexText)
  const patch: Partial<AccountRow> = enabled
    ? {
        enabled: 1,
        is_healthy: 1,
        unhealthy_reason: null,
        recovery_time: null,
        fail_count: 0,
        rate_limit_reset: 0
      }
    : { enabled: 0 }
  const updated = updateAccount(account.id, patch)
  return {
    exitCode: 0,
    lines: [`${enabled ? 'Enabled' : 'Disabled'} account ${index + 1}: ${updated.email}`]
  }
}

export function resetAccount(indexText: string | undefined): CommandResult {
  const { account, index } = getAccountByIndex(indexText)
  const updated = updateAccount(account.id, {
    enabled: 1,
    is_healthy: 1,
    unhealthy_reason: null,
    recovery_time: null,
    fail_count: 0,
    rate_limit_reset: 0
  })
  return { exitCode: 0, lines: [`Reset health for account ${index + 1}: ${updated.email}`] }
}

export function removeAccount(indexText: string | undefined): CommandResult {
  const { account, index } = getAccountByIndex(indexText)
  deleteAccount(account.id)
  return { exitCode: 0, lines: [`Removed account ${index + 1}: ${account.email}`] }
}
