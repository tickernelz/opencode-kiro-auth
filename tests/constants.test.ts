import { describe, test, expect } from 'bun:test'
import * as fc from 'fast-check'
import { buildUrl, isValidRegion, normalizeRegion, validateUrl } from '../src/constants'
import type { KiroRegion } from '../src/plugin/types'

describe('Region Endpoint Construction', () => {
  describe('Property 2: Region Endpoint Construction', () => {
    test('validates Requirements 3.4 - endpoint URLs are valid and contain the region', () => {
      /**
       * **Property 2: Region Endpoint Construction**
       * **Validates: Requirements 3.4**
       * 
       * For any valid region ('us-east-1' or 'us-west-2'), constructing the SSO OIDC
       * endpoint should produce a valid URL containing that region.
       */
      fc.assert(
        fc.property(
          fc.constantFrom('us-east-1' as const, 'us-west-2' as const),
          (region: KiroRegion) => {
            const template = 'https://oidc.{{region}}.amazonaws.com'
            const url = buildUrl(template, region)

            // Verify URL is valid
            expect(validateUrl(url)).toBe(true)

            // Verify URL contains the region
            expect(url).toContain(region)

            // Verify URL structure is correct
            expect(url).toBe(`https://oidc.${region}.amazonaws.com`)

            // Verify it can be parsed as a URL
            const parsedUrl = new URL(url)
            expect(parsedUrl.protocol).toBe('https:')
            expect(parsedUrl.hostname).toBe(`oidc.${region}.amazonaws.com`)
          }
        ),
        { numRuns: 100 }
      )
    })

    test('validates Requirements 3.4 - multiple endpoint templates work correctly', () => {
      /**
       * Test that region substitution works for different endpoint templates
       */
      const templates = [
        'https://oidc.{{region}}.amazonaws.com',
        'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
        'https://q.{{region}}.amazonaws.com/generateAssistantResponse'
      ]

      fc.assert(
        fc.property(
          fc.constantFrom('us-east-1' as const, 'us-west-2' as const),
          fc.constantFrom(...templates),
          (region: KiroRegion, template: string) => {
            const url = buildUrl(template, region)

            // Verify URL is valid
            expect(validateUrl(url)).toBe(true)

            // Verify URL contains the region
            expect(url).toContain(region)

            // Verify {{region}} placeholder was replaced
            expect(url).not.toContain('{{region}}')

            // Verify it can be parsed as a URL
            const parsedUrl = new URL(url)
            expect(parsedUrl.protocol).toBe('https:')
          }
        ),
        { numRuns: 100 }
      )
    })
  })

  describe('Region Validation', () => {
    test('validates Requirements 3.1 - only us-east-1 and us-west-2 are valid regions', () => {
      expect(isValidRegion('us-east-1')).toBe(true)
      expect(isValidRegion('us-west-2')).toBe(true)
      expect(isValidRegion('us-west-1')).toBe(false)
      expect(isValidRegion('eu-west-1')).toBe(false)
      expect(isValidRegion('invalid')).toBe(false)
    })

    test('validates Requirements 3.2 - normalizeRegion defaults to us-east-1', () => {
      expect(normalizeRegion(undefined)).toBe('us-east-1')
      expect(normalizeRegion('')).toBe('us-east-1')
      expect(normalizeRegion('invalid-region')).toBe('us-east-1')
      expect(normalizeRegion('us-east-1')).toBe('us-east-1')
      expect(normalizeRegion('us-west-2')).toBe('us-west-2')
    })
  })

  describe('URL Validation', () => {
    test('validates valid URLs', () => {
      expect(validateUrl('https://example.com')).toBe(true)
      expect(validateUrl('https://mycompany.awsapps.com/start')).toBe(true)
      expect(validateUrl('http://example.com')).toBe(true)
    })

    test('validates invalid URLs', () => {
      expect(validateUrl('not-a-url')).toBe(false)
      expect(validateUrl('')).toBe(false)
      expect(validateUrl('just text')).toBe(false)
    })
  })
})
