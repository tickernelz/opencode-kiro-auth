export function isPermanentError(reason?: string): boolean {
  if (!reason) return false
  return (
    reason.includes('Invalid refresh token') ||
    reason.includes('ExpiredTokenException') ||
    reason.includes('InvalidTokenException') ||
    reason.includes('HTTP_401') ||
    reason.includes('HTTP_403')
  )
}
