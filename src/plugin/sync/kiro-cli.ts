import { Database } from 'bun:sqlite'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir, platform } from 'node:os'
import { join } from 'node:path'
import { createDeterministicAccountId } from '../accounts'
import * as logger from '../logger'
import { kiroDb } from '../storage/sqlite'
import { fetchUsageLimits } from '../usage'

function getCliDbPath(): string {
  const override = process.env.KIROCLI_DB_PATH
  if (override) return override
  const p = platform()
  if (p === 'win32')
    return join(
      process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'),
      'kiro-cli',
      'data.sqlite3'
    )
  if (p === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'kiro-cli', 'data.sqlite3')
  return join(homedir(), '.local', 'share', 'kiro-cli', 'data.sqlite3')
}

function safeJsonParse(value: unknown): any | null {
  if (typeof value !== 'string') return null
  try {
    return JSON.parse(value)
  } catch {
    return null
  }
}

function normalizeExpiresAt(input: unknown): number {
  if (typeof input === 'number') {
    // Heuristic: < 10^10 is likely seconds.
    return input < 10_000_000_000 ? input * 1000 : input
  }
  if (typeof input === 'string' && input.trim()) {
    const t = new Date(input).getTime()
    if (!Number.isNaN(t) && t > 0) return t
    const n = Number(input)
    if (Number.isFinite(n) && n > 0) return normalizeExpiresAt(n)
  }
  return 0
}

function findClientCredsRecursive(input: unknown): { clientId?: string; clientSecret?: string } {
  const root = input as any
  if (!root || typeof root !== 'object') return {}

  const stack: any[] = [root]
  const visited = new Set<any>()
  while (stack.length) {
    const cur = stack.pop()
    if (!cur || typeof cur !== 'object') continue
    if (visited.has(cur)) continue
    visited.add(cur)

    const clientId = cur.client_id || cur.clientId
    const clientSecret = cur.client_secret || cur.clientSecret
    if (typeof clientId === 'string' && typeof clientSecret === 'string') {
      if (clientId && clientSecret) return { clientId, clientSecret }
    }

    if (Array.isArray(cur)) {
      for (const v of cur) stack.push(v)
      continue
    }
    for (const v of Object.values(cur)) stack.push(v)
  }
  return {}
}

function makePlaceholderEmail(
  authMethod: string,
  region: string,
  clientId?: string,
  profileArn?: string
): string {
  const seed = `${authMethod}:${region}:${clientId || ''}:${profileArn || ''}`
  const h = createHash('sha256').update(seed).digest('hex').slice(0, 16)
  return `${authMethod}-placeholder+${h}@awsapps.local`
}

export async function syncFromKiroCli() {
  const dbPath = getCliDbPath()
  if (!existsSync(dbPath)) return
  try {
    const cliDb = new Database(dbPath, { readonly: true })
    cliDb.run('PRAGMA busy_timeout = 5000')
    const rows = cliDb.prepare('SELECT key, value FROM auth_kv').all() as any[]

    const deviceRegRow = rows.find(
      (r) => typeof r?.key === 'string' && r.key.includes('device-registration')
    )
    const deviceReg = safeJsonParse(deviceRegRow?.value)
    const regCreds = deviceReg ? findClientCredsRecursive(deviceReg) : {}

    for (const row of rows) {
      if (row.key.includes(':token')) {
        const data = safeJsonParse(row.value)
        if (!data) continue

        const isIdc = row.key.includes('odic')
        const authMethod = isIdc ? 'idc' : 'desktop'
        const region = data.region || 'us-east-1'
        const profileArn = data.profile_arn || data.profileArn

        const accessToken = data.access_token || data.accessToken || ''
        const refreshToken = data.refresh_token || data.refreshToken
        if (!refreshToken) continue

        const clientId = data.client_id || data.clientId || (isIdc ? regCreds.clientId : undefined)
        const clientSecret =
          data.client_secret || data.clientSecret || (isIdc ? regCreds.clientSecret : undefined)

        if (authMethod === 'idc' && (!clientId || !clientSecret)) {
          logger.warn('Kiro CLI sync: missing IDC device credentials; skipping token import')
          continue
        }

        const cliExpiresAt =
          normalizeExpiresAt(data.expires_at ?? data.expiresAt) || Date.now() + 3600000

        let usedCount = 0
        let limitCount = 0
        let email: string | undefined
        let usageOk = false

        try {
          const authForUsage: any = {
            refresh: '',
            access: accessToken,
            expires: cliExpiresAt,
            authMethod,
            region,
            profileArn,
            clientId,
            clientSecret,
            email: ''
          }
          const u = await fetchUsageLimits(authForUsage)
          usedCount = u.usedCount || 0
          limitCount = u.limitCount || 0
          if (typeof u.email === 'string' && u.email) {
            email = u.email
            usageOk = true
          }
        } catch (e) {
          logger.warn('Kiro CLI sync: failed to fetch usage/email; falling back', {
            authMethod,
            region
          })
          logger.debug('Kiro CLI sync: usage fetch error', e)
        }

        const all = kiroDb.getAccounts()
        if (!email) {
          let existing: any | undefined
          if (profileArn) {
            existing = all.find((a) => a.auth_method === authMethod && a.profile_arn === profileArn)
          }
          if (!existing && authMethod === 'idc' && clientId) {
            existing = all.find((a) => a.auth_method === 'idc' && a.client_id === clientId)
          }
          if (existing && typeof existing.email === 'string' && existing.email) {
            email = existing.email
          } else {
            email = makePlaceholderEmail(authMethod, region, clientId, profileArn)
          }
        }

        const resolvedEmail =
          email || makePlaceholderEmail(authMethod, region, clientId, profileArn)

        const id = createDeterministicAccountId(resolvedEmail, authMethod, clientId, profileArn)
        const existingById = all.find((a) => a.id === id)
        if (
          existingById &&
          existingById.is_healthy === 1 &&
          existingById.expires_at >= cliExpiresAt
        )
          continue

        if (usageOk) {
          const placeholderEmail = makePlaceholderEmail(authMethod, region, clientId, profileArn)
          const placeholderId = createDeterministicAccountId(
            placeholderEmail,
            authMethod,
            clientId,
            profileArn
          )
          if (placeholderId !== id) {
            const placeholderRow = all.find((a) => a.id === placeholderId)
            if (placeholderRow) {
              kiroDb.upsertAccount({
                id: placeholderId,
                email: placeholderRow.email,
                authMethod,
                region: placeholderRow.region || region,
                clientId,
                clientSecret,
                profileArn,
                refreshToken: placeholderRow.refresh_token || refreshToken,
                accessToken: placeholderRow.access_token || accessToken,
                expiresAt: placeholderRow.expires_at || cliExpiresAt,
                isHealthy: 0,
                failCount: 10,
                unhealthyReason: 'Replaced by real email',
                recoveryTime: Date.now() + 31536000000,
                usedCount: placeholderRow.used_count || 0,
                limitCount: placeholderRow.limit_count || 0,
                lastSync: Date.now()
              })
            }
          }
        }

        kiroDb.upsertAccount({
          id,
          email: resolvedEmail,
          authMethod,
          region,
          clientId,
          clientSecret,
          profileArn,
          refreshToken,
          accessToken,
          expiresAt: cliExpiresAt,
          isHealthy: 1,
          failCount: 0,
          usedCount,
          limitCount,
          lastSync: Date.now()
        })
      }
    }
    cliDb.close()
  } catch (e) {
    logger.error('Sync failed', e)
  }
}

export async function writeToKiroCli(acc: any) {
  const dbPath = getCliDbPath()
  if (!existsSync(dbPath)) return
  try {
    const cliDb = new Database(dbPath)
    cliDb.run('PRAGMA busy_timeout = 5000')
    const rows = cliDb.prepare('SELECT key, value FROM auth_kv').all() as any[]
    const targetKey = acc.authMethod === 'idc' ? 'kirocli:odic:token' : 'kirocli:social:token'
    const row = rows.find((r) => r.key === targetKey || r.key.endsWith(targetKey))
    if (row) {
      const data = JSON.parse(row.value)
      data.access_token = acc.accessToken
      data.refresh_token = acc.refreshToken
      data.expires_at = new Date(acc.expiresAt).toISOString()
      cliDb.prepare('UPDATE auth_kv SET value = ? WHERE key = ?').run(JSON.stringify(data), row.key)
    }
    cliDb.close()
  } catch (e) {
    logger.warn('Write back failed', e)
  }
}
