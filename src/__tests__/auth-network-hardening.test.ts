import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getOidcEndpoint, parseCodeWhispererProfileArn } from '../constants.js'
import { encodeRefreshToken } from '../kiro/auth.js'
import { authorizeKiroIDC, pollKiroIDCToken } from '../kiro/oauth-idc.js'
import { refreshAccessToken } from '../plugin/token.js'
import type { KiroAuthDetails } from '../plugin/types.js'
import { fetchUsageLimits } from '../plugin/usage.js'

const originalFetch = globalThis.fetch
const originalXdgConfigHome = process.env.XDG_CONFIG_HOME
let tempConfigHome: string | undefined

afterEach(() => {
  globalThis.fetch = originalFetch
  if (originalXdgConfigHome === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = originalXdgConfigHome
  if (tempConfigHome) rmSync(tempConfigHome, { recursive: true, force: true })
  tempConfigHome = undefined
})

describe('partition-aware authentication', () => {
  test('parses commercial and GovCloud profile ARNs', () => {
    expect(
      parseCodeWhispererProfileArn(
        'arn:aws:codewhisperer:eu-central-1:123456789012:profile/PROFILE_1'
      )
    ).toMatchObject({ partition: 'aws', service: 'codewhisperer', region: 'eu-central-1' })
    expect(
      parseCodeWhispererProfileArn(
        'arn:aws-us-gov:qdeveloper:us-gov-west-1:123456789012:profile/PROFILE_2'
      )
    ).toMatchObject({ partition: 'aws-us-gov', service: 'qdeveloper', region: 'us-gov-west-1' })
  })

  test('rejects partition-region mismatches, unsupported China, and non-profile resources', () => {
    expect(
      parseCodeWhispererProfileArn(
        'arn:aws:codewhisperer:us-gov-west-1:123456789012:profile/PROFILE'
      )
    ).toBeUndefined()
    expect(
      parseCodeWhispererProfileArn(
        'arn:aws-cn:codewhisperer:cn-north-1:123456789012:profile/PROFILE'
      )
    ).toBeUndefined()
    expect(
      parseCodeWhispererProfileArn('arn:aws:codewhisperer:us-east-1:123456789012:workspace/PROFILE')
    ).toBeUndefined()
  })

  test('selects the FIPS OIDC host for GovCloud and rejects China', () => {
    expect(getOidcEndpoint('us-gov-west-1')).toBe('https://oidc-fips.us-gov-west-1.amazonaws.com')
    expect(getOidcEndpoint('us-east-1')).toBe('https://oidc.us-east-1.amazonaws.com')
    expect(() => getOidcEndpoint('cn-north-1')).toThrow('AWS China regions are not supported')
  })

  test('uses the GovCloud FIPS endpoint and timeouts for device authorization', async () => {
    tempConfigHome = mkdtempSync(join(tmpdir(), 'kiro-oidc-test-'))
    process.env.XDG_CONFIG_HOME = tempConfigHome
    const calls: Array<{ input: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), init })
      if (calls.length === 1) {
        return Response.json({
          clientId: 'client-id',
          clientSecret: 'client-secret',
          clientSecretExpiresAt: Math.floor(Date.now() / 1000) + 86400 * 30
        })
      }
      return Response.json({
        verificationUri: 'https://device.sso.us-gov-west-1.amazonaws.com/',
        verificationUriComplete: 'https://device.sso.us-gov-west-1.amazonaws.com/?user_code=CODE',
        userCode: 'CODE',
        deviceCode: 'device-code',
        interval: 1,
        expiresIn: 600
      })
    }) as typeof fetch

    await authorizeKiroIDC('us-gov-west-1')

    expect(calls.map((call) => call.input)).toEqual([
      'https://oidc-fips.us-gov-west-1.amazonaws.com/client/register',
      'https://oidc-fips.us-gov-west-1.amazonaws.com/device_authorization'
    ])
    expect(calls.every((call) => call.init?.signal instanceof AbortSignal)).toBe(true)
  })

  test('uses the GovCloud FIPS endpoint and timeout for device token polling', async () => {
    let call: { input: string; init?: RequestInit } | undefined
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      call = { input: String(input), init }
      return Response.json({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        expiresIn: 3600
      })
    }) as typeof fetch

    await pollKiroIDCToken('client-id', 'client-secret', 'device-code', 0.001, 2, 'us-gov-west-1')

    expect(call?.input).toBe('https://oidc-fips.us-gov-west-1.amazonaws.com/token')
    expect(call?.init?.signal).toBeInstanceOf(AbortSignal)
  })

  test('refresh uses the GovCloud FIPS endpoint, a timeout, and one transient retry', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ input: String(input), init })
      if (calls.length === 1) throw new TypeError('fetch failed')
      return new Response(
        JSON.stringify({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresIn: 3600 }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    }) as typeof fetch
    const auth: KiroAuthDetails = {
      refresh: encodeRefreshToken({
        refreshToken: 'old-refresh',
        clientId: 'client-id',
        clientSecret: 'client-secret',
        authMethod: 'idc'
      }),
      access: 'old-access',
      expires: 0,
      authMethod: 'idc',
      region: 'us-gov-west-1',
      oidcRegion: 'us-gov-west-1'
    }

    const refreshed = await refreshAccessToken(auth)

    expect(calls).toHaveLength(2)
    expect(calls[0]?.input).toBe('https://oidc-fips.us-gov-west-1.amazonaws.com/token')
    expect(calls.every((call) => call.init?.signal instanceof AbortSignal)).toBe(true)
    expect(refreshed.access).toBe('new-access')
  })

  test('bounds usage requests with an abort signal', async () => {
    let signal: AbortSignal | null | undefined
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      signal = init?.signal
      return Response.json({ usageBreakdownList: [] })
    }) as typeof fetch

    await fetchUsageLimits({
      refresh: 'refresh',
      access: 'access',
      expires: Date.now() + 3600000,
      authMethod: 'idc',
      region: 'us-east-1'
    })

    expect(signal).toBeInstanceOf(AbortSignal)
  })

  test('creates a fresh timeout signal for each usage fallback attempt', async () => {
    const signals: AbortSignal[] = []
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal as AbortSignal)
      if (signals.length === 1) {
        return new Response('FEATURE_NOT_SUPPORTED', { status: 400 })
      }
      return Response.json({ usageBreakdownList: [] })
    }) as typeof fetch

    await fetchUsageLimits({
      refresh: 'refresh',
      access: 'access',
      expires: Date.now() + 3600000,
      authMethod: 'idc',
      region: 'us-east-1'
    })

    expect(signals).toHaveLength(2)
    expect(signals[0]).toBeInstanceOf(AbortSignal)
    expect(signals[1]).toBeInstanceOf(AbortSignal)
    expect(signals[0]).not.toBe(signals[1])
  })
})
