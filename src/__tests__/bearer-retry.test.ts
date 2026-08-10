import { CodeWhispererStreamingClient } from '@aws/codewhisperer-streaming-client'
import { afterAll, describe, expect, mock, spyOn, test } from 'bun:test'
import { clearSdkClientCache } from '../plugin/sdk-client.js'

let sendCalls = 0
let apiResponseLogCalls = 0
let sdkErrorMessage = 'The bearer token included in the request is invalid'
let sdkErrorName = 'ForbiddenException'
let sdkHttpStatus = 403

mock.module('../plugin/logger.js', () => ({
  debug: () => {},
  error: () => {},
  getTimestamp: () => '2026-07-22T00:00:00.000Z',
  log: () => {},
  logApiError: () => {},
  logApiRequest: () => {},
  logApiResponse: () => {
    apiResponseLogCalls++
  },
  warn: () => {}
}))

const sendSpy = spyOn(CodeWhispererStreamingClient.prototype, 'send').mockImplementation(
  async () => {
    sendCalls++
    const error: any = new Error(sdkErrorMessage)
    error.name = sdkErrorName
    error.$metadata = { httpStatusCode: sdkHttpStatus }
    throw error
  }
)

const { RequestHandler } = await import('../core/request/request-handler.js')

afterAll(() => {
  clearSdkClientCache()
  sendSpy.mockRestore()
})

function createHarness() {
  clearSdkClientCache()
  sendCalls = 0
  apiResponseLogCalls = 0

  const account: any = {
    id: 'account-1',
    email: 'user@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: 'refresh-token',
    accessToken: 'stale-access-token',
    expiresAt: Date.now() + 60_000,
    isHealthy: true,
    failCount: 0,
    usedCount: 0,
    limitCount: 0
  }

  const accountManager: any = {
    getAccounts: () => [account],
    getAccountCount: () => 1,
    markUnhealthy: (acc: any, reason: string) => {
      acc.isHealthy = false
      acc.unhealthyReason = reason
    },
    toAuthDetails: (selected: any) => ({
      access: selected.accessToken,
      refresh: selected.refreshToken,
      expires: selected.expiresAt,
      authMethod: selected.authMethod,
      region: selected.region,
      email: selected.email
    })
  }

  const repository: any = {
    batchSave: async () => {},
    save: async () => {},
    invalidateCache: () => {},
    findAll: async () => [account]
  }

  const config: any = {
    max_request_iterations: 5,
    request_timeout_ms: 5_000,
    rate_limit_max_retries: 2,
    rate_limit_retry_delay_ms: 1,
    token_expiry_buffer_ms: 0,
    auto_sync_kiro_cli: false,
    account_selection_strategy: 'sticky',
    enable_log_api_request: true
  }

  const handler: any = new RequestHandler(accountManager, config, repository)
  let forceRefreshCalls = 0

  handler.accountSelector = {
    selectHealthyAccount: async () => account
  }
  handler.tokenRefresher = {
    refreshIfNeeded: async (selected: any) => ({ account: selected, shouldContinue: false }),
    forceRefresh: async () => {
      forceRefreshCalls++
    }
  }
  handler.prepareSdkRequest = () => ({
    region: 'us-east-1',
    effort: undefined,
    conversationState: {},
    profileArn: undefined,
    conversationId: 'conversation-1',
    streaming: false,
    effectiveModel: 'claude-sonnet-4-5'
  })

  return { handler, getForceRefreshCalls: () => forceRefreshCalls }
}

function request(handler: any) {
  return handler.handle(
    'https://q.us-east-1.amazonaws.com/models/claude-sonnet-4-5',
    { body: '{}' },
    () => {}
  )
}

describe('RequestHandler SDK error recovery', () => {
  test('forces one refresh, retries once, then applies permanent bearer failure handling', async () => {
    sdkErrorMessage = 'The bearer token included in the request is invalid'
    sdkErrorName = 'ForbiddenException'
    sdkHttpStatus = 403
    const { handler, getForceRefreshCalls } = createHarness()

    await expect(request(handler)).rejects.toThrow('Kiro Error: 403')

    expect(sendCalls).toBe(2)
    expect(getForceRefreshCalls()).toBe(1)
    expect(apiResponseLogCalls).toBe(2)
  })

  test('returns a context-length response for SDK input overflow', async () => {
    sdkErrorMessage = 'Input is too long for this model'
    sdkErrorName = 'ValidationException'
    sdkHttpStatus = 400
    const { handler, getForceRefreshCalls } = createHarness()

    const response = await request(handler)

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: {
        message: 'input is too long for requested model',
        type: 'invalid_request_error',
        code: 'context_length_exceeded'
      }
    })
    expect(sendCalls).toBe(1)
    expect(getForceRefreshCalls()).toBe(0)
  })
})
