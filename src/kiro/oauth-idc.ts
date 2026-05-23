import { KIRO_AUTH_SERVICE, KIRO_CONSTANTS, buildUrl, normalizeRegion } from '../constants'
import type { KiroRegion } from '../plugin/types'
import {
  deleteCachedOidcClient,
  getCachedOidcClient,
  putCachedOidcClient,
  type CachedOidcClient
} from './oidc-client-cache'

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
  startUrl: string
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
  startUrl?: string
): Promise<KiroIDCAuthorization> {
  const effectiveRegion = normalizeRegion(region)
  const ssoOIDCEndpoint = buildUrl(KIRO_AUTH_SERVICE.SSO_OIDC_ENDPOINT, effectiveRegion)
  const effectiveStartUrl = startUrl || KIRO_AUTH_SERVICE.BUILDER_ID_START_URL

  const registerClient = async (): Promise<CachedOidcClient> => {
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
    const { clientId, clientSecret, clientSecretExpiresAt } = registerData

    if (!clientId || !clientSecret) {
      const error = new Error('Client registration response missing clientId or clientSecret')
      throw error
    }

    const client = { clientId, clientSecret, clientSecretExpiresAt }
    putCachedOidcClient(effectiveRegion, effectiveStartUrl, KIRO_AUTH_SERVICE.SCOPES, client)
    return client
  }

  const startDeviceAuthorization = async (client: CachedOidcClient) => {
    const deviceAuthResponse = await fetch(`${ssoOIDCEndpoint}/device_authorization`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': KIRO_CONSTANTS.USER_AGENT
      },
      body: JSON.stringify({
        clientId: client.clientId,
        clientSecret: client.clientSecret,
        startUrl: effectiveStartUrl
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
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      interval,
      expiresIn,
      region: effectiveRegion,
      startUrl: effectiveStartUrl
    }
  }

  let client =
    getCachedOidcClient(effectiveRegion, effectiveStartUrl, KIRO_AUTH_SERVICE.SCOPES) ||
    (await registerClient())

  try {
    return await startDeviceAuthorization(client)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/invalid_client|expired/i.test(message)) {
      deleteCachedOidcClient(effectiveRegion, effectiveStartUrl, KIRO_AUTH_SERVICE.SCOPES)
      client = await registerClient()
      return await startDeviceAuthorization(client)
    }
    throw error
  }
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

      const responseText = await tokenResponse.text().catch(() => '')
      let tokenData: any = {}
      if (responseText) {
        try {
          tokenData = JSON.parse(responseText)
        } catch (parseError: any) {
          throw new Error(
            `Token polling failed: invalid JSON response (HTTP ${tokenResponse.status}): ${responseText.slice(0, 300)}`
          )
        }
      }

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

      const accessToken = tokenData.access_token || tokenData.accessToken
      const refreshToken = tokenData.refresh_token || tokenData.refreshToken
      const tokenExpiresIn = tokenData.expires_in || tokenData.expiresIn

      if (accessToken && refreshToken) {
        const expiresInSeconds = tokenExpiresIn || 3600
        const expiresAt = Date.now() + expiresInSeconds * 1000

        return {
          refreshToken,
          accessToken,
          expiresAt,
          email: 'builder-id@aws.amazon.com',
          clientId,
          clientSecret,
          region: effectiveRegion,
          authMethod: 'idc'
        }
      }

      if (!tokenResponse.ok) {
        const error = new Error(
          `Token request failed with status: ${tokenResponse.status} ${
            responseText ? `(${responseText.slice(0, 200)})` : ''
          }`
        )
        throw error
      }

      // If the service returned HTTP 200 but no tokens and no error, treat as invalid response.
      throw new Error(
        `Token polling failed: missing tokens in response: ${responseText ? responseText.slice(0, 300) : '[empty]'}`
      )
    } catch (error) {
      if (
        error instanceof Error &&
        (error.message.includes('Device code has expired') ||
          error.message.includes('Authorization was denied') ||
          error.message.startsWith('Token polling failed:') ||
          error.message.startsWith('Token request failed'))
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
