import { describe, expect, test } from 'bun:test'
import {
  budgetToEffort,
  getEffectiveEffort,
  getEffortSchemaPath,
  resolveEffort,
  supportsEffort,
  supportsXHighEffort
} from '../plugin/effort.js'

describe('effort module', () => {
  describe('supportsEffort', () => {
    test('returns true for supported models', () => {
      expect(supportsEffort('claude-opus-4.8')).toBe(true)
      expect(supportsEffort('claude-opus-4.7')).toBe(true)
      expect(supportsEffort('claude-sonnet-4.6')).toBe(true)
      expect(supportsEffort('claude-sonnet-4.6-1m')).toBe(true)
      expect(supportsEffort('gpt-5.6-sol')).toBe(true)
      expect(supportsEffort('gpt-5.6-terra')).toBe(true)
      expect(supportsEffort('gpt-5.6-luna')).toBe(true)
    })

    test('returns false for unsupported models', () => {
      expect(supportsEffort('claude-haiku-4.5')).toBe(false)
      expect(supportsEffort('claude-opus-4.5')).toBe(false)
      expect(supportsEffort('claude-sonnet-4.5')).toBe(false)
      expect(supportsEffort('unknown-model')).toBe(false)
    })
  })

  describe('supportsXHighEffort', () => {
    test('returns true for models with the five-level effort enum', () => {
      expect(supportsXHighEffort('claude-opus-4.8')).toBe(true)
      expect(supportsXHighEffort('claude-opus-4.7')).toBe(true)
      expect(supportsXHighEffort('gpt-5.6-sol')).toBe(true)
      expect(supportsXHighEffort('gpt-5.6-terra')).toBe(true)
      expect(supportsXHighEffort('gpt-5.6-luna')).toBe(true)
    })

    test('returns false for other models', () => {
      expect(supportsXHighEffort('claude-opus-4.6')).toBe(false)
      expect(supportsXHighEffort('claude-sonnet-4.6')).toBe(false)
    })
  })

  describe('getEffortSchemaPath', () => {
    test('returns the request schema path advertised for each model family', () => {
      expect(getEffortSchemaPath('gpt-5.6-sol')).toBe('reasoning')
      expect(getEffortSchemaPath('gpt-5.6-terra')).toBe('reasoning')
      expect(getEffortSchemaPath('gpt-5.6-luna')).toBe('reasoning')
      expect(getEffortSchemaPath('claude-opus-4.8')).toBe('output_config')
      expect(getEffortSchemaPath('claude-sonnet-4.6')).toBe('output_config')
      expect(getEffortSchemaPath('claude-haiku-4.5')).toBeUndefined()
    })
  })

  describe('resolveEffort', () => {
    test('returns undefined for unsupported models', () => {
      expect(resolveEffort('claude-haiku-4.5', 'max')).toBeUndefined()
    })

    test('returns effort as-is for supported levels', () => {
      expect(resolveEffort('claude-opus-4.8', 'low')).toBe('low')
      expect(resolveEffort('claude-opus-4.8', 'max')).toBe('max')
      expect(resolveEffort('claude-opus-4.8', 'xhigh')).toBe('xhigh')
      expect(resolveEffort('gpt-5.6-sol', 'xhigh')).toBe('xhigh')
      expect(resolveEffort('gpt-5.6-terra', 'max')).toBe('max')
      expect(resolveEffort('gpt-5.6-luna', 'low')).toBe('low')
    })

    test('rejects xhigh for models without xhigh support', () => {
      expect(resolveEffort('claude-sonnet-4.6', 'xhigh')).toBeUndefined()
      expect(resolveEffort('claude-opus-4.6', 'xhigh')).toBeUndefined()
    })
  })

  describe('budgetToEffort', () => {
    test('returns undefined for unsupported models', () => {
      expect(budgetToEffort(100000, 'claude-haiku-4.5')).toBeUndefined()
    })

    test('maps budget ranges correctly', () => {
      expect(budgetToEffort(5000, 'claude-opus-4.8')).toBe('low')
      expect(budgetToEffort(16384, 'claude-opus-4.8')).toBe('medium')
      expect(budgetToEffort(24576, 'claude-opus-4.8')).toBe('high')
      expect(budgetToEffort(32768, 'claude-opus-4.8')).toBe('max')
      expect(budgetToEffort(80000, 'claude-opus-4.8')).toBe('max')
    })

    test('maps to max instead of xhigh for non-xhigh models', () => {
      expect(budgetToEffort(80000, 'claude-sonnet-4.6')).toBe('max')
    })
  })

  describe('getEffectiveEffort', () => {
    test('returns undefined for unsupported models', () => {
      expect(getEffectiveEffort('claude-haiku-4.5', true, 100000)).toBeUndefined()
    })

    test('uses explicit config when provided', () => {
      expect(getEffectiveEffort('claude-opus-4.8', true, 20000, 'max')).toBe('max')
      expect(getEffectiveEffort('claude-opus-4.8', false, 20000, 'high')).toBe('high')
    })

    test('gives the selected OpenCode variant priority over static config', () => {
      expect(getEffectiveEffort('claude-opus-4.8', true, 20000, 'low', false, 'max')).toBe('max')
      expect(
        getEffectiveEffort('claude-sonnet-4.6', true, 20000, undefined, false, 'xhigh')
      ).toBeUndefined()
    })

    test('returns undefined when not thinking and no config', () => {
      expect(getEffectiveEffort('claude-opus-4.8', false, 20000)).toBeUndefined()
    })

    test('uses budget mapping when thinking and auto-mapping enabled', () => {
      expect(getEffectiveEffort('claude-opus-4.8', true, 128000, undefined, true)).toBe('max')
      expect(getEffectiveEffort('claude-opus-4.8', true, 20000, undefined, true)).toBe('medium')
    })

    test('falls back to medium when auto-mapping disabled', () => {
      expect(getEffectiveEffort('claude-opus-4.8', true, 128000, undefined, false)).toBe('medium')
    })
  })
})
