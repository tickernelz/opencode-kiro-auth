import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { KiroRegion } from '../plugin/types'

const CACHE_FILENAME = 'kiro-oidc-clients.json'
const EXPIRY_SAFETY_MS = 24 * 60 * 60 * 1000

export interface CachedOidcClient {
  clientId: string
  clientSecret: string
  clientSecretExpiresAt?: number
}

function getConfigDir(): string {
  const platform = process.platform
  if (platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(xdgConfig, 'opencode')
}

function cachePath(): string {
  return join(getConfigDir(), CACHE_FILENAME)
}

function cacheKey(region: KiroRegion, startUrl: string, scopes: readonly string[]): string {
  return createHash('sha256')
    .update(`${region}\0${startUrl}\0${scopes.join(' ')}`)
    .digest('hex')
}

function readCache(): Record<string, CachedOidcClient> {
  const path = cachePath()
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function writeCache(cache: Record<string, CachedOidcClient>): void {
  const path = cachePath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(cache, null, 2), { encoding: 'utf-8', mode: 0o600 })
}

export function getCachedOidcClient(
  region: KiroRegion,
  startUrl: string,
  scopes: readonly string[]
): CachedOidcClient | undefined {
  const cache = readCache()
  const hit = cache[cacheKey(region, startUrl, scopes)]
  if (!hit?.clientId || !hit.clientSecret) return undefined
  if (
    hit.clientSecretExpiresAt &&
    hit.clientSecretExpiresAt * 1000 <= Date.now() + EXPIRY_SAFETY_MS
  ) {
    return undefined
  }
  return hit
}

export function putCachedOidcClient(
  region: KiroRegion,
  startUrl: string,
  scopes: readonly string[],
  client: CachedOidcClient
): void {
  const cache = readCache()
  cache[cacheKey(region, startUrl, scopes)] = client
  writeCache(cache)
}

export function deleteCachedOidcClient(
  region: KiroRegion,
  startUrl: string,
  scopes: readonly string[]
): void {
  const cache = readCache()
  delete cache[cacheKey(region, startUrl, scopes)]
  writeCache(cache)
}
