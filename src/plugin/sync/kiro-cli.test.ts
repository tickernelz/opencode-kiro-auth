import { Database } from 'bun:sqlite'
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type SyncModule = typeof import('./kiro-cli')
type SqliteModule = typeof import('../storage/sqlite')

let baseDir = ''
let cliDbPath = ''

let syncFromKiroCli: SyncModule['syncFromKiroCli']
let DB_PATH: SqliteModule['DB_PATH']
let kiroDb: SqliteModule['kiroDb']

function writeCliAuthKv(entries: Array<{ key: string; value: any }>) {
  rmSync(cliDbPath, { force: true })
  const db = new Database(cliDbPath)
  db.run('PRAGMA busy_timeout = 5000')
  db.run('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)')
  const ins = db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)')
  for (const e of entries) ins.run(e.key, JSON.stringify(e.value))
  db.close()
}

function clearPluginAccounts() {
  const db = new Database(DB_PATH)
  db.run('PRAGMA busy_timeout = 5000')
  db.run('DELETE FROM accounts')
  db.close()
}

describe('syncFromKiroCli (IDC bootstrap)', () => {
  beforeAll(async () => {
    baseDir = mkdtempSync(join(tmpdir(), 'opencode-kiro-auth-test-'))
    cliDbPath = join(baseDir, 'kiro-cli.sqlite3')

    process.env.XDG_CONFIG_HOME = baseDir
    process.env.KIROCLI_DB_PATH = cliDbPath

    const sqliteMod: SqliteModule = await import('../storage/sqlite')
    DB_PATH = sqliteMod.DB_PATH
    kiroDb = sqliteMod.kiroDb

    const syncMod: SyncModule = await import('./kiro-cli')
    syncFromKiroCli = syncMod.syncFromKiroCli
  })

  beforeEach(() => {
    clearPluginAccounts()
  })

  afterAll(() => {
    kiroDb.close()
    rmSync(baseDir, { recursive: true, force: true })
  })

  test('upserts IDC account with nested device-registration creds even if usage fetch fails', async () => {
    const origFetch = globalThis.fetch
    globalThis.fetch = Object.assign(
      async (..._args: Parameters<typeof fetch>) => new Response('fail', { status: 500 }),
      origFetch
    )

    try {
      writeCliAuthKv([
        {
          key: 'kirocli:odic:device-registration',
          value: { registration: { clientId: 'cid-1', clientSecret: 'csec-1' } }
        },
        {
          key: 'kirocli:odic:token',
          value: {
            access_token: 'AT',
            refresh_token: 'RT',
            expires_at: '2026-01-27T12:00:00Z',
            region: 'us-east-1'
          }
        }
      ])

      await syncFromKiroCli()
      const accs: any[] = kiroDb.getAccounts()
      expect(accs.length).toBe(1)
      expect(accs[0].auth_method).toBe('idc')
      expect(accs[0].client_id).toBe('cid-1')
      expect(accs[0].client_secret).toBe('csec-1')
      expect(accs[0].refresh_token).toBe('RT')
      expect(accs[0].access_token).toBe('AT')
      expect(typeof accs[0].expires_at).toBe('number')
      expect(accs[0].expires_at).toBeGreaterThan(0)
      expect(typeof accs[0].email).toBe('string')
      expect(accs[0].email).toContain('idc-placeholder+')
    } finally {
      globalThis.fetch = origFetch
    }
  })

  test('when usage fetch succeeds later, inserts real-email account and disables placeholder', async () => {
    const origFetch = globalThis.fetch

    try {
      // First pass: fail usage fetch -> placeholder account
      globalThis.fetch = Object.assign(
        async (..._args: Parameters<typeof fetch>) => new Response('fail', { status: 500 }),
        origFetch
      )
      writeCliAuthKv([
        {
          key: 'kirocli:odic:device-registration',
          value: { client_id: 'cid-2', client_secret: 'csec-2' }
        },
        {
          key: 'kirocli:odic:token',
          value: {
            access_token: 'AT2',
            refresh_token: 'RT2',
            expires_at: '2026-01-27T12:00:00Z',
            region: 'us-east-1'
          }
        }
      ])
      await syncFromKiroCli()

      // Second pass: succeed -> real email, placeholder should be disabled
      globalThis.fetch = Object.assign(
        async (..._args: Parameters<typeof fetch>) =>
          new Response(
            JSON.stringify({ userInfo: { email: 'real@example.com' }, usageBreakdownList: [] }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          ),
        origFetch
      )
      await syncFromKiroCli()

      const accs: any[] = kiroDb.getAccounts()
      expect(accs.some((a) => a.email === 'real@example.com')).toBe(true)
      expect(
        accs.some(
          (a) =>
            typeof a.email === 'string' &&
            a.email.includes('idc-placeholder+') &&
            a.is_healthy === 0 &&
            (a.fail_count || 0) >= 10
        )
      ).toBe(true)
    } finally {
      globalThis.fetch = origFetch
    }
  })
})
