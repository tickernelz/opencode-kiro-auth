import { Database } from 'bun:sqlite'
import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { writeToKiroCli } from '../plugin/sync/kiro-cli.js'

const created: string[] = []

type TokenRow = { key: string; value?: Record<string, unknown> }

function makeCliDb(...rows: TokenRow[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'kirocli-test-'))
  created.push(dir)
  const dbPath = join(dir, 'data.sqlite3')
  const db = new Database(dbPath)
  db.run('CREATE TABLE auth_kv (key TEXT PRIMARY KEY, value TEXT)')
  const insert = db.prepare('INSERT INTO auth_kv (key, value) VALUES (?, ?)')
  for (const row of rows) {
    insert.run(
      row.key,
      JSON.stringify({
        access_token: 'OLD_ACCESS',
        refresh_token: 'OLD_REFRESH',
        expires_at: '2020-01-01T00:00:00.000Z',
        ...row.value
      })
    )
  }
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
    const dbPath = makeCliDb({
      key: 'kirocli:oidc:token',
      value: { client_id: 'matching-client' }
    })
    process.env.KIROCLI_DB_PATH = dbPath

    await writeToKiroCli({
      authMethod: 'idc',
      clientId: 'matching-client',
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
    const dbPath = makeCliDb({ key: 'kirocli:odic:token' })
    process.env.KIROCLI_DB_PATH = dbPath

    await writeToKiroCli(
      {
        authMethod: 'idc',
        accessToken: 'NEW_ACCESS',
        refreshToken: 'NEW_REFRESH',
        expiresAt: Date.parse('2030-01-01T00:00:00.000Z')
      },
      'OLD_REFRESH'
    )

    const data = readToken(dbPath, 'kirocli:odic:token')
    expect(data.access_token).toBe('NEW_ACCESS')
    expect(data.refresh_token).toBe('NEW_REFRESH')
  })

  test('writes refreshed desktop tokens back to the kirocli:social:token key', async () => {
    const dbPath = makeCliDb({ key: 'kirocli:social:token' })
    process.env.KIROCLI_DB_PATH = dbPath

    await writeToKiroCli(
      {
        authMethod: 'desktop',
        accessToken: 'NEW_ACCESS',
        refreshToken: 'NEW_REFRESH',
        expiresAt: Date.parse('2030-01-01T00:00:00.000Z')
      },
      'OLD_REFRESH'
    )

    const data = readToken(dbPath, 'kirocli:social:token')
    expect(data.access_token).toBe('NEW_ACCESS')
    expect(data.refresh_token).toBe('NEW_REFRESH')
  })

  test('updates only the IDC row whose embedded identity matches', async () => {
    const dbPath = makeCliDb(
      {
        key: 'kirocli:oidc:token',
        value: { client_id: 'other-client', refresh_token: 'OTHER_REFRESH' }
      },
      {
        key: 'workspace:kirocli:odic:token',
        value: { client_id: 'matching-client', refresh_token: 'MATCHING_REFRESH' }
      }
    )
    process.env.KIROCLI_DB_PATH = dbPath

    await writeToKiroCli(
      {
        authMethod: 'idc',
        clientId: 'matching-client',
        accessToken: 'NEW_ACCESS',
        refreshToken: 'NEW_REFRESH',
        expiresAt: Date.parse('2030-01-01T00:00:00.000Z')
      },
      'MATCHING_REFRESH'
    )

    expect(readToken(dbPath, 'kirocli:oidc:token').access_token).toBe('OLD_ACCESS')
    expect(readToken(dbPath, 'workspace:kirocli:odic:token').access_token).toBe('NEW_ACCESS')
  })

  test('skips writeback when multiple rows match the account identity', async () => {
    const dbPath = makeCliDb(
      { key: 'kirocli:oidc:token', value: { client_id: 'shared-client' } },
      { key: 'workspace:kirocli:odic:token', value: { client_id: 'shared-client' } }
    )
    process.env.KIROCLI_DB_PATH = dbPath

    await writeToKiroCli({
      authMethod: 'idc',
      clientId: 'shared-client',
      accessToken: 'NEW_ACCESS',
      refreshToken: 'NEW_REFRESH',
      expiresAt: Date.parse('2030-01-01T00:00:00.000Z')
    })

    expect(readToken(dbPath, 'kirocli:oidc:token').access_token).toBe('OLD_ACCESS')
    expect(readToken(dbPath, 'workspace:kirocli:odic:token').access_token).toBe('OLD_ACCESS')
  })

  test('does not prefer the canonical key when another row is the identity match', async () => {
    const dbPath = makeCliDb(
      { key: 'kirocli:oidc:token', value: { profile_arn: 'profile-other' } },
      { key: 'workspace:kirocli:odic:token', value: { profile_arn: 'profile-match' } }
    )
    process.env.KIROCLI_DB_PATH = dbPath

    await writeToKiroCli({
      authMethod: 'idc',
      profileArn: 'profile-match',
      accessToken: 'NEW_ACCESS',
      refreshToken: 'NEW_REFRESH',
      expiresAt: Date.parse('2030-01-01T00:00:00.000Z')
    })

    expect(readToken(dbPath, 'kirocli:oidc:token').access_token).toBe('OLD_ACCESS')
    expect(readToken(dbPath, 'workspace:kirocli:odic:token').access_token).toBe('NEW_ACCESS')
  })

  test('does not match a profile account only by a shared client ID', async () => {
    const dbPath = makeCliDb({
      key: 'kirocli:oidc:token',
      value: { client_id: 'shared-client', refresh_token: 'OTHER_REFRESH' }
    })
    process.env.KIROCLI_DB_PATH = dbPath

    await writeToKiroCli(
      {
        authMethod: 'idc',
        clientId: 'shared-client',
        profileArn: 'arn:aws:codewhisperer:us-east-1:123456789012:profile/ONE',
        accessToken: 'NEW_ACCESS',
        refreshToken: 'NEW_REFRESH',
        expiresAt: Date.parse('2030-01-01T00:00:00.000Z')
      },
      'MATCHING_REFRESH'
    )

    expect(readToken(dbPath, 'kirocli:oidc:token').access_token).toBe('OLD_ACCESS')
    expect(readToken(dbPath, 'kirocli:oidc:token').refresh_token).toBe('OTHER_REFRESH')
  })
})
