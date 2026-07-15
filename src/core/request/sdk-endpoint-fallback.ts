import { getSdkEndpoint, type ResolvedSdkEndpointMode } from '../../plugin/sdk-client'

export function shouldFallbackSdkEndpointError(error: any): boolean {
  const status = error?.$metadata?.httpStatusCode
  if (status === 429) return false
  if (status === 404 || status === 405) return true

  const text = `${error?.name || ''} ${error?.code || ''} ${error?.message || ''}`.toLowerCase()
  const networkFailure =
    text.includes('failedtoopensocket') ||
    text.includes('failed to open socket') ||
    text.includes('enotfound') ||
    text.includes('econnrefused') ||
    text.includes('econnreset') ||
    text.includes('etimedout') ||
    text.includes('eai_again') ||
    text.includes('socket hang up') ||
    text.includes('connect timeout')
  if (networkFailure) return true

  const operationFailure =
    text.includes('unknownoperation') ||
    text.includes('unknown operation') ||
    text.includes('unsupported operation') ||
    text.includes('operation not found') ||
    text.includes('method not allowed')
  return (
    operationFailure && (status === undefined || status === 400 || status === 404 || status === 405)
  )
}

export function deduplicateSdkEndpointModes(
  region: string,
  endpointModes: ResolvedSdkEndpointMode[]
): ResolvedSdkEndpointMode[] {
  const urls = new Set<string>()
  return endpointModes.filter((mode) => {
    const url = getSdkEndpoint(region, mode)
    if (urls.has(url)) return false
    urls.add(url)
    return true
  })
}
