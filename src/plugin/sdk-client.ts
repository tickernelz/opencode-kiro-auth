import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import * as crypto from 'crypto'
import { KIRO_CONSTANTS, buildUrl } from '../constants.js'
import type { KiroAuthDetails } from './types'

const KIRO_VERSION = '0.11.63'

function getMachineId(auth: KiroAuthDetails): string {
  const key = auth.profileArn || auth.email || 'default'
  return crypto.createHash('sha256').update(key).digest('hex')
}

/**
 * Resolve the correct chat endpoint for the given auth details.
 *
 * - Accounts with a profileArn (Kiro Pro / Q Developer Pro) → runtime.kiro.dev
 *   This endpoint serves all models including third-party ones (glm-5, minimax, …).
 *   It requires a profileArn on every request and returns 400 without one.
 *
 * - Accounts without a profileArn (free AWS Builder ID) → q.amazonaws.com
 *   This endpoint accepts the same token + request shape but only serves
 *   Claude-family models. Using runtime.kiro.dev here causes a 400.
 */
export function resolveKiroEndpoint(auth: KiroAuthDetails): string {
  const region = auth.region || 'us-east-1'
  if (auth.profileArn) {
    return buildUrl(KIRO_CONSTANTS.RUNTIME_URL, region as any)
  }
  return buildUrl(KIRO_CONSTANTS.BASE_URL, region as any)
}

const clientCache = new Map<
  string,
  { client: CodeWhispererStreamingClient; token: string; endpoint: string }
>()

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string
): CodeWhispererStreamingClient {
  const endpoint = resolveKiroEndpoint(auth)
  // Cache key includes endpoint so a token refresh that also changes endpoint
  // (unlikely but possible) gets a fresh client.
  const cacheKey = `${region}:${auth.email || 'default'}:${endpoint}`
  const cached = clientCache.get(cacheKey)

  if (cached && cached.token === auth.access) {
    return cached.client
  }

  // Token rotated (refresh) or endpoint changed — tear down the stale client
  // so its sockets/agent don't leak before we replace the cache entry.
  if (cached) {
    try {
      cached.client.destroy()
    } catch {}
  }

  const machineId = getMachineId(auth)
  const token = auth.access

  // Strip the path portion — the SDK constructs the full URL from region + endpoint.
  const endpointBase = endpoint.replace(/\/generateAssistantResponse$/, '')

  const client = new CodeWhispererStreamingClient({
    region,
    endpoint: endpointBase,
    token: () => Promise.resolve({ token }),
    maxAttempts: 1,
    customUserAgent: [[`${KIRO_CONSTANTS.USER_AGENT}-${KIRO_VERSION}-${machineId}`]],
    requestHandler: {
      connectionTimeout: 10000,
      requestTimeout: 120000
    }
  })

  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      args.request.headers['x-amzn-kiro-agent-mode'] = 'vibe'
      args.request.headers['x-amzn-codewhisperer-optout'] = 'true'
      return next(args)
    },
    { step: 'build', name: 'addKiroHeaders' }
  )

  clientCache.set(cacheKey, { client, token, endpoint })
  return client
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) {
    entry.client.destroy()
  }
  clientCache.clear()
}
