import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { putCachedOidcClient } from '../kiro/oidc-client-cache.js'

let configHome: string
let previousConfigHome: string | undefined

beforeEach(() => {
  previousConfigHome = process.env.XDG_CONFIG_HOME
  configHome = mkdtempSync(join(tmpdir(), 'kiro-oidc-cache-'))
  process.env.XDG_CONFIG_HOME = configHome
})

afterEach(() => {
  if (previousConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = previousConfigHome
  rmSync(configHome, { recursive: true, force: true })
})

describe('OIDC client cache', () => {
  test('preserves a malformed cache rather than replacing it', () => {
    const cacheDir = join(configHome, 'opencode')
    const cachePath = join(cacheDir, 'kiro-oidc-clients.json')
    mkdirSync(cacheDir, { recursive: true })
    writeFileSync(cachePath, '{"existing":')

    putCachedOidcClient('us-east-1', 'https://example.com', ['scope'], {
      clientId: 'client',
      clientSecret: 'secret'
    })

    expect(readFileSync(cachePath, 'utf-8')).toBe('{"existing":')
  })

  test('atomically preserves entries during concurrent process updates', async () => {
    const cachePath = join(configHome, 'opencode', 'kiro-oidc-clients.json')
    putCachedOidcClient('us-east-1', 'https://existing.example.com', ['scope'], {
      clientId: 'existing-client',
      clientSecret: 'existing-secret'
    })

    const moduleUrl = pathToFileURL(
      join(import.meta.dir, '..', 'kiro', 'oidc-client-cache.ts')
    ).href
    const workers = Array.from({ length: 12 }, (_, index) => {
      const script = `
        import { putCachedOidcClient } from ${JSON.stringify(moduleUrl)};
        putCachedOidcClient('us-east-1', 'https://client-${index}.example.com', ['scope'], {
          clientId: 'client-${index}', clientSecret: 'secret-${index}'
        });
      `
      return Bun.spawn([process.execPath, '-e', script], {
        env: { ...process.env, XDG_CONFIG_HOME: configHome },
        stdout: 'ignore',
        stderr: 'pipe'
      })
    })

    const results = await Promise.all(
      workers.map(async (worker) => ({
        exitCode: await worker.exited,
        stderr: await new Response(worker.stderr).text()
      }))
    )
    expect(results.filter((result) => result.exitCode !== 0)).toEqual([])

    const cache = JSON.parse(readFileSync(cachePath, 'utf-8'))
    expect(Object.keys(cache)).toHaveLength(13)
    expect(Object.values(cache)).toContainEqual({
      clientId: 'existing-client',
      clientSecret: 'existing-secret'
    })
    for (let index = 0; index < 12; index++) {
      expect(Object.values(cache)).toContainEqual({
        clientId: `client-${index}`,
        clientSecret: `secret-${index}`
      })
    }
    if (process.platform !== 'win32') expect(statSync(cachePath).mode & 0o777).toBe(0o600)
    expect(results.map((result) => result.stderr)).toEqual(Array(12).fill(''))
  })
})
