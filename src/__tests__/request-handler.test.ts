import { describe, expect, test } from 'bun:test'
import { RequestHandler } from '../core/request/request-handler.js'
import { AccountManager } from '../plugin/accounts.js'
import { DEFAULT_CONFIG } from '../plugin/config/schema.js'
import type { ManagedAccount } from '../plugin/types.js'

function account(overrides: Partial<ManagedAccount> = {}): ManagedAccount {
  return {
    id: overrides.id || 'acct-1',
    email: overrides.email || 'user@example.com',
    authMethod: 'idc',
    region: 'us-east-1',
    refreshToken: 'refresh',
    accessToken: 'access',
    expiresAt: Date.now() + 60000,
    rateLimitResetTime: 0,
    isHealthy: true,
    failCount: 0,
    ...overrides
  }
}

const repository = {
  save: async () => undefined,
  batchSave: async () => undefined,
  invalidateCache: () => undefined,
  findAll: async () => []
}

const toast = () => undefined

describe('RequestHandler account loop guards', () => {
  test('fails fast when all accounts need reauthentication', async () => {
    const manager = new AccountManager([
      account({
        unhealthyReason: 'Refresh failed: Bad credentials',
        failCount: 242
      })
    ])
    const handler = new RequestHandler(manager, DEFAULT_CONFIG, repository as any)

    await expect(
      handler.handle(
        'https://q.us-east-1.amazonaws.com/models/claude-haiku-4-5/invoke',
        { body: JSON.stringify({ messages: [] }) },
        toast
      )
    ).rejects.toThrow('All Kiro accounts need re-authentication.')
  })

  test('fails fast when all accounts are rate-limited', async () => {
    const manager = new AccountManager([
      account({
        rateLimitResetTime: Date.now() + 60000
      })
    ])
    const handler = new RequestHandler(manager, DEFAULT_CONFIG, repository as any)

    await expect(
      handler.handle(
        'https://q.us-east-1.amazonaws.com/models/claude-haiku-4-5/invoke',
        { body: JSON.stringify({ messages: [] }) },
        toast
      )
    ).rejects.toThrow('All Kiro accounts are rate-limited.')
  })
})
