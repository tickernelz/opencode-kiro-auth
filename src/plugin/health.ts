export function isPermanentError(reason?: string): boolean {
  if (!reason) return false
  const normalized = reason.toLowerCase()
  return (
    normalized.includes('invalid refresh token') ||
    normalized.includes('invalid grant provided') ||
    normalized.includes('invalid_grant') ||
    normalized.includes('expiredtokenexception') ||
    normalized.includes('invalidtokenexception') ||
    normalized.includes('expiredclientexception') ||
    normalized.includes('client is expired') ||
    normalized.includes('bad credentials') ||
    normalized.includes('bearer token included in the request is invalid') ||
    normalized.includes('http_401') ||
    normalized.includes('http_403')
  )
}
