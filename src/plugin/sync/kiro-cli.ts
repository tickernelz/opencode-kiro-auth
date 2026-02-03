import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { normalizeRegion } from '../../constants.js'
import { createDeterministicAccountId } from '../accounts'
import * as logger from '../logger'
import { kiroDb } from '../storage/sqlite'
import { fetchUsageLimits } from '../usage'
import { setIdcRegionFromState } from './idc-region'
import {
  findClientCredsRecursive,
  getCliDbPath,
  makePlaceholderEmail,
  normalizeExpiresAt,
  safeJsonParse
} from './kiro-cli-parser'

function extractProfileArnFromAccessToken(accessToken: string | undefined): string | undefined {
  if (!accessToken || !accessToken.includes('.')) return undefined
  const parts = accessToken.split('.')
  if (parts.length < 2 || !parts[1]) return undefined
  try {
    const payload = Buffer.from(parts[1], 'base64').toString('utf8')
    const data = JSON.parse(payload)
    return data.profileArn || data.profile_arn || data['profile_arn'] || undefined
  } catch {
    return undefined
  }
}

export async function syncFromKiroCli() {
  const dbPath = getCliDbPath()
  if (!existsSync(dbPath)) return
  try {
    const cliDb = new Database(dbPath, { readonly: true })
    cliDb.run('PRAGMA busy_timeout = 5000')
    const rows = cliDb.prepare('SELECT key, value FROM auth_kv').all() as any[]

    let profileArnFromState: string | undefined
    try {
      const idcRegionRow = cliDb
        .prepare('SELECT value FROM state WHERE key = ?')
        .get('auth.idc.region') as { value?: string } | undefined
      const parsedRegion = safeJsonParse(idcRegionRow?.value)
      if (typeof parsedRegion === 'string') {
        setIdcRegionFromState(parsedRegion)
      }
      const profileRow = cliDb
        .prepare('SELECT value FROM state WHERE key = ?')
        .get('api.codewhisperer.profile') as { value?: string } | undefined
      const profile = safeJsonParse(profileRow?.value)
      if (profile && typeof profile.arn === 'string') {
        profileArnFromState = profile.arn
      }
    } catch {
      setIdcRegionFromState(undefined)
    }

    const tokenRows = rows.filter((r) => typeof r?.key === 'string' && r.key.includes(':token'))
    const parsedTokens = tokenRows
      .map((row) => {
        const data = safeJsonParse(row.value)
        const expiresAt = normalizeExpiresAt(data?.expires_at ?? data?.expiresAt)
        return { row, data, expiresAt }
      })
      .filter((t) => t.data)

    const now = Date.now()
    const validTokens = parsedTokens.filter((t) => t.expiresAt > now)
    const candidates = validTokens.length ? validTokens : parsedTokens

    let tokenRowsToImport = tokenRows
    if (candidates.length > 0) {
      const maxExpiresAt = Math.max(...candidates.map((t) => t.expiresAt || 0))
      tokenRowsToImport = candidates.filter((t) => t.expiresAt === maxExpiresAt).map((t) => t.row)
    }

    const deviceRegRows = rows.filter(
      (r) => typeof r?.key === 'string' && r.key.includes('device-registration')
    )
    const deviceRegByKey = new Map<string, { clientId?: string; clientSecret?: string }>()
    for (const row of deviceRegRows) {
      const deviceReg = safeJsonParse(row.value)
      const regCreds = deviceReg ? findClientCredsRecursive(deviceReg) : {}
      if (regCreds.clientId && regCreds.clientSecret) {
        const baseKey = row.key.replace(':device-registration', '')
        deviceRegByKey.set(baseKey, regCreds)
      }
    }

    const importedIds = new Set<string>()

    for (const row of tokenRowsToImport) {
      if (row.key.includes(':token')) {
        const data = safeJsonParse(row.value)
        if (!data) continue

        const isIdc = row.key.includes('odic') || row.key.includes('oidc')
        const authMethod = isIdc ? 'idc' : 'desktop'
        const accessToken = data.access_token || data.accessToken || ''
        const profileArn = data.profile_arn || data.profileArn || profileArnFromState
        const regionFromProfile = profileArn?.split(':')[3]
        const region = normalizeRegion(regionFromProfile || data.region)
        const refreshToken = data.refresh_token || data.refreshToken
        if (!refreshToken) continue

        const baseKey = row.key.replace(':token', '')
        const regCreds =
          deviceRegByKey.get(baseKey) ||
          deviceRegByKey.get(baseKey.replace('kirocli', 'codewhisperer')) ||
          deviceRegByKey.get(baseKey.replace('codewhisperer', 'kirocli')) ||
          {}

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
          existingById.expires_at >= cliExpiresAt &&
          existingById.region === region
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
              usedCount = Math.max(usedCount, placeholderRow.used_count || 0)
              limitCount = Math.max(limitCount, placeholderRow.limit_count || 0)
            }

            // We enforce a unique index on refresh_token. When we later insert the real-email
            // account (different id) using the same refresh token, a placeholder row would
            // violate that constraint. Delete it now; it will be recreated under the real id.
            await kiroDb.deleteAccount(placeholderId)
          }
        }

        await kiroDb.upsertAccount({
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
          rateLimitResetTime: 0,
          isHealthy: true,
          failCount: 0,
          usedCount,
          limitCount,
          lastSync: Date.now()
        })
        importedIds.add(id)
      }
    }

    const existing = kiroDb.getAccounts()
    for (const acc of existing) {
      if (
        typeof acc?.email === 'string' &&
        acc.email.endsWith('@awsapps.local') &&
        acc.auth_method === 'idc' &&
        !importedIds.has(acc.id)
      ) {
        await kiroDb.deleteAccount(acc.id)
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
