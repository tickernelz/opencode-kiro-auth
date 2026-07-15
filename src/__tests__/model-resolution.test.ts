import { describe, expect, test } from 'bun:test'
import { SUPPORTED_MODELS } from '../constants.js'
import { resolveKiroModel } from '../plugin/models.js'

describe('resolveKiroModel', () => {
  test('resolves newly advertised model slugs', () => {
    expect(resolveKiroModel('auto')).toBe('auto')
    expect(resolveKiroModel('gpt-5.6-sol')).toBe('gpt-5.6-sol')
    expect(resolveKiroModel('gpt-5.6-terra')).toBe('gpt-5.6-terra')
    expect(resolveKiroModel('gpt-5.6-luna')).toBe('gpt-5.6-luna')
    expect(resolveKiroModel('claude-opus-4.8')).toBe('claude-opus-4.8')
    expect(resolveKiroModel('claude-opus-4.7')).toBe('claude-opus-4.7')
    expect(resolveKiroModel('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(resolveKiroModel('claude-sonnet-4.6')).toBe('claude-sonnet-4.6')
    expect(resolveKiroModel('deepseek-3.2')).toBe('deepseek-3.2')
    expect(resolveKiroModel('glm-5')).toBe('glm-5')
    expect(resolveKiroModel('minimax-m2.5')).toBe('minimax-m2.5')
    expect(resolveKiroModel('minimax-m2.1')).toBe('minimax-m2.1')
    expect(resolveKiroModel('qwen3-coder-next')).toBe('qwen3-coder-next')
  })

  test('keeps existing supported Claude slugs intact', () => {
    expect(resolveKiroModel('claude-sonnet-4.5')).toBe('claude-sonnet-4.5')
    expect(resolveKiroModel('claude-sonnet-4')).toBe('claude-sonnet-4')
    expect(resolveKiroModel('claude-opus-4-8')).toBe('claude-opus-4.8')
    expect(resolveKiroModel('claude-opus-4-8-thinking')).toBe('claude-opus-4.8')
  })

  test('accepts legacy hyphenated and thinking aliases without listing them by default', () => {
    expect(resolveKiroModel('claude-opus-4-8')).toBe('claude-opus-4.8')
    expect(resolveKiroModel('claude-opus-4-8-thinking')).toBe('claude-opus-4.8')
    expect(resolveKiroModel('claude-opus-4-7')).toBe('claude-opus-4.7')
    expect(resolveKiroModel('claude-opus-4-7-thinking')).toBe('claude-opus-4.7')
    expect(resolveKiroModel('claude-haiku-4.5')).toBe('claude-haiku-4.5')
    expect(resolveKiroModel('claude-haiku-4.5-thinking')).toBe('claude-haiku-4.5')
    expect(resolveKiroModel('claude-opus-4-5')).toBe('claude-opus-4.5')
  })

  test('maps legacy 1m aliases onto their current catalog model', () => {
    expect(resolveKiroModel('claude-sonnet-4-5-1m')).toBe('claude-sonnet-4.5')
    expect(resolveKiroModel('claude-sonnet-4-5-1m-thinking')).toBe('claude-sonnet-4.5')
    expect(resolveKiroModel('claude-sonnet-4.5-1m')).toBe('claude-sonnet-4.5')
    expect(resolveKiroModel('claude-sonnet-4-6-1m')).toBe('claude-sonnet-4.6')
    expect(resolveKiroModel('claude-sonnet-4.6-1m')).toBe('claude-sonnet-4.6')
    expect(resolveKiroModel('claude-opus-4-6-1m')).toBe('claude-opus-4.6')
    expect(resolveKiroModel('claude-opus-4.6-1m')).toBe('claude-opus-4.6')
  })

  test('rejects removed qwen3-coder-480b slug', () => {
    expect(() => resolveKiroModel('qwen3-coder-480b')).toThrow(
      'Unsupported model: qwen3-coder-480b'
    )
  })

  test('supported model list excludes removed qwen3-coder-480b slug', () => {
    expect(SUPPORTED_MODELS).not.toContain('qwen3-coder-480b')
  })

  test('supported model list includes current Kiro documentation models', () => {
    expect(SUPPORTED_MODELS).toContain('gpt-5.6-sol')
    expect(SUPPORTED_MODELS).toContain('gpt-5.6-terra')
    expect(SUPPORTED_MODELS).toContain('gpt-5.6-luna')
    expect(SUPPORTED_MODELS).toContain('claude-opus-4.8')
    expect(SUPPORTED_MODELS).toContain('claude-opus-4.7')
    expect(SUPPORTED_MODELS).toContain('claude-sonnet-5')
    expect(SUPPORTED_MODELS).toContain('glm-5')
  })

  test('rejects docs-only Sonnet 4.0 label as a model id', () => {
    expect(() => resolveKiroModel('claude-sonnet-4.0')).toThrow(
      'Unsupported model: claude-sonnet-4.0'
    )
  })

  test('rejects unknown slugs', () => {
    expect(() => resolveKiroModel('this-model-does-not-exist')).toThrow(
      'Unsupported model: this-model-does-not-exist'
    )
  })
})
