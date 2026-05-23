import { describe, expect, test } from 'bun:test'
import { DEFAULT_MODEL_IDS, DEFAULT_PROVIDER_MODELS, isLongContextModel } from '../constants.js'

describe('isLongContextModel', () => {
  test('returns true for long-context models', () => {
    expect(isLongContextModel('claude-opus-4.7')).toBe(true)
    expect(isLongContextModel('claude-opus-4-7')).toBe(true)
    expect(isLongContextModel('claude-opus-4.7-thinking')).toBe(true)
    expect(isLongContextModel('claude-opus-4.6')).toBe(true)
    expect(isLongContextModel('claude-sonnet-4.6')).toBe(true)
  })

  test('returns false for standard context models', () => {
    expect(isLongContextModel('claude-opus-4.5')).toBe(false)
    expect(isLongContextModel('claude-sonnet-4.5')).toBe(false)
    expect(isLongContextModel('claude-sonnet-4-5')).toBe(false)
    expect(isLongContextModel('claude-haiku-4.5')).toBe(false)
    expect(isLongContextModel('deepseek-3.2')).toBe(false)
  })

  test('returns false for unknown model strings', () => {
    expect(isLongContextModel('unknown-model')).toBe(false)
    expect(isLongContextModel('')).toBe(false)
  })
})

describe('DEFAULT_PROVIDER_MODELS', () => {
  test('surfaces every default model in the OpenCode provider config', () => {
    for (const model of DEFAULT_MODEL_IDS) {
      expect(model in DEFAULT_PROVIDER_MODELS).toBe(true)
    }
  })

  test('does not define custom variants (OpenCode handles them)', () => {
    for (const model of Object.values(DEFAULT_PROVIDER_MODELS)) {
      expect(model).not.toHaveProperty('variants')
    }
  })

  test('surfaces only the official Kiro CLI model slugs by default', () => {
    expect(DEFAULT_MODEL_IDS).toEqual([
      'auto',
      'claude-opus-4.7',
      'claude-opus-4.6',
      'claude-opus-4.5',
      'claude-sonnet-4.6',
      'claude-sonnet-4.5',
      'claude-sonnet-4',
      'claude-haiku-4.5',
      'deepseek-3.2',
      'minimax-m2.5',
      'glm-5',
      'minimax-m2.1',
      'qwen3-coder-next'
    ])
  })

  test('uses current Kiro context windows', () => {
    expect(DEFAULT_PROVIDER_MODELS['claude-opus-4.7']?.limit.context).toBe(1000000)
    expect(DEFAULT_PROVIDER_MODELS['claude-opus-4.6']?.limit.context).toBe(1000000)
    expect(DEFAULT_PROVIDER_MODELS['claude-sonnet-4.6']?.limit.context).toBe(1000000)
    expect(DEFAULT_PROVIDER_MODELS['claude-opus-4.5']?.limit.context).toBe(200000)
    expect(DEFAULT_PROVIDER_MODELS['claude-sonnet-4.5']?.limit.context).toBe(200000)
    expect(DEFAULT_PROVIDER_MODELS['glm-5']?.limit.context).toBe(200000)
  })

  test('uses current Kiro open-weight credit multipliers', () => {
    expect(DEFAULT_PROVIDER_MODELS['deepseek-3.2']?.name).toContain('0.25x')
    expect(DEFAULT_PROVIDER_MODELS['glm-5']?.name).toContain('0.5x')
    expect(DEFAULT_PROVIDER_MODELS['minimax-m2.5']?.name).toContain('0.25x')
    expect(DEFAULT_PROVIDER_MODELS['qwen3-coder-next']?.name).toContain('0.05x')
  })

  test('uses models.dev display name for Sonnet 4 without adding a duplicate slug', () => {
    expect(DEFAULT_PROVIDER_MODELS['claude-sonnet-4']?.name).toContain('Claude Sonnet 4')
    expect(DEFAULT_MODEL_IDS).not.toContain('claude-sonnet-4.0')
  })
})
