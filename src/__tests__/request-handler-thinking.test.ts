import { describe, expect, test } from 'bun:test'
import { THINKING_BUDGET_BY_EFFORT } from '../constants.js'
import { RequestHandler } from '../core/request/request-handler.js'

const account = {
  id: 'account-1',
  email: 'user@example.com',
  authMethod: 'idc',
  region: 'us-east-1',
  refreshToken: 'refresh-token',
  accessToken: 'access-token',
  expiresAt: Date.now() + 60_000,
  rateLimitResetTime: 0,
  isHealthy: true,
  failCount: 0
}

const auth = {
  refresh: account.refreshToken,
  access: account.accessToken,
  expires: account.expiresAt,
  authMethod: account.authMethod,
  region: account.region,
  email: account.email
}

async function captureThinkingOptions(body: Record<string, unknown>) {
  const accountManager = {
    getAccounts: () => [account],
    toAuthDetails: () => auth
  }
  const repository = {}
  const handler = new RequestHandler(
    accountManager as any,
    {
      auto_sync_kiro_cli: false,
      account_selection_strategy: 'sticky',
      sdk_endpoint_mode: 'kiro-runtime',
      enable_log_api_request: false,
      auto_effort_mapping: false
    } as any,
    repository as any
  ) as any

  handler.accountSelector = { selectHealthyAccount: async () => account }
  handler.tokenRefresher = {
    refreshIfNeeded: async () => ({ account, shouldContinue: false, auth })
  }
  handler.usageTracker = { syncUsage: () => {} }
  handler.responseHandler = { handleSdkSuccess: async () => new Response() }

  let captured: { think: boolean; budget: number; effort?: string } | undefined
  handler.prepareSdkRequest = (
    _body: unknown,
    model: string,
    _auth: unknown,
    think: boolean,
    budget: number,
    effort?: string
  ) => {
    captured = { think, budget, effort }
    return {
      conversationState: {},
      streaming: true,
      effectiveModel: model,
      conversationId: 'conversation-1',
      region: 'us-east-1'
    }
  }
  handler.sendSdkRequestWithEndpointFallback = async () => ({
    sdkResponse: {},
    endpointMode: 'kiro-runtime'
  })

  await handler.handle(
    'https://q.us-east-1.amazonaws.com/models/claude-opus-4.8/invoke',
    { body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }], ...body }) },
    () => {}
  )

  return captured
}

async function handleWithSdkError(error: Error & { $metadata?: { httpStatusCode: number } }) {
  const accountManager = {
    getAccounts: () => [account],
    toAuthDetails: () => auth
  }
  const handler = new RequestHandler(
    accountManager as any,
    {
      auto_sync_kiro_cli: false,
      account_selection_strategy: 'sticky',
      sdk_endpoint_mode: 'kiro-runtime',
      enable_log_api_request: false,
      auto_effort_mapping: false,
      rate_limit_max_retries: 0,
      rate_limit_retry_delay_ms: 0
    } as any,
    {} as any
  ) as any

  handler.accountSelector = { selectHealthyAccount: async () => account }
  handler.tokenRefresher = {
    refreshIfNeeded: async () => ({ account, shouldContinue: false, auth })
  }
  handler.prepareSdkRequest = () => ({
    conversationState: {},
    streaming: true,
    effectiveModel: 'gpt-5.6-sol',
    conversationId: 'conversation-1',
    region: 'us-east-1'
  })
  handler.sendSdkRequestWithEndpointFallback = async () => ({
    sdkResponse: {},
    endpointMode: 'kiro-runtime'
  })
  handler.responseHandler = {
    handleSdkSuccess: async () => {
      throw error
    }
  }

  return handler.handle(
    'https://q.us-east-1.amazonaws.com/models/gpt-5.6-sol/invoke',
    { body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }) },
    () => {}
  )
}

describe('request handler thinking config', () => {
  test.each([
    [{ thinkingConfig: { thinkingBudget: 8192 } }, 8192],
    [{ thinkingConfig: { budget_tokens: 16384 } }, 16384],
    [{ providerOptions: { thinkingConfig: { thinkingBudget: 24576 } } }, 24576],
    [{ providerOptions: { thinkingConfig: { budget_tokens: 32768 } } }, 32768]
  ])('extracts thinking budget from supported request shapes', async (body, budget) => {
    expect(await captureThinkingOptions(body)).toEqual({ think: true, budget, effort: undefined })
  })

  test('gives explicit effort priority over thinking budget', async () => {
    expect(
      await captureThinkingOptions({
        reasoning_effort: 'max',
        thinkingConfig: { thinkingBudget: 8192 }
      })
    ).toEqual({
      think: true,
      budget: THINKING_BUDGET_BY_EFFORT.max,
      effort: 'max'
    })
  })

  test('preserves stream errors from successful SDK responses', async () => {
    const error = Object.assign(new Error('event stream ended unexpectedly'), {
      $metadata: { httpStatusCode: 200 }
    })

    expect(handleWithSdkError(error)).rejects.toThrow('event stream ended unexpectedly')
  })

  test('attributes a recovered request to the replacement account', async () => {
    const replacement = { ...account, id: 'replacement-account' }
    const accountManager = {
      getAccounts: () => [account, replacement],
      toAuthDetails: () => auth
    }
    const handler = new RequestHandler(
      accountManager as any,
      {
        auto_sync_kiro_cli: false,
        account_selection_strategy: 'sticky',
        sdk_endpoint_mode: 'kiro-runtime',
        enable_log_api_request: false,
        auto_effort_mapping: false
      } as any,
      {} as any
    ) as any
    let usageAccount: typeof account | undefined

    handler.accountSelector = { selectHealthyAccount: async () => account }
    handler.tokenRefresher = {
      refreshIfNeeded: async () => ({ account: replacement, shouldContinue: false, auth })
    }
    handler.prepareSdkRequest = () => ({
      conversationState: {},
      streaming: true,
      effectiveModel: 'gpt-5.6-sol',
      conversationId: 'conversation-1',
      region: 'us-east-1'
    })
    handler.sendSdkRequestWithEndpointFallback = async () => ({
      sdkResponse: {},
      endpointMode: 'kiro-runtime'
    })
    handler.responseHandler = { handleSdkSuccess: async () => new Response() }
    handler.usageTracker = {
      syncUsage: (target: typeof account) => {
        usageAccount = target
      }
    }

    await handler.handle(
      'https://q.us-east-1.amazonaws.com/models/gpt-5.6-sol/invoke',
      { body: JSON.stringify({ messages: [{ role: 'user', content: 'hello' }] }) },
      () => {}
    )

    expect(usageAccount).toBe(replacement)
  })
})
