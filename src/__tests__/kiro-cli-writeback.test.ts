import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeToKiroCli } from '../plugin/sync/kiro-cli.js'

const created: string[] = []

function makeCliDb(tokenKey: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'kirocli-test-'))
  created.push(dir)
  const dbPath = join(dir, 'data.sqlite3')
  const db = new Database(dbPath)
  db.run('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)')
  db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)').run(
    tokenKey,
    JSON.stringify({
      access_token: 'OLD_ACCESS',
      refresh_token: 'OLD_REFRESH',
      expires_at: '2020-01-01T00:00:00.000Z'
    })
  )
  db.close()
  return dbPath
}

function readToken(dbPath: string, tokenKey: string): any {
  const db = new Database(dbPath, { readonly: true })
  const row = db.prepare('SELECT value FROM auth_kv WHERE key = ?').get(tokenKey) as any
  db.close()
  return JSON.parse(row.value)
}

afterEach(() => {
  delete process.env.KIROCLI_DB_PATH
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('writeToKiroCli', () => {
  test('writes refreshed IDC tokens back to the kirocli:oidc:token key', async () => {
    const dbPath = makeCliDb('kirocli:oidc:token')
    process.env.KIROCLI_DB_PATH = dbPath

    await writeToKiroCli({
      authMethod: 'idc',
      accessToken: 'NEW_ACCESS',
      refreshToken: 'NEW_REFRESH',
      expiresAt: Date.parse('2030-01-01T00:00:00.000Z')
    })

    const data = readToken(dbPath, 'kirocli:oidc:token')
    expect(data.access_token).toBe('NEW_ACCESS')
    expect(data.refresh_token).toBe('NEW_REFRESH')
    expect(data.expires_at).toBe('2030-01-01T00:00:00.000Z')
  })

  test('writes refreshed IDC tokens back to the legacy kirocli:odic:token key', async () => {
    const dbPath = makeCliDb('kirocli:odic:token')
    process.env.KIROCLI_DB_PATH = dbPath

    await writeToKiroCli({
      authMethod: 'idc',
      accessToken: 'NEW_ACCESS',
      refreshToken: 'NEW_REFRESH',
      expiresAt: Date.parse('2030-01-01T00:00:00.000Z')
    })

    const data = readToken(dbPath, 'kirocli:odic:token')
    expect(data.access_token).toBe('NEW_ACCESS')
    expect(data.refresh_token).toBe('NEW_REFRESH')
  })

  test('writes refreshed desktop tokens back to the kirocli:social:token key', async () => {
    const dbPath = makeCliDb('kirocli:social:token')
    process.env.KIROCLI_DB_PATH = dbPath

    await writeToKiroCli({
      authMethod: 'desktop',
      accessToken: 'NEW_ACCESS',
      refreshToken: 'NEW_REFRESH',
      expiresAt: Date.parse('2030-01-01T00:00:00.000Z')
    })

    const data = readToken(dbPath, 'kirocli:social:token')
    expect(data.access_token).toBe('NEW_ACCESS')
    expect(data.refresh_token).toBe('NEW_REFRESH')
  })
})
