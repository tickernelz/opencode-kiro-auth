import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { authorizeKiroIdentityCenter, pollKiroIdentityCenterToken } from '../../src/kiro/oauth-idc'
import { AccountManager, createDeterministicAccountId } from '../../src/plugin/accounts'
import { encodeRefreshToken } from '../../src/kiro/auth'
import type { ManagedAccount } from '../../src/plugin/types'

describe('Integration Tests: Identity Center Auth Flow', () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  test('validates Requirements 1.1, 1.2, 1.3, 1.4, 5.1 - full Identity Center auth flow from authorization through account storage', async () => {
    /**
     * Integration test for complete Identity Center authentication flow:
     * 1. User provides start URL and region
     * 2. System authorizes with custom start URL
     * 3. System polls for tokens
     * 4. System stores account with all required fields
     * 5. Account can be retrieved and used
     */

    const customStartUrl = 'https://mycompany.awsapps.com/start'
    const region = 'us-west-2'
    const mockClientId = 'test-client-id-123'
    const mockClientSecret = 'test-client-secret-456'
    const mockDeviceCode = 'device-code-789'
    const mockUserCode = 'ABC-DEF'
    const mockRefreshToken = 'refresh-token-xyz'
    const mockAccessToken = 'access-token-abc'

    // Mock SSO OIDC endpoints
    global.fetch = async (url: any, init?: any) => {
      const urlStr = typeof url === 'string' ? url : url.toString()

      // Mock client registration
      if (urlStr.includes('client/register')) {
        return new Response(
          JSON.stringify({
            clientId: mockClientId,
            clientSecret: mockClientSecret
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      // Mock device authorization
      if (urlStr.includes('device_authorization')) {
        const body = init?.body ? JSON.parse(init.body as string) : {}
        
        // Verify custom start URL is used
        expect(body.startUrl).toBe(customStartUrl)
        expect(body.startUrl).not.toBe('https://view.awsapps.com/start')

        return new Response(
          JSON.stringify({
            verificationUri: 'https://device.sso.aws.dev/verify',
            verificationUriComplete: `https://device.sso.aws.dev/verify?code=${mockUserCode}`,
            userCode: mockUserCode,
            deviceCode: mockDeviceCode,
            interval: 1, // Short interval for testing
            expiresIn: 60
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      // Mock token polling - return success immediately
      if (urlStr.includes('/token')) {
        return new Response(
          JSON.stringify({
            accessToken: mockAccessToken,
            refreshToken: mockRefreshToken,
            expiresIn: 3600
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      return new Response(JSON.stringify({ error: 'Not mocked' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Step 1 & 2: Authorize with custom start URL (simulates user providing start URL and region)
    const authResult = await authorizeKiroIdentityCenter(customStartUrl, region)

    // Verify authorization result contains all required fields
    expect(authResult.clientId).toBe(mockClientId)
    expect(authResult.clientSecret).toBe(mockClientSecret)
    expect(authResult.deviceCode).toBe(mockDeviceCode)
    expect(authResult.userCode).toBe(mockUserCode)
    expect(authResult.startUrl).toBe(customStartUrl)
    expect(authResult.region).toBe(region)

    // Step 3: Poll for tokens
    const tokenResult = await pollKiroIdentityCenterToken(
      authResult.clientId,
      authResult.clientSecret,
      authResult.deviceCode,
      authResult.interval,
      authResult.expiresIn,
      authResult.region,
      authResult.startUrl
    )

    // Verify token result
    expect(tokenResult.refreshToken).toBe(mockRefreshToken)
    expect(tokenResult.accessToken).toBe(mockAccessToken)
    expect(tokenResult.authMethod).toBe('identity-center')
    expect(tokenResult.startUrl).toBe(customStartUrl)
    expect(tokenResult.region).toBe(region)
    expect(tokenResult.clientId).toBe(mockClientId)
    expect(tokenResult.clientSecret).toBe(mockClientSecret)

    // Step 4: Store account with all required fields (validates Requirement 5.1)
    const accountId = createDeterministicAccountId(
      tokenResult.email,
      tokenResult.authMethod,
      tokenResult.clientId
    )

    const encodedRefresh = encodeRefreshToken({
      refreshToken: tokenResult.refreshToken,
      clientId: tokenResult.clientId,
      clientSecret: tokenResult.clientSecret,
      startUrl: tokenResult.startUrl,
      authMethod: tokenResult.authMethod
    })

    const account: ManagedAccount = {
      id: accountId,
      email: tokenResult.email,
      authMethod: tokenResult.authMethod,
      region: tokenResult.region,
      clientId: tokenResult.clientId,
      clientSecret: tokenResult.clientSecret,
      refreshToken: encodedRefresh,
      accessToken: tokenResult.accessToken,
      expiresAt: tokenResult.expiresAt,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0
    }

    // Verify account has all required fields (Requirement 5.1)
    expect(account.authMethod).toBe('identity-center')
    expect(account.refreshToken).toContain(customStartUrl)
    expect(account.clientId).toBe(mockClientId)
    expect(account.clientSecret).toBe(mockClientSecret)
    expect(account.region).toBe(region)

    // Step 5: Verify account can be retrieved and used
    const accountManager = new AccountManager([account], 'sticky')
    accountManager.addAccount(account)

    const retrievedAccount = accountManager.getCurrentOrNext()
    expect(retrievedAccount).not.toBeNull()
    expect(retrievedAccount?.id).toBe(accountId)
    expect(retrievedAccount?.authMethod).toBe('identity-center')
    expect(retrievedAccount?.refreshToken).toContain(customStartUrl)

    // Verify the encoded refresh token contains the start URL
    expect(encodedRefresh).toContain(customStartUrl)
    expect(encodedRefresh).toContain('identity-center')
  })

  test('validates Requirements 1.1, 1.4 - multiple Identity Center accounts can coexist', async () => {
    /**
     * Test that multiple Identity Center accounts with different start URLs
     * can be stored and managed simultaneously
     */

    const account1: ManagedAccount = {
      id: 'id-1',
      email: 'user1@company1.com',
      authMethod: 'identity-center',
      region: 'us-east-1',
      clientId: 'client-1',
      clientSecret: 'secret-1',
      refreshToken: encodeRefreshToken({
        refreshToken: 'refresh-1',
        clientId: 'client-1',
        clientSecret: 'secret-1',
        startUrl: 'https://company1.awsapps.com/start',
        authMethod: 'identity-center'
      }),
      accessToken: 'access-1',
      expiresAt: Date.now() + 3600000,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0
    }

    const account2: ManagedAccount = {
      id: 'id-2',
      email: 'user2@company2.com',
      authMethod: 'identity-center',
      region: 'us-west-2',
      clientId: 'client-2',
      clientSecret: 'secret-2',
      refreshToken: encodeRefreshToken({
        refreshToken: 'refresh-2',
        clientId: 'client-2',
        clientSecret: 'secret-2',
        startUrl: 'https://company2.awsapps.com/start',
        authMethod: 'identity-center'
      }),
      accessToken: 'access-2',
      expiresAt: Date.now() + 3600000,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0
    }

    const accountManager = new AccountManager([account1, account2], 'round-robin')

    expect(accountManager.getAccountCount()).toBe(2)

    const accounts = accountManager.getAccounts()
    expect(accounts).toHaveLength(2)
    expect(accounts[0]?.authMethod).toBe('identity-center')
    expect(accounts[1]?.authMethod).toBe('identity-center')
    expect(accounts[0]?.refreshToken).toContain('company1.awsapps.com')
    expect(accounts[1]?.refreshToken).toContain('company2.awsapps.com')
  })
})

describe('Integration Tests: Token Refresh', () => {
  let originalFetch: typeof global.fetch

  beforeEach(() => {
    originalFetch = global.fetch
  })

  afterEach(() => {
    global.fetch = originalFetch
  })

  test('validates Requirement 6.3 - Identity Center account token refresh', async () => {
    /**
     * Integration test for token refresh:
     * 1. Create Identity Center account with expired token
     * 2. Trigger token refresh
     * 3. Verify new access token is obtained and stored
     */

    const customStartUrl = 'https://testcompany.awsapps.com/start'
    const region = 'us-east-1'
    const mockClientId = 'test-client-id'
    const mockClientSecret = 'test-client-secret'
    const oldRefreshToken = 'old-refresh-token'
    const oldAccessToken = 'old-access-token'
    const newRefreshToken = 'new-refresh-token'
    const newAccessToken = 'new-access-token'

    // Create account with expired token
    const encodedRefresh = encodeRefreshToken({
      refreshToken: oldRefreshToken,
      clientId: mockClientId,
      clientSecret: mockClientSecret,
      startUrl: customStartUrl,
      authMethod: 'identity-center'
    })

    const expiredAccount: ManagedAccount = {
      id: 'test-account-id',
      email: 'test@testcompany.com',
      authMethod: 'identity-center',
      region: region,
      clientId: mockClientId,
      clientSecret: mockClientSecret,
      refreshToken: encodedRefresh,
      accessToken: oldAccessToken,
      expiresAt: Date.now() - 1000, // Expired 1 second ago
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0
    }

    // Mock token refresh endpoint
    global.fetch = async (url: any, init?: any) => {
      const urlStr = typeof url === 'string' ? url : url.toString()

      // Mock SSO OIDC token refresh
      if (urlStr.includes('oidc') && urlStr.includes('/token')) {
        const body = init?.body ? JSON.parse(init.body as string) : {}

        // Verify refresh request contains correct parameters
        expect(body.refreshToken).toBe(oldRefreshToken)
        expect(body.clientId).toBe(mockClientId)
        expect(body.clientSecret).toBe(mockClientSecret)
        expect(body.grantType).toBe('refresh_token')

        return new Response(
          JSON.stringify({
            accessToken: newAccessToken,
            refreshToken: newRefreshToken,
            expiresIn: 3600
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      return new Response(JSON.stringify({ error: 'Not mocked' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    // Import refreshAccessToken dynamically to use mocked fetch
    const { refreshAccessToken } = await import('../../src/plugin/token')

    // Create auth details from expired account
    const accountManager = new AccountManager([expiredAccount], 'sticky')
    const authDetails = accountManager.toAuthDetails(expiredAccount)

    // Verify token is expired
    expect(authDetails.expires).toBeLessThan(Date.now())

    // Trigger token refresh
    const refreshedAuth = await refreshAccessToken(authDetails)

    // Verify new access token is obtained
    expect(refreshedAuth.access).toBe(newAccessToken)
    expect(refreshedAuth.authMethod).toBe('identity-center')
    expect(refreshedAuth.region).toBe(region)
    expect(refreshedAuth.expires).toBeGreaterThan(Date.now())

    // Verify refresh token is updated in the encoded string
    expect(refreshedAuth.refresh).toContain(newRefreshToken)
    expect(refreshedAuth.refresh).toContain(customStartUrl)
    expect(refreshedAuth.refresh).toContain('identity-center')

    // Update account with refreshed auth
    accountManager.updateFromAuth(expiredAccount, refreshedAuth)

    // Verify account is updated
    const updatedAccount = accountManager.getCurrentOrNext()
    expect(updatedAccount).not.toBeNull()
    expect(updatedAccount?.accessToken).toBe(newAccessToken)
    expect(updatedAccount?.failCount).toBe(0)
  })

  test('validates Requirement 6.3 - token refresh uses correct endpoint for Identity Center', async () => {
    /**
     * Verify that Identity Center accounts use the SSO OIDC endpoint
     * (not the desktop auth endpoint) for token refresh
     */

    const customStartUrl = 'https://example.awsapps.com/start'
    const region = 'us-west-2'

    const encodedRefresh = encodeRefreshToken({
      refreshToken: 'test-refresh',
      clientId: 'test-client',
      clientSecret: 'test-secret',
      startUrl: customStartUrl,
      authMethod: 'identity-center'
    })

    const account: ManagedAccount = {
      id: 'test-id',
      email: 'test@example.com',
      authMethod: 'identity-center',
      region: region,
      clientId: 'test-client',
      clientSecret: 'test-secret',
      refreshToken: encodedRefresh,
      accessToken: 'old-access',
      expiresAt: Date.now() - 1000,
      rateLimitResetTime: 0,
      isHealthy: true,
      failCount: 0
    }

    let capturedUrl: string | null = null

    // Mock fetch to capture the URL
    global.fetch = async (url: any, init?: any) => {
      const urlStr = typeof url === 'string' ? url : url.toString()
      capturedUrl = urlStr

      if (urlStr.includes('/token')) {
        return new Response(
          JSON.stringify({
            accessToken: 'new-access',
            refreshToken: 'new-refresh',
            expiresIn: 3600
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }

      return new Response(JSON.stringify({ error: 'Not mocked' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      })
    }

    const { refreshAccessToken } = await import('../../src/plugin/token')
    const accountManager = new AccountManager([account], 'sticky')
    const authDetails = accountManager.toAuthDetails(account)

    await refreshAccessToken(authDetails)

    // Verify SSO OIDC endpoint was used (not desktop auth endpoint)
    expect(capturedUrl).not.toBeNull()
    expect(capturedUrl).toContain('oidc')
    expect(capturedUrl).toContain(region)
    expect(capturedUrl).not.toContain('desktop.kiro.dev')
  })
})
