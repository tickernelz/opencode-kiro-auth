import { describe, expect, test } from 'bun:test'
import { deriveRegions } from '../plugin/sync/kiro-cli.js'

// Observed in the wild: an SSO session issued in ap-southeast-1 paired with a
// CodeWhisperer profile in us-east-1. Refreshing at the profile's region fails
// with `invalid_request` / "Invalid token provided" every time, because a
// refresh token is only valid at the OIDC region that issued it.
const SESSION_REGION = 'ap-southeast-1'
const PROFILE_ARN = 'arn:aws:codewhisperer:us-east-1:999995555777:profile/SOMERANDOMAA'

describe('deriveRegions', () => {
  test('keeps the OIDC region from data.region when it differs from the ARN region', () => {
    const { serviceRegion, oidcRegion } = deriveRegions(SESSION_REGION, PROFILE_ARN)

    expect(serviceRegion).toBe('us-east-1')
    expect(oidcRegion).toBe(SESSION_REGION)
  })

  test('uses data.region for both when there is no profile ARN', () => {
    const { serviceRegion, oidcRegion } = deriveRegions(SESSION_REGION, undefined)

    expect(serviceRegion).toBe(SESSION_REGION)
    expect(oidcRegion).toBe(SESSION_REGION)
  })

  test('falls back to the ARN region for both when data.region is missing', () => {
    for (const missing of [undefined, '', '   ']) {
      const { serviceRegion, oidcRegion } = deriveRegions(missing, PROFILE_ARN)

      expect(serviceRegion).toBe('us-east-1')
      expect(oidcRegion).toBe('us-east-1')
    }
  })

  test('agrees on both regions when the session and profile share a region', () => {
    const arn = 'arn:aws:codewhisperer:ap-southeast-1:123:profile/ABC'
    const { serviceRegion, oidcRegion } = deriveRegions(SESSION_REGION, arn)

    expect(serviceRegion).toBe(SESSION_REGION)
    expect(oidcRegion).toBe(SESSION_REGION)
  })

  test('normalizes an unrecognized data.region instead of trusting it', () => {
    const { oidcRegion } = deriveRegions('not-a-region', undefined)

    expect(oidcRegion).toBe('us-east-1')
  })
})
