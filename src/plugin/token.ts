import { getOidcEndpoint } from '../constants'
import { decodeRefreshToken, encodeRefreshToken } from '../kiro/auth'
import { KiroTokenRefreshError } from './errors'
import type { KiroAuthDetails, RefreshParts } from './types'

const REFRESH_TIMEOUT_MS = 30000
const REFRESH_NETWORK_ATTEMPTS = 2
const REFRESH_RETRY_DELAY_MS = 200

function isTransientNetworkError(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code =
    (error as Error & { code?: string; cause?: { code?: string } }).code ||
    (error as Error & { cause?: { code?: string } }).cause?.code
  return (
    error.name === 'AbortError' ||
    error.name === 'TimeoutError' ||
    error.name === 'TypeError' ||
    ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code || '')
  )
}

export async function refreshAccessToken(auth: KiroAuthDetails): Promise<KiroAuthDetails> {
  const p = decodeRefreshToken(auth.refresh)
  const isIdc = auth.authMethod === 'idc'
  const oidcRegion = auth.oidcRegion || auth.region
  const url = isIdc
    ? `${getOidcEndpoint(oidcRegion)}/token`
    : `https://prod.${auth.region}.auth.desktop.kiro.dev/refreshToken`

  if (isIdc && (!p.clientId || !p.clientSecret)) {
    throw new KiroTokenRefreshError('Missing creds', 'MISSING_CREDENTIALS')
  }

  const requestBody: any = isIdc
    ? {
        refreshToken: p.refreshToken,
        clientId: p.clientId,
        clientSecret: p.clientSecret,
        grantType: 'refresh_token'
      }
    : {
        refreshToken: p.refreshToken
      }

  const ua = isIdc
    ? 'aws-sdk-js/3.738.0 ua/2.1 os/other lang/js md/browser#unknown_unknown api/sso-oidc#3.738.0 m/E KiroIDE'
    : 'aws-sdk-js/3.0.0 KiroIDE-0.1.0 os/macos lang/js md/nodejs/18.0.0'

  try {
    let res: Response | undefined
    for (let attempt = 0; attempt < REFRESH_NETWORK_ATTEMPTS; attempt++) {
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'amz-sdk-request': `attempt=${attempt + 1}; max=${REFRESH_NETWORK_ATTEMPTS}`,
            'x-amzn-kiro-agent-mode': 'vibe',
            'user-agent': ua,
            Connection: 'close'
          },
          body: JSON.stringify(requestBody),
          signal: AbortSignal.timeout(REFRESH_TIMEOUT_MS)
        })
        break
      } catch (error) {
        if (attempt + 1 >= REFRESH_NETWORK_ATTEMPTS || !isTransientNetworkError(error)) throw error
        await new Promise((resolve) => setTimeout(resolve, REFRESH_RETRY_DELAY_MS))
      }
    }

    if (!res) throw new Error('Token refresh did not receive a response')

    if (!res.ok) {
      const txt = await res.text()
      let data: any = {}
      try {
        data = JSON.parse(txt)
      } catch {
        data = { message: txt }
      }
      throw new KiroTokenRefreshError(
        `Refresh failed: ${data.message || data.error_description || txt}`,
        data.__type || data.error || `HTTP_${res.status}`
      )
    }

    const d = await res.json()
    const acc = d.access_token || d.accessToken

    if (!acc) throw new KiroTokenRefreshError('No access token', 'INVALID_RESPONSE')

    const upP: RefreshParts = {
      refreshToken: d.refresh_token || d.refreshToken || p.refreshToken,
      clientId: p.clientId,
      clientSecret: p.clientSecret,
      authMethod: auth.authMethod
    }

    return {
      refresh: encodeRefreshToken(upP),
      access: acc,
      expires: Date.now() + (d.expires_in || d.expiresIn || 3600) * 1000,
      authMethod: auth.authMethod,
      region: auth.region,
      oidcRegion: auth.oidcRegion,
      profileArn: auth.profileArn,
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      email: auth.email || d.userInfo?.email
    }
  } catch (error) {
    if (error instanceof KiroTokenRefreshError) throw error
    throw new KiroTokenRefreshError(
      `Token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'NETWORK_ERROR',
      error instanceof Error ? error : undefined
    )
  }
}
