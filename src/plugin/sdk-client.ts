import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { KIRO_CONSTANTS } from '../constants.js'
import type { KiroAuthDetails } from './types'

export type ResolvedSdkEndpointMode = 'kiro-runtime' | 'legacy-q'

const clientCache = new Map<string, { client: CodeWhispererStreamingClient; token: string }>()

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string,
  endpointMode: ResolvedSdkEndpointMode = 'kiro-runtime'
): CodeWhispererStreamingClient {
  const cacheKey = `${region}:${endpointMode}:${auth.email || auth.clientId || 'default'}`
  const cached = clientCache.get(cacheKey)

  if (cached && cached.token === auth.access) {
    return cached.client
  }

  const token = auth.access
  const clientConfig: ConstructorParameters<typeof CodeWhispererStreamingClient>[0] = {
    region,
    token: () => Promise.resolve({ token }),
    maxAttempts: 1,
    customUserAgent: [[KIRO_CONSTANTS.USER_AGENT]]
  }

  if (endpointMode === 'kiro-runtime') {
    clientConfig.endpoint = `https://runtime.${region}.kiro.dev`
  } else if (endpointMode === 'legacy-q') {
    clientConfig.endpoint = `https://q.${region}.amazonaws.com`
  }

  const client = new CodeWhispererStreamingClient(clientConfig)

  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      args.request.headers['x-amzn-kiro-agent-mode'] = 'vibe'
      return next(args)
    },
    { step: 'build', name: 'addKiroHeaders' }
  )

  clientCache.set(cacheKey, { client, token })
  return client
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) {
    entry.client.destroy()
  }
  clientCache.clear()
}
