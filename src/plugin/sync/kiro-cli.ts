import Database from 'libsql'
import { existsSync } from 'node:fs'
import { extractRegionFromArn, normalizeRegion } from '../../constants'
import { createDeterministicAccountId } from '../accounts'
import * as logger from '../logger'
import { kiroDb } from '../storage/sqlite'
import { fetchUsageLimits } from '../usage'
import {
  findClientCredsRecursive,
  getCliDbPath,
  makePlaceholderEmail,
  normalizeExpiresAt,
  safeJsonParse
} from './kiro-cli-parser'
import { readActiveProfileArnFromKiroCli } from './kiro-cli-profile'
import {
  getStaleKiroCliAccountIds,
  STALE_CLI_ACCOUNT_REASON,
  type SyncedCliAccount
} from './stale-accounts'

export async function syncFromKiroCli() {
  const dbPath = getCliDbPath()
  if (!existsSync(dbPath)) return
  try {
    const cliDb = new Database(dbPath, { readonly: true })
    cliDb.pragma('busy_timeout = 5000')
    const rows = cliDb.prepare('SELECT key, value FROM auth_kv').all() as any[]
    let activeProfileArn: string | undefined
    try {
      const stateRow = cliDb
        .prepare('SELECT value FROM state WHERE key = ?')
        .get('api.codewhisperer.profile') as any
      const parsed = safeJsonParse(stateRow?.value)
      const arn = parsed?.arn || parsed?.profileArn || parsed?.profile_arn
      if (typeof arn === 'string' && arn.trim()) activeProfileArn = arn.trim()
    } catch {
      // Ignore state read failures; token import can proceed.
    }

    const deviceRegRow = rows.find(
      (r) => typeof r?.key === 'string' && r.key.includes('device-registration')
    )
    const deviceReg = safeJsonParse(deviceRegRow?.value)
    const regCreds = deviceReg ? findClientCredsRecursive(deviceReg) : {}
    const syncedAccounts: SyncedCliAccount[] = []

    for (const row of rows) {
      if (row.key.includes(':token')) {
        const data = safeJsonParse(row.value)
        if (!data) continue

        const isIdc = row.key.includes('odic') || row.key.includes('oidc')
        const authMethod = isIdc ? 'idc' : 'desktop'
        const oidcRegion = normalizeRegion(data.region)
        let profileArn: string | undefined = data.profile_arn || data.profileArn
        if (!profileArn && isIdc) profileArn = activeProfileArn || readActiveProfileArnFromKiroCli()
        const serviceRegion = extractRegionFromArn(profileArn) || oidcRegion
        const startUrl: string | undefined =
          typeof data.start_url === 'string'
            ? data.start_url
            : typeof data.startUrl === 'string'
              ? data.startUrl
              : undefined

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
        let subscriptionPlan: string | undefined
        let email: string | undefined
        let usageOk = false

        try {
          const authForUsage: any = {
            refresh: '',
            access: accessToken,
            expires: cliExpiresAt,
            authMethod,
            region: serviceRegion,
            profileArn,
            clientId,
            clientSecret,
            email: ''
          }
          const u = await fetchUsageLimits(authForUsage)
          usedCount = u.usedCount || 0
          limitCount = u.limitCount || 0
          subscriptionPlan = typeof u.subscriptionPlan === 'string' ? u.subscriptionPlan : undefined
          usageOk = true
          if (typeof u.email === 'string' && u.email) {
            email = u.email
          }
        } catch (e) {
          logger.warn('Kiro CLI sync: failed to fetch usage/email; falling back', {
            authMethod,
            serviceRegion,
            oidcRegion
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
            email = makePlaceholderEmail(authMethod, serviceRegion, clientId, profileArn)
          }
        }

        const resolvedEmail =
          email || makePlaceholderEmail(authMethod, serviceRegion, clientId, profileArn)

        const id = createDeterministicAccountId(resolvedEmail, authMethod, clientId, profileArn)
        const existingById = all.find((a) => a.id === id)
        if (
          existingById &&
          existingById.is_healthy === 1 &&
          existingById.refresh_token === refreshToken &&
          existingById.expires_at >= cliExpiresAt &&
          existingById.expires_at > Date.now()
        ) {
          if (!usageOk) continue
        }

        if (usageOk) {
          const placeholderEmail = makePlaceholderEmail(
            authMethod,
            serviceRegion,
            clientId,
            profileArn
          )
          const placeholderId = createDeterministicAccountId(
            placeholderEmail,
            authMethod,
            clientId,
            profileArn
          )
          if (placeholderId !== id) {
            const placeholderRow = all.find((a) => a.id === placeholderId)
            if (placeholderRow) {
              await kiroDb.upsertAccount({
                id: placeholderId,
                email: placeholderRow.email,
                authMethod,
                region: placeholderRow.region || serviceRegion,
                oidcRegion: placeholderRow.oidc_region || oidcRegion,
                clientId,
                clientSecret,
                profileArn,
                refreshToken: placeholderRow.refresh_token || refreshToken,
                accessToken: placeholderRow.access_token || accessToken,
                expiresAt: placeholderRow.expires_at || cliExpiresAt,
                rateLimitResetTime: 0,
                isHealthy: false,
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

        // When the usage fetch failed we must not advance the quota snapshot:
        // carry forward any existing quota and leave the quota sync timestamp
        // unchanged so mergeAccounts does not treat zeroed counts as newer.
        const carriedUsedCount = usageOk ? usedCount : existingById?.used_count || 0
        const carriedLimitCount = usageOk ? limitCount : existingById?.limit_count || 0
        const carriedSubscriptionPlan = usageOk
          ? subscriptionPlan
          : existingById?.subscription_plan || undefined
        const carriedLastSync = usageOk ? Date.now() : existingById?.last_sync || 0
        const refreshTokenUpdatedAt =
          existingById &&
          existingById.refresh_token !== refreshToken &&
          existingById.expires_at >= cliExpiresAt
            ? existingById.refresh_token_updated_at || 0
            : Date.now()

        await kiroDb.upsertAccount({
          id,
          email: resolvedEmail,
          authMethod,
          region: serviceRegion,
          oidcRegion,
          clientId,
          clientSecret,
          profileArn,
          startUrl,
          refreshToken,
          refreshTokenUpdatedAt,
          accessToken,
          expiresAt: cliExpiresAt,
          rateLimitResetTime: 0,
          isHealthy: true,
          failCount: 0,
          usedCount: carriedUsedCount,
          limitCount: carriedLimitCount,
          subscriptionPlan: carriedSubscriptionPlan,
          lastSync: carriedLastSync
        })

        syncedAccounts.push({
          id,
          email: resolvedEmail,
          authMethod,
          clientId,
          profileArn
        })
      }
    }

    const staleIds = getStaleKiroCliAccountIds(kiroDb.getAccounts(), syncedAccounts)
    if (staleIds.length > 0) {
      await kiroDb.markAccountsUnhealthy(staleIds, STALE_CLI_ACCOUNT_REASON)
      logger.warn('Kiro CLI sync: deactivated stale cached accounts', { count: staleIds.length })
    }

    cliDb.close()
  } catch (e) {
    logger.error('Sync failed', e)
  }
}

export async function writeToKiroCli(acc: any, previousRefreshToken?: string) {
  const dbPath = getCliDbPath()
  if (!existsSync(dbPath)) return
  try {
    const cliDb = new Database(dbPath)
    cliDb.pragma('busy_timeout = 5000')
    const rows = cliDb.prepare('SELECT key, value FROM auth_kv').all() as any[]
    const tokenRows = rows
      .filter((row) => {
        if (typeof row?.key !== 'string') return false
        if (acc.authMethod === 'idc') {
          return (
            row.key.includes(':token') && (row.key.includes('odic') || row.key.includes('oidc'))
          )
        }
        return row.key === 'kirocli:social:token' || row.key.endsWith('kirocli:social:token')
      })
      .map((row) => ({ row, data: safeJsonParse(row.value) }))
      .filter(({ data }) => data)

    const expected = {
      clientId: acc.clientId,
      profileArn: acc.profileArn,
      startUrl: acc.startUrl,
      refreshToken: previousRefreshToken || acc.refreshToken
    }
    const matches = tokenRows.filter(({ data }) => {
      const embedded = {
        clientId: data.client_id || data.clientId,
        profileArn: data.profile_arn || data.profileArn,
        startUrl: data.start_url || data.startUrl,
        refreshToken: data.refresh_token || data.refreshToken
      }
      if (expected.profileArn && !embedded.profileArn) {
        if (!expected.refreshToken || expected.refreshToken !== embedded.refreshToken) return false
      }
      let stableIdentityAgreed = false
      for (const key of ['clientId', 'profileArn', 'startUrl'] as const) {
        if (!expected[key] || !embedded[key]) continue
        if (expected[key] !== embedded[key]) return false
        stableIdentityAgreed = true
      }
      if (stableIdentityAgreed) return true
      return !!expected.refreshToken && expected.refreshToken === embedded.refreshToken
    })

    if (matches.length === 1) {
      const { row, data } = matches[0]!
      data.access_token = acc.accessToken
      data.refresh_token = acc.refreshToken
      data.expires_at = new Date(acc.expiresAt).toISOString()
      const result = cliDb
        .prepare('UPDATE auth_kv SET value = ? WHERE key = ? AND value = ?')
        .run(JSON.stringify(data), row.key, row.value)
      if (result.changes !== 1) {
        logger.warn('Write back skipped: Kiro CLI token changed concurrently', {
          authMethod: acc.authMethod
        })
      }
    } else if (matches.length > 1) {
      logger.warn('Write back skipped: Kiro CLI token identity is ambiguous', {
        authMethod: acc.authMethod,
        matches: matches.length
      })
    }
    cliDb.close()
  } catch (e) {
    logger.warn('Write back failed', e)
  }
}
