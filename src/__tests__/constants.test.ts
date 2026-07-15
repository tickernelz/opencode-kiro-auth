import { describe, expect, test } from 'bun:test'
import {
  DEFAULT_MODEL_IDS,
  DEFAULT_PROVIDER_MODELS,
  isLongContextModel,
  normalizeRegion
} from '../constants.js'

describe('isLongContextModel', () => {
  test('returns true for long-context models', () => {
    expect(isLongContextModel('claude-opus-4.8')).toBe(true)
    expect(isLongContextModel('claude-opus-4-8')).toBe(true)
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
  const variants = (model: string) => (DEFAULT_PROVIDER_MODELS[model] as any)?.variants

  test('surfaces every default model in the OpenCode provider config', () => {
    for (const model of DEFAULT_MODEL_IDS) {
      expect(model in DEFAULT_PROVIDER_MODELS).toBe(true)
    }
  })

  test('defines the exact Kiro effort variants for supported models', () => {
    expect(variants('claude-opus-4.8')).toEqual({
      low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' },
      high: { reasoningEffort: 'high' },
      xhigh: { reasoningEffort: 'xhigh' },
      max: { reasoningEffort: 'max' }
    })
    expect(variants('claude-opus-4.6')).toEqual({
      low: { reasoningEffort: 'low' },
      medium: { reasoningEffort: 'medium' },
      high: { reasoningEffort: 'high' },
      max: { reasoningEffort: 'max' }
    })
    expect(variants('claude-opus-4.5')).toEqual({
      low: { disabled: true },
      medium: { disabled: true },
      high: { disabled: true }
    })
    expect(variants('claude-sonnet-5')).toEqual({
      low: { disabled: true },
      medium: { disabled: true },
      high: { disabled: true }
    })
    for (const model of ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      expect(variants(model)).toEqual({
        low: { reasoningEffort: 'low' },
        medium: { reasoningEffort: 'medium' },
        high: { reasoningEffort: 'high' },
        xhigh: { reasoningEffort: 'xhigh' },
        max: { reasoningEffort: 'max' }
      })
    }
  })

  test('surfaces only the official Kiro CLI model slugs by default', () => {
    expect(DEFAULT_MODEL_IDS).toEqual([
      'auto',
      'gpt-5.6-sol',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'claude-opus-4.8',
      'claude-opus-4.7',
      'claude-opus-4.6',
      'claude-opus-4.5',
      'claude-sonnet-4.6',
      'claude-sonnet-5',
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
    expect(DEFAULT_PROVIDER_MODELS['gpt-5.6-sol']?.limit.context).toBe(272000)
    expect(DEFAULT_PROVIDER_MODELS['gpt-5.6-terra']?.limit.context).toBe(272000)
    expect(DEFAULT_PROVIDER_MODELS['gpt-5.6-luna']?.limit.context).toBe(272000)
    expect(DEFAULT_PROVIDER_MODELS.auto?.limit.context).toBe(1000000)
    expect(DEFAULT_PROVIDER_MODELS['claude-opus-4.8']?.limit.context).toBe(1000000)
    expect(DEFAULT_PROVIDER_MODELS['claude-opus-4.8']?.limit.output).toBe(128000)
    expect(DEFAULT_PROVIDER_MODELS['claude-opus-4.7']?.limit.context).toBe(1000000)
    expect(DEFAULT_PROVIDER_MODELS['claude-opus-4.6']?.limit.context).toBe(1000000)
    expect(DEFAULT_PROVIDER_MODELS['claude-sonnet-4.6']?.limit.context).toBe(1000000)
    expect(DEFAULT_PROVIDER_MODELS['claude-opus-4.5']?.limit.context).toBe(200000)
    expect(DEFAULT_PROVIDER_MODELS['claude-sonnet-4.5']?.limit.context).toBe(200000)
    expect(DEFAULT_PROVIDER_MODELS['glm-5']?.limit.context).toBe(200000)
    expect(DEFAULT_PROVIDER_MODELS['deepseek-3.2']?.limit.context).toBe(164000)
    expect(DEFAULT_PROVIDER_MODELS['minimax-m2.5']?.limit.context).toBe(196000)
    expect(DEFAULT_PROVIDER_MODELS['minimax-m2.1']?.limit.context).toBe(196000)
  })

  test('uses current Kiro model credit multipliers', () => {
    expect(DEFAULT_PROVIDER_MODELS['gpt-5.6-sol']?.name).toContain('2.4x')
    expect(DEFAULT_PROVIDER_MODELS['gpt-5.6-terra']?.name).toContain('1.2x')
    expect(DEFAULT_PROVIDER_MODELS['gpt-5.6-luna']?.name).toContain('0.6x')
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

describe('normalizeRegion', () => {
  test('accepts configured AWS regions with the installed Zod enum shape', () => {
    expect(normalizeRegion('us-west-2')).toBe('us-west-2')
  })
})
