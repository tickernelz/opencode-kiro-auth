import crypto from 'node:crypto'
import { decodeRefreshToken, encodeRefreshToken } from '../kiro/auth'
import { KiroTokenRefreshError } from './errors'
import type { KiroAuthDetails, RefreshParts } from './types'

export async function refreshAccessToken(auth: KiroAuthDetails): Promise<KiroAuthDetails> {
  const p = decodeRefreshToken(auth.refresh)
  const isSsoOidc = auth.authMethod === 'idc' || auth.authMethod === 'identity-center'
  const url = isSsoOidc
    ? `https://oidc.${auth.region}.amazonaws.com/token`
    : `https://prod.${auth.region}.auth.desktop.kiro.dev/refreshToken`

  if (isSsoOidc && (!p.clientId || !p.clientSecret)) {
    throw new KiroTokenRefreshError('Missing creds', 'MISSING_CREDENTIALS')
  }

  const requestBody: any = isSsoOidc
    ? {
        refreshToken: p.refreshToken,
        clientId: p.clientId,
        clientSecret: p.clientSecret,
        grantType: 'refresh_token'
      }
    : {
        refreshToken: p.refreshToken
      }

  const machineId = crypto
    .createHash('sha256')
    .update(auth.profileArn || auth.clientId || 'KIRO_DEFAULT_MACHINE')
    .digest('hex')
  const ua = isSsoOidc ? 'aws-sdk-js/1.0.0' : `KiroIDE-0.7.45-${machineId}`

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amzn-kiro-agent-mode': 'vibe',
        'user-agent': ua,
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

    if (!acc) throw new KiroTokenRefreshError('No access token', 'INVALID_RESPONSE')

    const upP: RefreshParts = {
      refreshToken: d.refresh_token || d.refreshToken || p.refreshToken,
      clientId: p.clientId,
      clientSecret: p.clientSecret,
      startUrl: p.startUrl,
      authMethod: auth.authMethod
    }

    return {
      refresh: encodeRefreshToken(upP),
      access: acc,
      expires: Date.now() + (d.expires_in || d.expiresIn || 3600) * 1000,
      authMethod: auth.authMethod,
      region: auth.region,
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
