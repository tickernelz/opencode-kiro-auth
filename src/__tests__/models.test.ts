import { describe, expect, test } from 'bun:test'
import {
  clearContextWindowCatalog,
  getContextWindowSize,
  refreshContextWindowSizes
} from '../plugin/models.js'
import type { KiroAuthDetails } from '../plugin/types.js'

const auth: KiroAuthDetails = {
  access: 'test-token',
  refresh: 'test-refresh',
  expires: Date.now() + 60_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

describe('getContextWindowSize', () => {
  test('uses maxInputTokens from the live model catalog for aliases', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          models: [
            { modelId: 'claude-sonnet-4.6', tokenLimits: { maxInputTokens: 1_000_000 } },
            { modelId: 'deepseek-3.2', tokenLimits: { maxInputTokens: 164_000 } }
          ]
        }),
        { status: 200 }
      )) as typeof fetch

    try {
      await refreshContextWindowSizes(auth)
      expect(getContextWindowSize('claude-sonnet-4-6')).toBe(1_000_000)
      expect(getContextWindowSize('deepseek-3.2')).toBe(164_000)
    } finally {
      globalThis.fetch = originalFetch
      clearContextWindowCatalog()
    }
  })
})
