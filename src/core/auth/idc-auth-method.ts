import type { AuthOuathResult } from '@opencode-ai/plugin'
import { execFile } from 'node:child_process'
import { extractRegionFromArn, normalizeRegion } from '../../constants.js'
import type { AccountRepository } from '../../infrastructure/database/account-repository.js'
import { authorizeKiroIDC, pollKiroIDCToken } from '../../kiro/oauth-idc.js'
import { createDeterministicAccountId } from '../../plugin/accounts.js'
import * as logger from '../../plugin/logger.js'
import { makePlaceholderEmail } from '../../plugin/sync/kiro-cli-parser.js'
import { readActiveProfileArnFromKiroCli } from '../../plugin/sync/kiro-cli-profile.js'
import type { KiroRegion, ManagedAccount } from '../../plugin/types.js'
import { fetchUsageLimits } from '../../plugin/usage.js'

const openBrowser = (url: string) => {
  const platform = process.platform
  const [bin, ...args] =
    platform === 'win32'
      ? ['cmd', '/c', 'start', '', url]
      : platform === 'darwin'
        ? ['open', url]
        : ['xdg-open', url]
  execFile(bin!, args, (error) => {
    if (error) logger.warn(`Browser error: ${error.message}`)
  })
}

function normalizeStartUrl(raw: string | undefined): string | undefined {
  if (!raw) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined

  const url = new URL(trimmed)
  url.hash = ''
  url.search = ''

  // Normalize common portal URL shapes to end in `/start` (AWS Builder ID and IAM Identity Center)
  if (url.pathname.endsWith('/start/')) url.pathname = url.pathname.replace(/\/start\/$/, '/start')
  if (!url.pathname.endsWith('/start')) url.pathname = url.pathname.replace(/\/+$/, '') + '/start'

  return url.toString()
}

function buildDeviceUrl(startUrl: string, userCode: string): string {
  const url = new URL(startUrl)
  url.search = ''
  // Prefer `/start/` (with trailing slash) to match AWS portal URLs like `/start/#/device?...`.
  if (url.pathname.endsWith('/start')) url.pathname = `${url.pathname}/`
  url.pathname = url.pathname.replace(/\/start\/?$/, '/start/')
  url.hash = `#/device?user_code=${encodeURIComponent(userCode)}`
  return url.toString()
}

export class IdcAuthMethod {
  constructor(
    private config: any,
    private repository: AccountRepository,
    private accountManager: any
  ) {}

  async authorize(inputs?: Record<string, string>): Promise<AuthOuathResult> {
    const configuredServiceRegion: KiroRegion = this.config.default_region
    const invokedWithoutPrompts = !inputs || Object.keys(inputs).length === 0

    const startUrl = normalizeStartUrl(inputs?.start_url || this.config.idc_start_url) || undefined
    // For the OIDC device-code flow, prefer explicit idc_region, then fall back to
    // the region from a pre-configured profileArn, then default_region. This ensures
    // accounts with a eu-central-1 profileArn don't hit oidc.us-east-1.amazonaws.com.
    const configuredProfileArn = this.config.idc_profile_arn
    const arnRegion = extractRegionFromArn(configuredProfileArn)
    const oidcRegion: KiroRegion = normalizeRegion(
      inputs?.idc_region || this.config.idc_region || arnRegion || configuredServiceRegion
    )
    logger.log('IDC authorize: resolved defaults', {
      hasInputs: !!inputs && Object.keys(inputs).length > 0,
      invokedWithoutPrompts,
      startUrlSource: inputs?.start_url ? 'inputs' : this.config.idc_start_url ? 'config' : 'none',
      oidcRegion,
      startUrl: startUrl ? new URL(startUrl).origin : undefined
    })

    // Step 1: get device code + verification URL (fast)
    const auth = await authorizeKiroIDC(oidcRegion, startUrl)

    // If a custom Identity Center start URL is provided, prefer the portal device page.
    // This avoids the AWS Builder ID device page (which often prompts for an email)
    // and routes the user into their org's IAM Identity Center sign-in.
    const verificationUrl = startUrl
      ? buildDeviceUrl(startUrl, auth.userCode)
      : auth.verificationUriComplete || auth.verificationUrl

    // Open the *AWS* verification page directly (no local web server).
    openBrowser(verificationUrl)

    return {
      url: verificationUrl,
      instructions: `Open the verification URL and complete sign-in.\nCode: ${auth.userCode}`,
      method: 'auto',
      callback: async (): Promise<{ type: 'success'; key: string } | { type: 'failed' }> => {
        try {
          // Step 2: poll until token is issued (standard device-code flow)
          const token = await pollKiroIDCToken(
            auth.clientId,
            auth.clientSecret,
            auth.deviceCode,
            auth.interval,
            auth.expiresIn,
            oidcRegion
          )

          const profileArn =
            inputs?.profile_arn?.trim() || configuredProfileArn || readActiveProfileArnFromKiroCli()
          const serviceRegion = extractRegionFromArn(profileArn) || configuredServiceRegion
          let usage: any = { usedCount: 0, limitCount: 0, email: undefined }
          try {
            usage = await fetchUsageLimits({
              refresh: '',
              access: token.accessToken,
              expires: token.expiresAt,
              authMethod: 'idc',
              region: serviceRegion,
              clientId: token.clientId,
              clientSecret: token.clientSecret,
              profileArn
            })
          } catch (e) {
            logger.warn('fetchUsageLimits failed during auth', {
              error: e instanceof Error ? e.message : String(e)
            })
            if (startUrl && !profileArn) {
              throw new Error(
                `Missing profile ARN for IAM Identity Center. Set "idc_profile_arn" in ~/.config/opencode/kiro.json, or run "kiro-cli profile" once so it can be auto-detected. Original error: ${
                  e instanceof Error ? e.message : String(e)
                }`
              )
            }
            const errMsg = e instanceof Error ? e.message : String(e)
            if (errMsg.includes('FEATURE_NOT_SUPPORTED')) {
              logger.warn('fetchUsageLimits returned FEATURE_NOT_SUPPORTED; skipping usage check', {
                serviceRegion,
                profileArn
              })
              usage = {
                usedCount: 0,
                limitCount: 0,
                email: undefined
              }
            } else {
              throw e
            }
          }

          if (!usage.email) {
            try {
              const tokenParts = token.accessToken.split('.')
              if (tokenParts.length === 3 && tokenParts[1]) {
                const payload = JSON.parse(Buffer.from(tokenParts[1], 'base64').toString())
                usage.email = payload.email || payload.sub
              }
            } catch {}
          }

          const email =
            usage.email || makePlaceholderEmail('idc', serviceRegion, token.clientId, profileArn)
          const id = createDeterministicAccountId(email, 'idc', token.clientId, profileArn)
          const acc: ManagedAccount = {
            id,
            email,
            authMethod: 'idc',
            region: serviceRegion,
            oidcRegion: oidcRegion,
            clientId: token.clientId,
            clientSecret: token.clientSecret,
            profileArn,
            startUrl: startUrl || undefined,
            refreshToken: token.refreshToken,
            accessToken: token.accessToken,
            expiresAt: token.expiresAt,
            rateLimitResetTime: 0,
            isHealthy: true,
            failCount: 0,
            usedCount: usage.usedCount,
            limitCount: usage.limitCount
          }

          await this.repository.save(acc)
          this.accountManager?.addAccount?.(acc)

          return { type: 'success', key: token.accessToken }
        } catch (e: any) {
          const err = e instanceof Error ? e : new Error(String(e))
          logger.error('IDC auth callback failed', err)
          throw new Error(
            `IDC authorization failed: ${err.message}. Check ~/.config/opencode/kiro-logs/plugin.log for details. If this is an Identity Center account, ensure you have selected an AWS Q Developer/CodeWhisperer profile (try: kiro-cli profile).`
          )
        }
      }
    }
  }
}
