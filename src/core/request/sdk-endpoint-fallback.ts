export function shouldFallbackSdkEndpointError(error: any): boolean {
  const status = error?.$metadata?.httpStatusCode
  if (status === 400 || status === 403 || status === 404 || status === 405) return true
  if (status === 429) return false

  const text = `${error?.name || ''} ${error?.code || ''} ${error?.message || ''}`.toLowerCase()
  return (
    text.includes('failedtoopensocket') ||
    text.includes('failed to open socket') ||
    text.includes('enotfound') ||
    text.includes('econnrefused') ||
    text.includes('unknownoperation') ||
    text.includes('invalidsignature') ||
    text.includes('not found')
  )
}
