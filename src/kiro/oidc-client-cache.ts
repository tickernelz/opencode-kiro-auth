import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { atomicWritePrivateJsonFile, withInterprocessFileLock } from '../plugin/opencode-auth.js'
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

function readCache(): Record<string, CachedOidcClient> | null {
  const path = cachePath()
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function updateCache(update: (cache: Record<string, CachedOidcClient>) => void): void {
  const path = cachePath()
  withInterprocessFileLock(path, () => {
    const cache = readCache()
    if (!cache) return
    update(cache)
    atomicWritePrivateJsonFile(path, cache)
  })
}

export function getCachedOidcClient(
  region: KiroRegion,
  startUrl: string,
  scopes: readonly string[]
): CachedOidcClient | undefined {
  const cache = readCache()
  const hit = cache?.[cacheKey(region, startUrl, scopes)]
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
  updateCache((cache) => {
    cache[cacheKey(region, startUrl, scopes)] = client
  })
}

export function deleteCachedOidcClient(
  region: KiroRegion,
  startUrl: string,
  scopes: readonly string[]
): void {
  updateCache((cache) => {
    delete cache[cacheKey(region, startUrl, scopes)]
  })
}
