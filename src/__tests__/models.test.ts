import { describe, expect, test } from 'bun:test'
import { getContextWindowSize } from '../plugin/models.js'

describe('getContextWindowSize', () => {
  test('uses the configured long context size for standard model aliases', () => {
    expect(getContextWindowSize('claude-sonnet-4-6')).toBe(1_000_000)
    expect(getContextWindowSize('claude-opus-4-6')).toBe(1_000_000)
  })

  test('preserves the standard context size for standard models', () => {
    expect(getContextWindowSize('claude-sonnet-4-5')).toBe(200_000)
    expect(getContextWindowSize('deepseek-3.2')).toBe(128_000)
  })

  test('supports explicit 1m model aliases', () => {
    expect(getContextWindowSize('claude-sonnet-4-6-1m')).toBe(1_000_000)
  })
})
