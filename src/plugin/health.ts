export function isPermanentError(reason?: string): boolean {
  if (!reason) return false
  return (
    reason.includes('Invalid refresh token') ||
    reason.includes('Invalid grant provided') ||
    reason.includes('invalid_grant') ||
    reason.includes('ExpiredTokenException') ||
    reason.includes('InvalidTokenException') ||
    reason.includes('ExpiredClientException') ||
    reason.includes('Client is expired') ||
    reason.includes('HTTP_401') ||
    reason.includes('Account Suspended') ||
    reason.includes('invalid_client') ||
    reason.includes('Invalid client ID provided')
  )
}
