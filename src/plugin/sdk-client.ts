import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { KIRO_CONSTANTS } from '../constants.js'
import { getEffortSchemaPath } from './effort.js'
import * as logger from './logger.js'
import type { Effort, KiroAuthDetails } from './types'

export type ResolvedSdkEndpointMode = 'kiro-runtime' | 'legacy-q'

interface ClientCacheEntry {
  client: CodeWhispererStreamingClient
  token: string
  effort?: Effort
}

const clientCache = new Map<string, ClientCacheEntry>()
const KIRO_CLI_MAX_ATTEMPTS = 3
const KIRO_TRANSIENT_ERROR_MESSAGE =
  'Encountered an unexpected error when processing the request, please try again.'

export function markRetryableKiroEventStreamError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false

  const sdkError = error as {
    $metadata?: { httpStatusCode?: number }
    $response?: { statusCode?: number }
    $retryable?: Record<string, unknown>
    message?: string
    name?: string
    reason?: string
  }
  const status = sdkError.$metadata?.httpStatusCode ?? sdkError.$response?.statusCode
  if (status !== 200) return false

  const transient =
    sdkError.name === 'InternalServerException' ||
    sdkError.reason === 'MODEL_TEMPORARILY_UNAVAILABLE' ||
    sdkError.message?.includes(KIRO_TRANSIENT_ERROR_MESSAGE)
  if (!transient) return false

  if (sdkError.$retryable === undefined) sdkError.$retryable = {}
  return true
}

export function getSdkEndpoint(region: string, endpointMode: ResolvedSdkEndpointMode): string {
  if (region.startsWith('us-gov-')) return `https://q-fips.${region}.amazonaws.com`
  return endpointMode === 'kiro-runtime'
    ? `https://runtime.${region}.kiro.dev`
    : `https://q.${region}.amazonaws.com`
}

export function createSdkClient(
  auth: KiroAuthDetails,
  region: string,
  endpointMode: ResolvedSdkEndpointMode = 'kiro-runtime',
  effort?: Effort
): CodeWhispererStreamingClient {
  const cacheKey = `${region}:${endpointMode}:${auth.email || auth.clientId || 'default'}:${effort || 'none'}`
  const cached = clientCache.get(cacheKey)

  if (cached && cached.token === auth.access && cached.effort === effort) {
    return cached.client
  }

  const token = auth.access
  const clientConfig: ConstructorParameters<typeof CodeWhispererStreamingClient>[0] = {
    region,
    token: () => Promise.resolve({ token }),
    maxAttempts: KIRO_CLI_MAX_ATTEMPTS,
    retryMode: 'standard',
    customUserAgent: [[KIRO_CONSTANTS.USER_AGENT]]
  }

  clientConfig.endpoint = getSdkEndpoint(region, endpointMode)

  const client = new CodeWhispererStreamingClient(clientConfig)

  // Kiro can send a transient exception as the first frame of an HTTP 200 event stream.
  // Smithy otherwise classifies that startup failure as a non-retryable client error.
  client.middlewareStack.addRelativeTo(
    (next: any) => async (args: any) => {
      try {
        return await next(args)
      } catch (error) {
        if (markRetryableKiroEventStreamError(error)) {
          const sdkError = error as {
            $metadata?: { httpStatusCode?: number }
            $response?: { statusCode?: number }
            name?: string
            reason?: string
          }
          logger.warn('Retrying transient Kiro event-stream startup failure', {
            status: sdkError.$metadata?.httpStatusCode ?? sdkError.$response?.statusCode,
            name: sdkError.name,
            reason: sdkError.reason
          })
        }
        throw error
      }
    },
    {
      relation: 'before',
      toMiddleware: 'deserializerMiddleware',
      name: 'classifyKiroEventStreamError'
    }
  )

  client.middlewareStack.add(
    (next: any) => async (args: any) => {
      args.request.headers['x-amzn-kiro-agent-mode'] = 'vibe'
      return next(args)
    },
    { step: 'build', name: 'addKiroHeaders' }
  )

  if (effort) {
    client.middlewareStack.add(
      (next: any) => async (args: any) => {
        if (args.request?.body) {
          try {
            const body = JSON.parse(args.request.body)
            const modelId = body.conversationState?.currentMessage?.userInputMessage?.modelId
            const schemaPath = getEffortSchemaPath(modelId)
            if (schemaPath === 'reasoning') {
              body.additionalModelRequestFields = {
                ...body.additionalModelRequestFields,
                reasoning: {
                  ...body.additionalModelRequestFields?.reasoning,
                  effort
                }
              }
            } else if (schemaPath === 'output_config') {
              body.additionalModelRequestFields = {
                ...body.additionalModelRequestFields,
                thinking: { type: 'adaptive', display: 'summarized' },
                output_config: {
                  ...body.additionalModelRequestFields?.output_config,
                  effort
                }
              }
            }
            args.request.body = JSON.stringify(body)
          } catch {
            // Continue without effort when an unexpected body cannot be parsed.
          }
        }
        return next(args)
      },
      { step: 'build', name: 'addEffortConfig', priority: 'high' }
    )
  }

  clientCache.set(cacheKey, { client, token, effort })
  return client
}

export function clearSdkClientCache(): void {
  for (const entry of clientCache.values()) {
    entry.client.destroy()
  }
  clientCache.clear()
}
