import type { KiroAuthDetails, RefreshParts } from '../plugin/types'

export function decodeRefreshToken(refresh: string): RefreshParts {
  const parts = refresh.split('|')
  if (parts.length < 2) return { refreshToken: parts[0]!, authMethod: 'desktop' }
  const refreshToken = parts[0]!
  const authMethod = parts[parts.length - 1] as any
  if (authMethod === 'idc')
    return { refreshToken, clientId: parts[1], clientSecret: parts[2], authMethod: 'idc' }
  if (authMethod === 'identity-center')
    return { refreshToken, clientId: parts[1], clientSecret: parts[2], startUrl: parts[3], authMethod: 'identity-center' }
  if (authMethod === 'desktop') return { refreshToken, authMethod: 'desktop' }
  return { refreshToken, authMethod: 'desktop' }
}

export function accessTokenExpired(auth: KiroAuthDetails, bufferMs = 120000): boolean {
  if (!auth.access || !auth.expires) return true
  return Date.now() >= auth.expires - bufferMs
}

export function validateAuthDetails(auth: KiroAuthDetails): boolean {
  if (!auth.refresh) return false
  if (auth.authMethod === 'idc') return !!auth.clientId && !!auth.clientSecret
  return true
}

export function encodeRefreshToken(parts: RefreshParts): string {
  if (parts.authMethod === 'idc') {
    if (!parts.clientId || !parts.clientSecret) throw new Error('Missing credentials')
    return `${parts.refreshToken}|${parts.clientId}|${parts.clientSecret}|idc`
  }
  if (parts.authMethod === 'identity-center') {
    if (!parts.clientId || !parts.clientSecret || !parts.startUrl) throw new Error('Missing credentials or start URL')
    return `${parts.refreshToken}|${parts.clientId}|${parts.clientSecret}|${parts.startUrl}|identity-center`
  }
  return `${parts.refreshToken}|desktop`
}
