import { describe, expect, test } from 'bun:test'
import { isLongContextModel, normalizeRegion, SUPPORTED_MODELS } from '../constants.js'

describe('isLongContextModel', () => {
  test('returns true for all 1m model variants', () => {
    const expected1m = SUPPORTED_MODELS.filter((k) => k.includes('-1m'))
    expect(expected1m.length).toBeGreaterThan(0)
    for (const model of expected1m) {
      expect(isLongContextModel(model)).toBe(true)
    }
  })

  test('returns false for standard context models', () => {
    const standard = SUPPORTED_MODELS.filter((k) => !k.includes('-1m'))
    expect(standard.length).toBeGreaterThan(0)
    for (const model of standard) {
      expect(isLongContextModel(model)).toBe(false)
    }
  })

  test('returns false for unknown model strings', () => {
    expect(isLongContextModel('unknown-model')).toBe(false)
    expect(isLongContextModel('')).toBe(false)
    expect(isLongContextModel('claude-sonnet-4-6')).toBe(false)
  })
})

describe('normalizeRegion', () => {
  test('accepts configured AWS regions with the installed Zod enum shape', () => {
    expect(normalizeRegion('us-west-2')).toBe('us-west-2')
  })
})
