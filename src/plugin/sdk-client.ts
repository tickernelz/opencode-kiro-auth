import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { KIRO_CONSTANTS } from '../constants.js'
import { buildEffortRequestFields, type EffortSchemaPath } from './effort.js'
import type { Effort, KiroAuthDetails } from './types'

/**
 * Cache key includes effort to ensure separate clients for different effort levels,
 * since middleware is configured at client creation time.
 */
interface ClientCacheEntry {
  client: CodeWhispererStreamingClient
  token: string
  effort?: Effort
  effortSchemaPath?: EffortSchemaPath
}

const clientCache = new Map<string, ClientCacheEntry>()
const KIRO_CLI_MAX_ATTEMPTS = 3

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string,
  effort?: Effort,
  effortSchemaPath?: EffortSchemaPath
): CodeWhispererStreamingClient {
  const resolvedSchemaPath = effort ? (effortSchemaPath ?? 'output_config') : undefined
  const cacheKey = `${region}:${auth.email || 'default'}:${effort || 'none'}:${resolvedSchemaPath || 'none'}`
  const cached = clientCache.get(cacheKey)

  if (
    cached &&
    cached.token === auth.access &&
    cached.effort === effort &&
    cached.effortSchemaPath === resolvedSchemaPath
  ) {
    return cached.client
  }

  const token = auth.access
  const client = new CodeWhispererStreamingClient({
    region,
    endpoint: `https://q.${region}.amazonaws.com`,
    token: () => Promise.resolve({ token }),
    maxAttempts: KIRO_CLI_MAX_ATTEMPTS,
    retryMode: 'standard',
    customUserAgent: [[KIRO_CONSTANTS.USER_AGENT]]
  })

  // Add Kiro-specific headers
  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      args.request.headers['x-amzn-kiro-agent-mode'] = 'vibe'
      return next(args)
    },
    { step: 'build', name: 'addKiroHeaders' }
  )

  // Inject additionalModelRequestFields using the model's advertised schema path.
  if (effort && resolvedSchemaPath) {
    client.middlewareStack.add(
      (next: any) => async (args: any) => {
        if (args.request?.body) {
          try {
            const body = JSON.parse(args.request.body)
            body.additionalModelRequestFields = buildEffortRequestFields(effort, resolvedSchemaPath)
            args.request.body = JSON.stringify(body)
          } catch (error) {
            const detail = error instanceof Error ? error.message : String(error)
            throw new Error(`Failed to inject Kiro effort configuration: ${detail}`)
          }
        }
        return next(args)
      },
      { step: 'build', name: 'addEffortConfig', priority: 'high' }
    )
  }

  clientCache.set(cacheKey, {
    client,
    token,
    effort,
    effortSchemaPath: resolvedSchemaPath
  })
  return client
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) {
    entry.client.destroy()
  }
  clientCache.clear()
}
