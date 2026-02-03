import assert from 'node:assert/strict'
import { test } from 'node:test'

import { ensureProviderBaseURL, getKiroOpenAICompatibleBaseURL } from '../dist/opencode-config.js'

test('getKiroOpenAICompatibleBaseURL uses region and strips path', () => {
  assert.equal(getKiroOpenAICompatibleBaseURL('us-east-1'), 'https://q.us-east-1.amazonaws.com')
  assert.equal(getKiroOpenAICompatibleBaseURL('us-west-2'), 'https://q.us-west-2.amazonaws.com')
})

test('ensureProviderBaseURL sets provider.<id>.options.baseURL if missing', () => {
  const cfg = { provider: { kiro: { models: {} } } }
  const changed = ensureProviderBaseURL(cfg, 'kiro', 'https://q.us-west-2.amazonaws.com')

  assert.equal(changed, true)
  assert.equal(cfg.provider.kiro.options.baseURL, 'https://q.us-west-2.amazonaws.com')
})

test('ensureProviderBaseURL does not override an existing baseURL', () => {
  const cfg = { provider: { kiro: { options: { baseURL: 'https://example.invalid' }, models: {} } } }
  const changed = ensureProviderBaseURL(cfg, 'kiro', 'https://q.us-east-1.amazonaws.com')

  assert.equal(changed, false)
  assert.equal(cfg.provider.kiro.options.baseURL, 'https://example.invalid')
})

test('ensureProviderBaseURL treats empty string as missing', () => {
  const cfg = { provider: { kiro: { options: { baseURL: '   ' }, models: {} } } }
  const changed = ensureProviderBaseURL(cfg, 'kiro', 'https://q.us-east-1.amazonaws.com')

  assert.equal(changed, true)
  assert.equal(cfg.provider.kiro.options.baseURL, 'https://q.us-east-1.amazonaws.com')
})
