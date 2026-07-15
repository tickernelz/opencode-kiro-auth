import { describe, expect, test } from 'bun:test'
import {
  deduplicateSdkEndpointModes,
  shouldFallbackSdkEndpointError
} from '../core/request/sdk-endpoint-fallback.js'
import { getUsageEndpointBases } from '../plugin/usage.js'

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

  test('does not fall back for generic authorization or request errors', () => {
    expect(
      shouldFallbackSdkEndpointError({
        $metadata: { httpStatusCode: 400 },
        message: 'Invalid request body'
      })
    ).toBe(false)
    expect(
      shouldFallbackSdkEndpointError({
        $metadata: { httpStatusCode: 403 },
        message: 'Access denied'
      })
    ).toBe(false)
  })

  test('falls back for a classified operation mismatch', () => {
    expect(
      shouldFallbackSdkEndpointError({
        name: 'UnknownOperationException',
        $metadata: { httpStatusCode: 400 }
      })
    ).toBe(true)
  })

  test('falls back when the endpoint or operation route is absent', () => {
    expect(shouldFallbackSdkEndpointError({ $metadata: { httpStatusCode: 404 } })).toBe(true)
    expect(shouldFallbackSdkEndpointError({ $metadata: { httpStatusCode: 405 } })).toBe(true)
  })

  test('does not synthesize unsupported Kiro management hosts in GovCloud', () => {
    expect(getUsageEndpointBases('us-gov-west-1')).toEqual([
      'https://q-fips.us-gov-west-1.amazonaws.com'
    ])
  })

  test('deduplicates auto endpoints that resolve to the same GovCloud URL', () => {
    expect(deduplicateSdkEndpointModes('us-gov-west-1', ['kiro-runtime', 'legacy-q'])).toEqual([
      'kiro-runtime'
    ])
  })
})
