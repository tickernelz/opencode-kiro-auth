import { describe, expect, mock, test } from 'bun:test'

let capturedUrl: string | undefined

mock.module('../kiro/auth.js', () => ({
  decodeRefreshToken: () => ({ refreshToken: 'rt', clientId: 'cid', clientSecret: 'secret' }),
  encodeRefreshToken: () => 'encoded-refresh',
  accessTokenExpired: () => false
}))

describe('refreshAccessToken region selection', () => {
  test('builds the OIDC refresh URL from oidcRegion, not the service region', async () => {
    const originalFetch = globalThis.fetch
    ;(globalThis as any).fetch = async (url: string) => {
      capturedUrl = url
      return {
        ok: true,
        json: async () => ({ access_token: 'new-access', expires_in: 3600 })
      } as any
    }

    try {
      const { refreshAccessToken } = await import('../plugin/token.js')

      await refreshAccessToken({
        refresh: 'refresh-token',
        access: 'old-access',
        expires: 0,
        authMethod: 'idc',
        region: 'us-east-1',
        oidcRegion: 'ap-southeast-1',
        profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/ABC'
      } as any)

      expect(capturedUrl).toBe('https://oidc.ap-southeast-1.amazonaws.com/token')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
