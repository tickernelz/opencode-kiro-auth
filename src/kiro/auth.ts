import type { KiroAuthDetails, RefreshParts } from '../plugin/types'

export function decodeRefreshToken(refresh: string): RefreshParts {
  const parts = refresh.split('|')
  if (parts.length < 2) return { refreshToken: parts[0]!, authMethod: 'idc' }
  const refreshToken = parts[0]!
  const authMethod = parts[parts.length - 1]!
  
  if (authMethod === 'idc') {
    return { refreshToken, clientId: parts[1], clientSecret: parts[2], authMethod: 'idc' }
  }
  
  if (authMethod === 'sso') {
    return {
      refreshToken,
      clientId: parts[1],
      clientSecret: parts[2],
      ssoStartUrl: parts[3],
      authMethod: 'sso'
    }
  }
  
  return { refreshToken, authMethod: 'idc' }
}

export function accessTokenExpired(auth: KiroAuthDetails, bufferMs = 120000): boolean {
  if (!auth.access || !auth.expires) return true
  return Date.now() >= auth.expires - bufferMs
}

export function validateAuthDetails(auth: KiroAuthDetails): boolean {
  if (!auth.refresh || !auth.clientId || !auth.clientSecret) return false
  
  if (auth.authMethod === 'idc') {
    return true
  }
  
  if (auth.authMethod === 'sso') {
    return !!auth.ssoStartUrl
  }
  
  return false
}

export function encodeRefreshToken(parts: RefreshParts): string {
  if (!parts.clientId || !parts.clientSecret) throw new Error('Missing credentials')
  
  if (parts.authMethod === 'sso') {
    if (!parts.ssoStartUrl) throw new Error('Missing SSO start URL')
    return `${parts.refreshToken}|${parts.clientId}|${parts.clientSecret}|${parts.ssoStartUrl}|sso`
  }
  
  return `${parts.refreshToken}|${parts.clientId}|${parts.clientSecret}|idc`
}
