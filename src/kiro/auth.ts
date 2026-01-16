import type { KiroAuthDetails, RefreshParts } from '../plugin/types'

export function decodeRefreshToken(refresh: string): RefreshParts {
  const parts = refresh.split('|')
  if (parts.length < 2) return { refreshToken: parts[0]!, authMethod: 'idc' }
  const refreshToken = parts[0]!
  const authMethod = parts[parts.length - 1]!
  if (authMethod === 'idc')
    return { refreshToken, clientId: parts[1], clientSecret: parts[2], authMethod: 'idc' }
  return { refreshToken, authMethod: 'idc' }
}

export function accessTokenExpired(auth: KiroAuthDetails, bufferMs = 120000): boolean {
  if (!auth.access || !auth.expires) return true
  return Date.now() >= auth.expires - bufferMs
}

export function validateAuthDetails(auth: KiroAuthDetails): boolean {
  return !!auth.refresh && auth.authMethod === 'idc' && !!auth.clientId && !!auth.clientSecret
}

export function encodeRefreshToken(parts: RefreshParts): string {
  if (!parts.clientId || !parts.clientSecret) throw new Error('Missing credentials')
  return `${parts.refreshToken}|${parts.clientId}|${parts.clientSecret}|idc`
}
