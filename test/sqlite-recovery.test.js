import assert from 'node:assert/strict'
import { test } from 'node:test'

import { mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { cleanupSqliteSidecars } from '../dist/plugin/storage/sqlite-recovery.js'

test('cleanupSqliteSidecars removes orphaned -wal/-shm/.lock files', () => {
  const dir = join(tmpdir(), `opencode-kiro-auth-sqlite-recovery-${Date.now()}`)
  mkdirSync(dir, { recursive: true })

  const dbPath = join(dir, 'kiro.db')

  const wal = `${dbPath}-wal`
  const shm = `${dbPath}-shm`
  const lock = `${dbPath}.lock`

  writeFileSync(wal, 'x')
  writeFileSync(shm, 'x')
  writeFileSync(lock, 'x')

  assert.equal(existsSync(wal), true)
  assert.equal(existsSync(shm), true)
  assert.equal(existsSync(lock), true)

  cleanupSqliteSidecars(dbPath)

  assert.equal(existsSync(wal), false)
  assert.equal(existsSync(shm), false)
  assert.equal(existsSync(lock), false)

  rmSync(dir, { recursive: true, force: true })
})
