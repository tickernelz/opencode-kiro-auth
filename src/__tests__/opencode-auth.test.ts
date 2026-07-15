import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  atomicWritePrivateJsonFile,
  ensureOpenCodeAuthPlaceholder,
  getOpenCodeAuthPath
} from '../plugin/opencode-auth.js'

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

  test('leaves non-object auth.json content untouched', () => {
    const authPath = getOpenCodeAuthPath()
    mkdirSync(join(authPath, '..'), { recursive: true })
    writeFileSync(authPath, '[{"provider":"github"}]')

    ensureOpenCodeAuthPlaceholder()

    expect(readFileSync(authPath, 'utf-8')).toBe('[{"provider":"github"}]')
  })

  test('creates a fresh placeholder file when auth.json is missing', () => {
    const authPath = getOpenCodeAuthPath()
    expect(existsSync(authPath)).toBe(false)

    ensureOpenCodeAuthPlaceholder()

    const data = JSON.parse(readFileSync(authPath, 'utf-8'))
    expect(data.kiro).toEqual({ type: 'api', key: PLACEHOLDER_KEY })
    if (process.platform !== 'win32') expect(statSync(authPath).mode & 0o777).toBe(0o600)
    expect(readdirSync(join(authPath, '..')).filter((name) => name.endsWith('.tmp'))).toEqual([])
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

  test('preserves all providers during concurrent process updates', async () => {
    const authPath = getOpenCodeAuthPath()
    mkdirSync(join(authPath, '..'), { recursive: true })
    writeFileSync(authPath, JSON.stringify({ github: { type: 'api', key: 'existing' } }))
    const moduleUrl = pathToFileURL(join(import.meta.dir, '..', 'plugin', 'opencode-auth.ts')).href
    const workers = Array.from({ length: 8 }, (_, index) =>
      Bun.spawn(
        [
          process.execPath,
          '-e',
          `import { ensureOpenCodeAuthPlaceholder } from ${JSON.stringify(moduleUrl)};
           ensureOpenCodeAuthPlaceholder('provider-${index}');`
        ],
        {
          env: { ...process.env, XDG_DATA_HOME: dataHome },
          stdout: 'ignore',
          stderr: 'pipe'
        }
      )
    )

    const results = await Promise.all(
      workers.map(async (worker) => ({
        exitCode: await worker.exited,
        stderr: await new Response(worker.stderr).text()
      }))
    )
    expect(results.filter((result) => result.exitCode !== 0)).toEqual([])

    const data = JSON.parse(readFileSync(authPath, 'utf-8'))
    expect(data.github).toEqual({ type: 'api', key: 'existing' })
    for (let index = 0; index < 8; index++) {
      expect(data[`provider-${index}`]).toEqual({ type: 'api', key: PLACEHOLDER_KEY })
    }
    expect(results.map((result) => result.stderr)).toEqual(Array(8).fill(''))
  })

  test('cleans up the private temp file when atomic replacement fails', () => {
    const target = join(dataHome, 'target-directory')
    mkdirSync(target)

    expect(() => atomicWritePrivateJsonFile(target, { secret: true })).toThrow()

    expect(readdirSync(dataHome)).toEqual(['target-directory'])
  })

  test('does not rewrite when the placeholder already exists', () => {
    const authPath = getOpenCodeAuthPath()
    mkdirSync(join(authPath, '..'), { recursive: true })
    const existing = JSON.stringify({ kiro: { type: 'api', key: PLACEHOLDER_KEY } }, null, 2)
    writeFileSync(authPath, existing)

    ensureOpenCodeAuthPlaceholder()

    expect(readFileSync(authPath, 'utf-8')).toBe(existing)
  })

  test('repairs permissive permissions without rewriting existing auth', () => {
    if (process.platform === 'win32') return
    const authPath = getOpenCodeAuthPath()
    mkdirSync(join(authPath, '..'), { recursive: true })
    writeFileSync(authPath, JSON.stringify({ kiro: { type: 'api', key: PLACEHOLDER_KEY } }))
    chmodSync(authPath, 0o644)

    ensureOpenCodeAuthPlaceholder()

    expect(statSync(authPath).mode & 0o777).toBe(0o600)
  })
})
