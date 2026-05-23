import { describe, expect, test } from 'bun:test'
import { shouldFallbackSdkEndpointError } from '../core/request/sdk-endpoint-fallback.js'

describe('SDK endpoint fallback', () => {
  test('falls back for new SDK endpoint socket failures', () => {
    expect(
      shouldFallbackSdkEndpointError({
        code: 'FailedToOpenSocket',
        path: 'https://amazoncodewhispererstreamingservice.us-east-1.amazonaws.com/generateAssistantResponse'
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
