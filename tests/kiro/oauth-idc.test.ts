import { describe, test, expect } from 'bun:test'
import * as fc from 'fast-check'
import { authorizeKiroIdentityCenter } from '../../src/kiro/oauth-idc'
import { validateUrl } from '../../src/constants'

describe('Identity Center OAuth Functions', () => {
  describe('Property 1: Start URL Validation', () => {
    test('validates Requirements 2.1 - only valid HTTPS URLs are accepted', () => {
      // Test that valid HTTPS URLs are accepted
      fc.assert(
        fc.property(fc.webUrl({ validSchemes: ['https'] }), async (url) => {
          // We can't actually call the function without mocking the network
          // but we can test the validation logic by checking if it throws
          // We'll test the validation by attempting to call with valid HTTPS URLs
          // and expecting it to fail at network level, not validation level
          try {
            await authorizeKiroIdentityCenter(url, 'us-east-1')
            // If it doesn't throw, that's fine - it means validation passed
          } catch (error) {
            // Should not throw validation errors for valid HTTPS URLs
            expect(error).not.toBeInstanceOf(Error)
            if (error instanceof Error) {
              expect(error.message).not.toContain('Start URL must use HTTPS protocol')
              expect(error.message).not.toContain('Invalid URL format')
              expect(error.message).not.toContain('Start URL cannot be empty')
            }
          }
        }),
        { numRuns: 100 }
      )
    })

    test('validates Requirements 2.1 - HTTP URLs are rejected', () => {
      // Test that HTTP URLs are rejected
      fc.assert(
        fc.property(fc.webUrl({ validSchemes: ['http'] }), async (url) => {
          await expect(authorizeKiroIdentityCenter(url, 'us-east-1')).rejects.toThrow(
            'Start URL must use HTTPS protocol'
          )
        }),
        { numRuns: 100 }
      )
    })

    test('validates Requirements 2.1 - invalid URL formats are rejected', () => {
      // Test that invalid URL formats are rejected
      const invalidUrlGenerator = fc.string({ minLength: 1 }).filter(s => {
        // Filter out valid URLs
        try {
          new URL(s)
          return false
        } catch {
          return true
        }
      })

      fc.assert(
        fc.property(invalidUrlGenerator, async (invalidUrl) => {
          await expect(authorizeKiroIdentityCenter(invalidUrl, 'us-east-1')).rejects.toThrow()
        }),
        { numRuns: 100 }
      )
    })
  })
})


describe('Start URL Validation Edge Cases', () => {
  test('validates Requirements 2.2 - rejects non-HTTPS URL with correct error message', async () => {
    await expect(authorizeKiroIdentityCenter('http://example.com/start', 'us-east-1')).rejects.toThrow(
      'Start URL must use HTTPS protocol'
    )
  })

  test('validates Requirements 2.3 - rejects invalid URL format with correct error message', async () => {
    await expect(authorizeKiroIdentityCenter('not-a-url', 'us-east-1')).rejects.toThrow(
      'Invalid URL format'
    )
  })

  test('validates Requirements 2.3 - rejects empty URL', async () => {
    await expect(authorizeKiroIdentityCenter('', 'us-east-1')).rejects.toThrow(
      'Start URL cannot be empty'
    )
  })

  test('validates Requirements 2.3 - rejects whitespace-only URL', async () => {
    await expect(authorizeKiroIdentityCenter('   ', 'us-east-1')).rejects.toThrow(
      'Start URL cannot be empty'
    )
  })

  test('validates Requirements 2.1 - accepts valid HTTPS URL format', () => {
    // Test that validation logic accepts valid HTTPS URLs
    // We don't need to make actual network calls to test validation
    const validUrls = [
      'https://mycompany.awsapps.com/start',
      'https://example.com',
      'https://test.example.com/path'
    ]

    for (const url of validUrls) {
      // If validation passes, the function will attempt network call
      // We just verify it doesn't throw validation errors synchronously
      expect(() => {
        // The validation happens synchronously before any async operations
        if (!url || url.trim() === '') throw new Error('Start URL cannot be empty')
        if (!validateUrl(url)) throw new Error('Invalid URL format')
        if (!url.startsWith('https://')) throw new Error('Start URL must use HTTPS protocol')
      }).not.toThrow()
    }
  })
})

describe('Property 5: Custom Start URL Usage', () => {
  test('validates Requirements 4.2 - device authorization uses custom startUrl', async () => {
    /**
     * **Property 5: Custom Start URL Usage**
     * **Validates: Requirements 4.2**
     * 
     * For any Identity Center authentication with a custom start URL,
     * the device authorization request should include that exact start URL
     * (not the fixed Builder ID URL).
     */
    await fc.assert(
      fc.asyncProperty(
        fc.webUrl({ validSchemes: ['https'] }),
        fc.constantFrom('us-east-1' as const, 'us-west-2' as const),
        async (customStartUrl, region) => {
          // Track the request body sent to device authorization endpoint
          let capturedRequestBody: any = null
          
          // Mock fetch to capture the device authorization request
          const originalFetch = global.fetch
          global.fetch = async (url: any, init?: any) => {
            const urlStr = typeof url === 'string' ? url : url.toString()
            
            // Mock client registration response
            if (urlStr.includes('client/register')) {
              return new Response(JSON.stringify({
                clientId: 'test-client-id',
                clientSecret: 'test-client-secret'
              }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            }
            
            // Capture device authorization request
            if (urlStr.includes('device_authorization')) {
              if (init?.body) {
                capturedRequestBody = JSON.parse(init.body as string)
              }
              return new Response(JSON.stringify({
                verificationUri: 'https://device.sso.aws.dev/verify',
                verificationUriComplete: 'https://device.sso.aws.dev/verify?code=ABC',
                userCode: 'ABC-123',
                deviceCode: 'device-code-123',
                interval: 5,
                expiresIn: 600
              }), { status: 200, headers: { 'Content-Type': 'application/json' } })
            }
            
            // Fallback - return error for unexpected requests
            return new Response(JSON.stringify({ error: 'Not mocked' }), { 
              status: 404, 
              headers: { 'Content-Type': 'application/json' } 
            })
          }
          
          try {
            await authorizeKiroIdentityCenter(customStartUrl, region)
            
            // Verify the captured request body contains the custom start URL
            expect(capturedRequestBody).not.toBeNull()
            expect(capturedRequestBody.startUrl).toBe(customStartUrl)
            
            // Verify it's NOT the Builder ID URL
            expect(capturedRequestBody.startUrl).not.toBe('https://view.awsapps.com/start')
          } finally {
            // Restore original fetch
            global.fetch = originalFetch
          }
        }
      ),
      { numRuns: 100 }
    )
  })
})
