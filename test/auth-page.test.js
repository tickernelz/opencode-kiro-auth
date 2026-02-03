import assert from 'node:assert/strict'
import { test } from 'node:test'

import { getIDCAuthHtml } from '../dist/plugin/auth-page.js'
import { getIDCCombinedHtml } from '../dist/plugin/auth-page.js'

test('IDC auth page uses error field when redirecting to /error', () => {
  const html = getIDCAuthHtml('https://example.invalid', 'ABCD-1234', 'http://127.0.0.1:1/status')
  assert.ok(
    html.includes("encodeURIComponent(data.error || data.message || 'Authentication failed')"),
    'expected auth page to prefer data.error over data.message'
  )
})

test('combined IDC page does not auto-open the verification URL', () => {
  const html = getIDCCombinedHtml(
    'https://example.invalid/start',
    'us-east-1',
    'http://127.0.0.1:1/begin',
    'http://127.0.0.1:1/status'
  )
  assert.ok(!html.includes('window.open('), 'expected no automatic tab opening')
})
