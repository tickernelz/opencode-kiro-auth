import assert from 'node:assert/strict'
import { test } from 'node:test'

import { authorizeKiroIDC } from '../dist/kiro/oauth-idc.js'

function makeResponse({ ok, status, body }) {
  return {
    ok,
    status,
    async text() {
      return body
    },
    async json() {
      return JSON.parse(body)
    }
  }
}

test('authorizeKiroIDC uses configurable builderIdStartUrl', async () => {
  const originalFetch = globalThis.fetch
  const calls = []

  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init })

    if (String(url) === 'https://example.invalid/start') {
      return {
        ok: true,
        status: 200,
        url: 'https://d-1234567890.awsapps.com/start',
        async text() {
          return ''
        },
        async json() {
          return {}
        }
      }
    }

    if (String(url).endsWith('/client/register')) {
      return makeResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ clientId: 'cid', clientSecret: 'csec' })
      })
    }

    if (String(url).endsWith('/device_authorization')) {
      return makeResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({
          verificationUri: 'https://example.invalid/verify',
          verificationUriComplete: 'https://example.invalid/verify?user_code=AAAA',
          userCode: 'AAAA-BBBB',
          deviceCode: 'device-code',
          interval: 5,
          expiresIn: 600
        })
      })
    }

    return makeResponse({ ok: false, status: 404, body: '' })
  }

  try {
    const customStartUrl = 'https://example.invalid/start/#/?tab=accounts'
    await authorizeKiroIDC('us-east-1', customStartUrl)

    const deviceCall = calls.find((c) => c.url.endsWith('/device_authorization'))
    assert.ok(deviceCall, 'expected /device_authorization call')

    const body = JSON.parse(deviceCall.init.body)
    assert.equal(body.startUrl, 'https://d-1234567890.awsapps.com/start')
  } finally {
    globalThis.fetch = originalFetch
  }
})
