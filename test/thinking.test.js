import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolveThinkingConfig } from '../dist/core/request/thinking.js'

test('resolveThinkingConfig: model suffix enables thinking with default budget', () => {
  const r = resolveThinkingConfig('claude-sonnet-4-5-thinking', {})
  assert.equal(r.enabled, true)
  assert.equal(r.budget, 20000)
})

test('resolveThinkingConfig: explicit thinkingConfig takes precedence', () => {
  const r = resolveThinkingConfig('claude-sonnet-4-5', {
    providerOptions: { thinkingConfig: { thinkingBudget: 12345 } }
  })
  assert.equal(r.enabled, true)
  assert.equal(r.budget, 12345)
})

test('resolveThinkingConfig: variant low/medium/high maps to budgets', () => {
  assert.equal(resolveThinkingConfig('claude-sonnet-4-5', { variant: 'low' }).budget, 8192)
  assert.equal(resolveThinkingConfig('claude-sonnet-4-5', { variant: 'medium' }).budget, 16384)
  assert.equal(resolveThinkingConfig('claude-sonnet-4-5', { variant: 'high' }).budget, 32768)
})

test('resolveThinkingConfig: max is accepted as backward-compatible alias of high', () => {
  const r = resolveThinkingConfig('claude-sonnet-4-5', { providerOptions: { variant: 'max' } })
  assert.equal(r.enabled, true)
  assert.equal(r.budget, 32768)
})
