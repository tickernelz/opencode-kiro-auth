import { describe, test, expect } from 'bun:test'
import * as fc from 'fast-check'
import { decodeRefreshToken, encodeRefreshToken } from '../../src/kiro/auth'
import type { RefreshParts } from '../../src/plugin/types'

describe('Token Encoding/Decoding', () => {
  describe('Property 4: Token Encoding Round Trip', () => {
    test('validates Requirements 6.1 - encoding then decoding preserves all fields including startUrl', () => {
      // Generator for strings without pipe characters (since pipe is used as delimiter)
      const stringWithoutPipe = fc.string({ minLength: 10 }).filter(s => !s.includes('|'))
      
      fc.assert(
        fc.property(
          stringWithoutPipe, // refreshToken
          stringWithoutPipe, // clientId
          stringWithoutPipe, // clientSecret
          fc.webUrl({ validSchemes: ['https'] }), // startUrl (URLs don't contain pipes)
          (refreshToken, clientId, clientSecret, startUrl) => {
            const parts: RefreshParts = {
              refreshToken,
              clientId,
              clientSecret,
              startUrl,
              authMethod: 'identity-center'
            }

            const encoded = encodeRefreshToken(parts)
            const decoded = decodeRefreshToken(encoded)

            expect(decoded.refreshToken).toBe(refreshToken)
            expect(decoded.clientId).toBe(clientId)
            expect(decoded.clientSecret).toBe(clientSecret)
            expect(decoded.startUrl).toBe(startUrl)
            expect(decoded.authMethod).toBe('identity-center')
          }
        ),
        { numRuns: 100 }
      )
    })
  })
})
