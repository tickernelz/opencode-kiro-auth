import { describe, expect, test } from 'bun:test'
import { shouldFallbackSdkEndpointError } from '../core/request/sdk-endpoint-fallback.js'

describe('SDK endpoint fallback', () => {
  test('falls back for Kiro runtime endpoint socket failures', () => {
    expect(
      shouldFallbackSdkEndpointError({
        code: 'FailedToOpenSocket',
        path: 'https://runtime.us-east-1.kiro.dev/generateAssistantResponse'
      })
    ).toBe(true)
  })

  test('does not fall back for quota throttling', () => {
    expect(
      shouldFallbackSdkEndpointError({
        $metadata: { httpStatusCode: 429 },
        message: 'Too Many Requests'
      })
    ).toBe(false)
  })
})
