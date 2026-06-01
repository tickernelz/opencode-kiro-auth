import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import * as crypto from 'crypto'
import { KIRO_CONSTANTS } from '../constants.js'
import type { KiroAuthDetails } from './types'

const KIRO_VERSION = '0.11.63'

function getMachineId(auth: KiroAuthDetails): string {
  const key = auth.profileArn || auth.email || 'default'
  return crypto.createHash('sha256').update(key).digest('hex')
}

const clientCache = new Map<string, { client: CodeWhispererStreamingClient; token: string }>()

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string
): CodeWhispererStreamingClient {
  const cacheKey = `${region}:${auth.email || 'default'}`
  const cached = clientCache.get(cacheKey)

  if (cached && cached.token === auth.access) {
    return cached.client
  }

  // Token rotated (refresh) — tear down the stale client so its sockets/agent
  // don't leak before we replace the cache entry.
  if (cached) {
    try {
      cached.client.destroy()
    } catch {}
  }

  const machineId = getMachineId(auth)
  const token = auth.access
  const client = new CodeWhispererStreamingClient({
    region,
    endpoint: `https://q.${region}.amazonaws.com`,
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

  clientCache.set(cacheKey, { client, token })
  return client
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) {
    entry.client.destroy()
  }
  clientCache.clear()
}
