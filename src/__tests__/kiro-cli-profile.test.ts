import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string
let dbPath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'kiro-profile-test-'))
  dbPath = join(dir, 'data.sqlite3')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('readActiveProfileArnFromKiroCli', () => {
  test('returns undefined when DB file does not exist', async () => {
    process.env.KIROCLI_DB_PATH = join(dir, 'nonexistent.sqlite3')
    const { readActiveProfileArnFromKiroCli } = await import('../plugin/sync/kiro-cli-profile.js')
    expect(readActiveProfileArnFromKiroCli()).toBeUndefined()
    delete process.env.KIROCLI_DB_PATH
  })

  test('returns profileArn from state table', async () => {
    process.env.KIROCLI_DB_PATH = dbPath
    const db = new Database(dbPath)
    db.run('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)')
    db.run('INSERT INTO state (key, value) VALUES (?, ?)', [
      'api.codewhisperer.profile',
      JSON.stringify({ arn: 'arn:aws:codewhisperer:eu-central-1:123:profile/ABC' })
    ])
    db.close()

    const { readActiveProfileArnFromKiroCli } = await import('../plugin/sync/kiro-cli-profile.js')
    const result = readActiveProfileArnFromKiroCli()
    expect(result).toBe('arn:aws:codewhisperer:eu-central-1:123:profile/ABC')
    delete process.env.KIROCLI_DB_PATH
  })

  test('returns undefined when row is missing', async () => {
    process.env.KIROCLI_DB_PATH = dbPath
    const db = new Database(dbPath)
    db.run('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)')
    db.close()

    const { readActiveProfileArnFromKiroCli } = await import('../plugin/sync/kiro-cli-profile.js')
    expect(readActiveProfileArnFromKiroCli()).toBeUndefined()
    delete process.env.KIROCLI_DB_PATH
  })

  test('returns undefined when JSON has no arn field', async () => {
    process.env.KIROCLI_DB_PATH = dbPath
    const db = new Database(dbPath)
    db.run('CREATE TABLE state (key TEXT PRIMARY KEY, value TEXT)')
    db.run('INSERT INTO state (key, value) VALUES (?, ?)', [
      'api.codewhisperer.profile',
      JSON.stringify({ other: 'field' })
    ])
    db.close()

    const { readActiveProfileArnFromKiroCli } = await import('../plugin/sync/kiro-cli-profile.js')
    expect(readActiveProfileArnFromKiroCli()).toBeUndefined()
    delete process.env.KIROCLI_DB_PATH
  })
})
