import type { KiroAuthDetails, RefreshParts } from './types'
import { KiroTokenRefreshError } from './errors'
import { decodeRefreshToken, encodeRefreshToken } from '../kiro/auth'

export async function refreshAccessToken(auth: KiroAuthDetails): Promise<KiroAuthDetails> {
  const url = `https://oidc.${auth.region}.amazonaws.com/token`
  const p = decodeRefreshToken(auth.refresh)

  if (!p.clientId || !p.clientSecret) {
    throw new KiroTokenRefreshError('Missing creds', 'MISSING_CREDENTIALS')
  }

  if (auth.authMethod === 'sso' && !p.ssoStartUrl) {
    throw new KiroTokenRefreshError('Missing SSO start URL', 'MISSING_SSO_URL')
  }

  const requestBody = {
    refreshToken: p.refreshToken,
    clientId: p.clientId,
    clientSecret: p.clientSecret,
    grantType: 'refresh_token'
  }

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amzn-kiro-agent-mode': 'vibe',
        Connection: 'close'
      },
      body: JSON.stringify(requestBody)
    })

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
        data.error || `HTTP_${res.status}`
      )
    }

    const d = await res.json()
    const acc = d.access_token || d.accessToken

    if (!acc) {
      throw new KiroTokenRefreshError('No access token', 'INVALID_RESPONSE')
    }

    const upP: RefreshParts = {
      refreshToken: d.refresh_token || d.refreshToken || p.refreshToken,
      clientId: p.clientId,
      clientSecret: p.clientSecret,
      authMethod: auth.authMethod,
      ssoStartUrl: p.ssoStartUrl
    }

    return {
      refresh: encodeRefreshToken(upP),
      access: acc,
      expires: Date.now() + (d.expires_in || 3600) * 1000,
      authMethod: auth.authMethod,
      region: auth.region,
      clientId: auth.clientId,
      clientSecret: auth.clientSecret,
      email: auth.email,
      ssoStartUrl: auth.ssoStartUrl
    }
  } catch (error) {
    if (error instanceof KiroTokenRefreshError) {
      throw error
    }
    throw new KiroTokenRefreshError(
      `Token refresh failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'NETWORK_ERROR',
      error instanceof Error ? error : undefined
    )
  }
}
