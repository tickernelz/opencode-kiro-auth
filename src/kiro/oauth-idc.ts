import { KIRO_AUTH_SERVICE, KIRO_CONSTANTS, buildUrl, normalizeRegion } from '../constants.js'
import type { KiroRegion } from '../plugin/types.js'

export interface KiroIDCAuthorization {
  verificationUrl: string
  verificationUriComplete: string
  userCode: string
  deviceCode: string
  clientId: string
  clientSecret: string
  interval: number
  expiresIn: number
  region: KiroRegion
}

export interface KiroIDCTokenResult {
  refreshToken: string
  accessToken: string
  expiresAt: number
  email: string
  clientId: string
  clientSecret: string
  region: KiroRegion
  authMethod: 'idc'
}

export async function authorizeKiroIDC(
  region?: KiroRegion,
  builderIdStartUrl?: string
): Promise<KiroIDCAuthorization> {
  const effectiveRegion = normalizeRegion(region)
  const ssoOIDCEndpoint = buildUrl(KIRO_AUTH_SERVICE.SSO_OIDC_ENDPOINT, effectiveRegion)

  const startUrl = await resolveStartUrl(
    builderIdStartUrl || KIRO_AUTH_SERVICE.BUILDER_ID_START_URL,
    KIRO_CONSTANTS.USER_AGENT
  )

  try {
    const registerResponse = await fetch(`${ssoOIDCEndpoint}/client/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': KIRO_CONSTANTS.USER_AGENT
      },
      body: JSON.stringify({
        clientName: 'Kiro IDE',
        clientType: 'public',
        scopes: KIRO_AUTH_SERVICE.SCOPES,
        grantTypes: ['urn:ietf:params:oauth:grant-type:device_code', 'refresh_token']
      })
    })

    if (!registerResponse.ok) {
      const errorText = await registerResponse.text().catch(() => '')
      const error = new Error(`Client registration failed: ${registerResponse.status} ${errorText}`)
      throw error
    }

    const registerData = await registerResponse.json()
    const { clientId, clientSecret } = registerData

    if (!clientId || !clientSecret) {
      const error = new Error('Client registration response missing clientId or clientSecret')
      throw error
    }

    const deviceAuthResponse = await fetch(`${ssoOIDCEndpoint}/device_authorization`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': KIRO_CONSTANTS.USER_AGENT
      },
      body: JSON.stringify({
        clientId,
        clientSecret,
        startUrl
      })
    })

    if (!deviceAuthResponse.ok) {
      const errorText = await deviceAuthResponse.text().catch(() => '')
      const error = new Error(
        `Device authorization failed: ${deviceAuthResponse.status} ${errorText}`
      )
      throw error
    }

    const deviceAuthData = await deviceAuthResponse.json()

    const {
      verificationUri,
      verificationUriComplete,
      userCode,
      deviceCode,
      interval = 5,
      expiresIn = 600
    } = deviceAuthData

    if (!deviceCode || !userCode || !verificationUri || !verificationUriComplete) {
      const error = new Error('Device authorization response missing required fields')
      throw error
    }

    return {
      verificationUrl: verificationUri,
      verificationUriComplete,
      userCode,
      deviceCode,
      clientId,
      clientSecret,
      interval,
      expiresIn,
      region: effectiveRegion
    }
  } catch (error) {
    throw error
  }
}

function normalizeStartUrl(input: string): string {
  let u: URL
  try {
    u = new URL(input)
  } catch {
    throw new Error('Invalid start URL provided')
  }

  // AWS device authorization expects a start URL for the org, typically ending with /start.
  // Users often paste deep links with fragments (/#/...) or extra paths; normalize to origin + /start.
  return `${u.origin}/start`
}

async function resolveStartUrl(input: string, userAgent: string): Promise<string> {
  const candidate = normalizeStartUrl(input)
  const parsed = new URL(candidate)

  // Best effort: follow redirects to discover the canonical access portal hostname.
  // Some orgs use vanity domains that redirect to the underlying d-*.awsapps.com portal.
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 4000)
    const res = await fetch(candidate, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': userAgent },
      signal: controller.signal
    })
    clearTimeout(timeout)

    const finalUrl = res.url ? new URL(res.url) : null
    if (finalUrl) {
      const host = finalUrl.hostname.toLowerCase()
      if (host.endsWith('.awsapps.com') || host === 'view.awsapps.com') {
        return `${finalUrl.origin}/start`
      }
    }
  } catch {
    // Ignore and fall back to candidate.
  }

  // If there was no useful redirect, return normalized origin/start.
  return `${parsed.origin}/start`
}

export async function pollKiroIDCToken(
  clientId: string,
  clientSecret: string,
  deviceCode: string,
  interval: number,
  expiresIn: number,
  region: KiroRegion
): Promise<KiroIDCTokenResult> {
  if (!clientId || !clientSecret || !deviceCode) {
    const error = new Error('Missing required parameters for token polling')
    throw error
  }

  const effectiveRegion = normalizeRegion(region)
  const ssoOIDCEndpoint = buildUrl(KIRO_AUTH_SERVICE.SSO_OIDC_ENDPOINT, effectiveRegion)

  const maxAttempts = Math.floor(expiresIn / interval)
  let currentInterval = interval * 1000
  let attempts = 0

  while (attempts < maxAttempts) {
    attempts++

    await new Promise((resolve) => setTimeout(resolve, currentInterval))

    try {
      const tokenResponse = await fetch(`${ssoOIDCEndpoint}/token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': KIRO_CONSTANTS.USER_AGENT
        },
        body: JSON.stringify({
          clientId,
          clientSecret,
          deviceCode,
          grantType: 'urn:ietf:params:oauth:grant-type:device_code'
        })
      })

      const tokenData = await tokenResponse.json()

      if (tokenData.error) {
        const errorType = tokenData.error

        if (errorType === 'authorization_pending') {
          continue
        }

        if (errorType === 'slow_down') {
          currentInterval += 5000
          continue
        }

        if (errorType === 'expired_token') {
          const error = new Error(
            'Device code has expired. Please restart the authorization process.'
          )
          throw error
        }

        if (errorType === 'access_denied') {
          const error = new Error('Authorization was denied by the user.')
          throw error
        }

        const error = new Error(
          `Token polling failed: ${errorType} - ${tokenData.error_description || ''}`
        )
        throw error
      }

      if (tokenData.accessToken && tokenData.refreshToken) {
        const expiresInSeconds = tokenData.expiresIn || 3600
        const expiresAt = Date.now() + expiresInSeconds * 1000

        return {
          refreshToken: tokenData.refreshToken,
          accessToken: tokenData.accessToken,
          expiresAt,
          email: 'builder-id@aws.amazon.com',
          clientId,
          clientSecret,
          region: effectiveRegion,
          authMethod: 'idc'
        }
      }

      if (!tokenResponse.ok) {
        const error = new Error(`Token request failed with status: ${tokenResponse.status}`)
        throw error
      }
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('expired') ||
          error.message.includes('denied') ||
          error.message.includes('failed'))
      ) {
        throw error
      }

      if (attempts >= maxAttempts) {
        const finalError = new Error(
          `Token polling failed after ${attempts} attempts: ${error instanceof Error ? error.message : 'Unknown error'}`
        )
        throw finalError
      }
    }
  }

  const timeoutError = new Error('Token polling timed out. Authorization may have expired.')
  throw timeoutError
}
