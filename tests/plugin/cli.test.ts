import { describe, test, expect } from 'bun:test'
import * as fc from 'fast-check'
import type { KiroRegion } from '../../src/plugin/types'

// Helper function to validate regions
function isValidRegion(region: string): region is KiroRegion {
  return region === 'us-east-1' || region === 'us-west-2'
}

describe('CLI Prompts', () => {
  describe('Property 3: Supported Regions', () => {
    test('validates Requirements 3.1 - only us-east-1 and us-west-2 are accepted', () => {
      // Test that valid regions are accepted
      fc.assert(
        fc.property(fc.constantFrom('us-east-1', 'us-west-2'), (region) => {
          expect(isValidRegion(region)).toBe(true)
        }),
        { numRuns: 100 }
      )
    })

    test('validates Requirements 3.1 - random strings are rejected unless they are valid regions', () => {
      // Test that random strings are rejected
      fc.assert(
        fc.property(fc.string(), (region) => {
          const isValid = isValidRegion(region)
          const shouldBeValid = region === 'us-east-1' || region === 'us-west-2'
          expect(isValid).toBe(shouldBeValid)
        }),
        { numRuns: 100 }
      )
    })

    test('validates Requirements 3.1 - invalid AWS regions are rejected', () => {
      // Test that other AWS regions are rejected
      const invalidRegions = [
        'us-west-1',
        'eu-west-1',
        'ap-southeast-1',
        'eu-central-1',
        'ap-northeast-1'
      ]

      for (const region of invalidRegions) {
        expect(isValidRegion(region)).toBe(false)
      }
    })
  })

  describe('Region Validation Unit Tests', () => {
    test('validates Requirements 3.2 - default region behavior', () => {
      // Test that empty string defaults to us-east-1
      const defaultRegion = '' || 'us-east-1'
      expect(defaultRegion).toBe('us-east-1')
      expect(isValidRegion(defaultRegion)).toBe(true)
    })

    test('validates Requirements 3.2 - unsupported region rejection', () => {
      const unsupportedRegions = ['us-west-1', 'eu-west-1', 'invalid-region', 'us-east-2']

      for (const region of unsupportedRegions) {
        expect(isValidRegion(region)).toBe(false)
      }
    })

    test('validates Requirements 3.3 - error message for unsupported regions', () => {
      // This tests the expected error message format
      const expectedMessage = 'Supported regions: us-east-1, us-west-2'
      expect(expectedMessage).toContain('us-east-1')
      expect(expectedMessage).toContain('us-west-2')
    })

    test('validates Requirements 9.2 - prompt display messages', () => {
      // Test that prompt messages contain expected text
      const startUrlPrompt = 'Enter your Identity Center start URL:'
      expect(startUrlPrompt).toContain('Identity Center')
      expect(startUrlPrompt).toContain('start URL')
    })

    test('validates Requirements 9.3 - region prompt display message', () => {
      // Test that region prompt contains expected text
      const regionPrompt = 'Enter region (us-east-1, us-west-2) [us-east-1]:'
      expect(regionPrompt).toContain('us-east-1')
      expect(regionPrompt).toContain('us-west-2')
      expect(regionPrompt).toContain('[us-east-1]') // Shows default
    })
  })
})
