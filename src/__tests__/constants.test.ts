import { describe, expect, test } from 'bun:test'
import { isLongContextModel, normalizeRegion } from '../constants.js'

describe('isLongContextModel', () => {
  test('returns true for 1M-context Claude and GPT-5.6 models', () => {
    const expected1m = [
      'claude-opus-5-5',
      'claude-sonnet-5-5',
      'claude-opus-5',
      'claude-sonnet-5',
      'claude-opus-4-8',
      'claude-opus-4-7',
      'claude-opus-4-6',
      'claude-sonnet-4-6',
      'claude-opus-4-5',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna'
    ]
    for (const model of expected1m) {
      expect(isLongContextModel(model)).toBe(true)
    }
  })

  test('returns false for standard 200K-context models', () => {
    const standard = ['auto', 'claude-sonnet-4', 'claude-haiku-4-5', 'glm-5']
    for (const model of standard) {
      expect(isLongContextModel(model)).toBe(false)
    }
  })

  test('returns false for unknown model strings', () => {
    expect(isLongContextModel('unknown-model')).toBe(false)
    expect(isLongContextModel('')).toBe(false)
  })
})

describe('normalizeRegion', () => {
  test('accepts configured AWS regions with the installed Zod enum shape', () => {
    expect(normalizeRegion('us-west-2')).toBe('us-west-2')
  })
})
