import { describe, expect, test } from 'bun:test'
import { getModelContextWindow } from '../plugin/context-windows.js'
import { getContextWindowSize } from '../plugin/models.js'

describe('getModelContextWindow', () => {
  test('returns the measured 600K family regardless of the -thinking suffix', () => {
    for (const id of [
      'auto',
      'claude-opus-4-7',
      'claude-opus-4-8',
      'claude-opus-5',
      'claude-opus-5-5',
      'claude-sonnet-5',
      'claude-sonnet-5-5',
      'claude-fable-5-1'
    ]) {
      expect(getModelContextWindow(id)).toBe(600_000)
      expect(getModelContextWindow(`${id}-thinking`)).toBe(600_000)
    }
  })

  test('returns 1M only for the models the service really serves at 1M', () => {
    expect(getModelContextWindow('claude-opus-4-6')).toBe(1_000_000)
    expect(getModelContextWindow('claude-sonnet-4-6')).toBe(1_000_000)
    expect(getModelContextWindow('claude-opus-4-6-1m')).toBe(1_000_000)
    expect(getModelContextWindow('claude-sonnet-4-6-1m-thinking')).toBe(1_000_000)
  })

  test('returns 200K for the older Claude models and unknown ids', () => {
    expect(getModelContextWindow('claude-sonnet-4-5')).toBe(200_000)
    expect(getModelContextWindow('claude-haiku-4-5')).toBe(200_000)
    expect(getModelContextWindow('claude-opus-4-5')).toBe(200_000)
    expect(getModelContextWindow('brand-new-model')).toBe(200_000)
  })

  test('keeps the open-weight windows', () => {
    expect(getModelContextWindow('deepseek-3.2')).toBe(128_000)
    expect(getModelContextWindow('minimax-m2.5')).toBe(196_000)
    expect(getModelContextWindow('qwen3-coder-next')).toBe(256_000)
  })

  test('getContextWindowSize delegates to the measured table', () => {
    expect(getContextWindowSize('claude-opus-5-5')).toBe(600_000)
    expect(getContextWindowSize('claude-opus-5')).toBe(600_000)
    expect(getContextWindowSize('claude-opus-4-6')).toBe(1_000_000)
    expect(getContextWindowSize('claude-sonnet-4-5')).toBe(200_000)
  })
})