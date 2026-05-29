import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureOpenCodeAuthPlaceholder, getOpenCodeAuthPath } from '../plugin/opencode-auth.js'

const PLACEHOLDER_KEY = 'opencode-kiro-auth-placeholder'

let dataHome: string
let prevXdg: string | undefined
const created: string[] = []

beforeEach(() => {
  prevXdg = process.env.XDG_DATA_HOME
  dataHome = mkdtempSync(join(tmpdir(), 'octest-'))
  created.push(dataHome)
  process.env.XDG_DATA_HOME = dataHome
})

afterEach(() => {
  if (prevXdg === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = prevXdg
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('ensureOpenCodeAuthPlaceholder', () => {
  test('leaves a malformed auth.json untouched and does not drop other providers', () => {
    const authPath = getOpenCodeAuthPath()
    mkdirSync(join(authPath, '..'), { recursive: true })
    const corrupt = '{ "anthropic": { "type": "api", "key": "SECRET_ANT'
    writeFileSync(authPath, corrupt)

    ensureOpenCodeAuthPlaceholder()

    expect(readFileSync(authPath, 'utf-8')).toBe(corrupt)
  })

  test('creates a fresh placeholder file when auth.json is missing', () => {
    const authPath = getOpenCodeAuthPath()
    expect(existsSync(authPath)).toBe(false)

    ensureOpenCodeAuthPlaceholder()

    const data = JSON.parse(readFileSync(authPath, 'utf-8'))
    expect(data.kiro).toEqual({ type: 'api', key: PLACEHOLDER_KEY })
  })

  test('keeps existing providers and adds the placeholder for valid auth.json', () => {
    const authPath = getOpenCodeAuthPath()
    mkdirSync(join(authPath, '..'), { recursive: true })
    writeFileSync(authPath, JSON.stringify({ anthropic: { type: 'api', key: 'SECRET' } }, null, 2))

    ensureOpenCodeAuthPlaceholder()

    const data = JSON.parse(readFileSync(authPath, 'utf-8'))
    expect(data.anthropic).toEqual({ type: 'api', key: 'SECRET' })
    expect(data.kiro).toEqual({ type: 'api', key: PLACEHOLDER_KEY })
  })

  test('does not rewrite when the placeholder already exists', () => {
    const authPath = getOpenCodeAuthPath()
    mkdirSync(join(authPath, '..'), { recursive: true })
    const existing = JSON.stringify({ kiro: { type: 'api', key: PLACEHOLDER_KEY } }, null, 2)
    writeFileSync(authPath, existing)

    ensureOpenCodeAuthPlaceholder()

    expect(readFileSync(authPath, 'utf-8')).toBe(existing)
  })
})
