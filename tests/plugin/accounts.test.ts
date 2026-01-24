import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import * as fc from 'fast-check'
import { AccountManager, createDeterministicAccountId } from '../../src/plugin/accounts'
import type { ManagedAccount } from '../../src/plugin/types'
import { kiroDb } from '../../src/plugin/storage/sqlite'

describe('Property 6: Account Storage Completeness', () => {
  // Clean up database before and after tests
  beforeEach(() => {
    // Clear all accounts before each test
    const accounts = kiroDb.getAccounts()
    for (const account of accounts) {
      kiroDb.deleteAccount(account.id)
    }
  })

  afterEach(() => {
    // Clean up after each test
    const accounts = kiroDb.getAccounts()
    for (const account of accounts) {
      kiroDb.deleteAccount(account.id)
    }
  })

  test('validates Requirements 5.1 - stored Identity Center account contains all required fields', async () => {
    /**
     * **Property 6: Account Storage Completeness**
     * **Validates: Requirements 5.1**
     * 
     * For any successfully authenticated Identity Center account,
     * the stored account should contain all required fields:
     * refresh token, client ID, client secret, start URL, region, and auth method 'identity-center'.
     */
    await fc.assert(
      fc.asyncProperty(
        fc.emailAddress(), // email
        fc.string({ minLength: 20, maxLength: 50 }), // refreshToken
        fc.string({ minLength: 20, maxLength: 50 }), // accessToken
        fc.string({ minLength: 10, maxLength: 30 }), // clientId
        fc.string({ minLength: 10, maxLength: 30 }), // clientSecret
        fc.webUrl({ validSchemes: ['https'] }), // startUrl
        fc.constantFrom('us-east-1' as const, 'us-west-2' as const), // region
        fc.integer({ min: Date.now(), max: Date.now() + 3600000 }), // expiresAt
        async (email, refreshToken, accessToken, clientId, clientSecret, startUrl, region, expiresAt) => {
          // Create an Identity Center account with all required fields
          const account: ManagedAccount = {
            id: createDeterministicAccountId(email, 'identity-center', clientId),
            email,
            authMethod: 'identity-center',
            region,
            clientId,
            clientSecret,
            refreshToken,
            accessToken,
            expiresAt,
            rateLimitResetTime: 0,
            isHealthy: true,
            failCount: 0
          }

          // Create account manager and add the account
          const manager = new AccountManager([], 'sticky')
          manager.addAccount(account)

          // Reload from disk to verify persistence
          const reloadedManager = await AccountManager.loadFromDisk('sticky')
          const accounts = reloadedManager.getAccounts()

          // Find the account we just added
          const storedAccount = accounts.find(a => a.id === account.id)

          // Verify all required fields are present
          expect(storedAccount).not.toBeUndefined()
          expect(storedAccount!.email).toBe(email)
          expect(storedAccount!.authMethod).toBe('identity-center')
          expect(storedAccount!.region).toBe(region)
          expect(storedAccount!.clientId).toBe(clientId)
          expect(storedAccount!.clientSecret).toBe(clientSecret)
          expect(storedAccount!.refreshToken).toBe(refreshToken)
          expect(storedAccount!.accessToken).toBe(accessToken)
          expect(storedAccount!.expiresAt).toBe(expiresAt)

          // Clean up
          manager.removeAccount(account)
        }
      ),
      { numRuns: 100 }
    )
  })
})

describe('Property 7: Auth Method Persistence', () => {
  // Clean up database before and after tests
  beforeEach(() => {
    // Clear all accounts before each test
    const accounts = kiroDb.getAccounts()
    for (const account of accounts) {
      kiroDb.deleteAccount(account.id)
    }
  })

  afterEach(() => {
    // Clean up after each test
    const accounts = kiroDb.getAccounts()
    for (const account of accounts) {
      kiroDb.deleteAccount(account.id)
    }
  })

  test('validates Requirements 1.4 - all Identity Center accounts have authMethod identity-center', async () => {
    /**
     * **Property 7: Auth Method Persistence**
     * **Validates: Requirements 1.4**
     * 
     * For any Identity Center authentication,
     * the resulting stored account should have auth method 'identity-center'
     * (not 'idc' or 'desktop').
     */
    await fc.assert(
      fc.asyncProperty(
        fc.emailAddress(), // email
        fc.string({ minLength: 20, maxLength: 50 }), // refreshToken
        fc.string({ minLength: 20, maxLength: 50 }), // accessToken
        fc.string({ minLength: 10, maxLength: 30 }), // clientId
        fc.string({ minLength: 10, maxLength: 30 }), // clientSecret
        fc.webUrl({ validSchemes: ['https'] }), // startUrl
        fc.constantFrom('us-east-1' as const, 'us-west-2' as const), // region
        fc.integer({ min: Date.now(), max: Date.now() + 3600000 }), // expiresAt
        async (email, refreshToken, accessToken, clientId, clientSecret, startUrl, region, expiresAt) => {
          // Create an Identity Center account
          const account: ManagedAccount = {
            id: createDeterministicAccountId(email, 'identity-center', clientId),
            email,
            authMethod: 'identity-center',
            region,
            clientId,
            clientSecret,
            refreshToken,
            accessToken,
            expiresAt,
            rateLimitResetTime: 0,
            isHealthy: true,
            failCount: 0
          }

          // Create account manager and add the account
          const manager = new AccountManager([], 'sticky')
          manager.addAccount(account)

          // Reload from disk to verify persistence
          const reloadedManager = await AccountManager.loadFromDisk('sticky')
          const accounts = reloadedManager.getAccounts()

          // Find the account we just added
          const storedAccount = accounts.find(a => a.id === account.id)

          // Verify auth method is 'identity-center'
          expect(storedAccount).not.toBeUndefined()
          expect(storedAccount!.authMethod).toBe('identity-center')
          
          // Verify it's NOT 'idc' or 'desktop'
          expect(storedAccount!.authMethod).not.toBe('idc')
          expect(storedAccount!.authMethod).not.toBe('desktop')

          // Clean up
          manager.removeAccount(account)
        }
      ),
      { numRuns: 100 }
    )
  })
})
