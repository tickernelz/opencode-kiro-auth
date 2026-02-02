import assert from 'node:assert/strict'
import { test } from 'node:test'

import { startIDCAuthServer } from '../dist/plugin/server.js'

function makeResponse({ ok, status, body, headers }) {
  return {
    ok,
    status,
    headers: {
      get: (k) => (headers ? headers[k.toLowerCase()] || headers[k] : null)
    },
    async text() {
      return body
    },
    async json() {
      return JSON.parse(body)
    }
  }
}

async function sleep(ms) {
  await new Promise((r) => setTimeout(r, ms))
}

test('auth server: /status includes message alias and /error supports query params', async () => {
  const originalFetch = globalThis.fetch

  globalThis.fetch = async (url, init) => {
    const s = String(url)

    if (s.endsWith('/client/register')) {
      return makeResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({ clientId: 'client-id', clientSecret: 'client-secret' })
      })
    }

    if (s.endsWith('/device_authorization')) {
      return makeResponse({
        ok: true,
        status: 200,
        body: JSON.stringify({
          verificationUri: 'https://example.invalid/verify',
          verificationUriComplete: 'https://example.invalid/verify?user_code=ABCD',
          userCode: 'ABCD-1234',
          deviceCode: 'device-code',
          interval: 1,
          expiresIn: 600
        })
      })
    }

    if (s.includes('/token')) {
      return makeResponse({
        ok: false,
        status: 400,
        body: JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Invalid device code provided'
        })
      })
    }
    return originalFetch(url, init)
  }

  try {
    const { url } = await startIDCAuthServer(
      { defaultRegion: 'us-east-1', defaultStartUrl: 'https://example.invalid/start' },
      19857,
      20
    )

    // Kick off auth.
    await fetch(
      `${url}/begin?startUrl=${encodeURIComponent('https://example.invalid/start')}&region=${encodeURIComponent('us-east-1')}`
    )

    // Wait for polling to run and flip status.
    let status = null
    for (let i = 0; i < 50; i++) {
      const res = await fetch(`${url}/status`)
      status = await res.json()
      if (status.status !== 'pending' && status.status !== 'idle') break
      await sleep(50)
    }

    assert.equal(status.status, 'failed')
    assert.equal(status.error, 'Invalid device code provided')
    assert.equal(status.message, 'Invalid device code provided')

    const errRes = await fetch(`${url}/error?message=Hello%20World`)
    const html = await errRes.text()
    assert.ok(html.includes('Hello World'))
  } finally {
    globalThis.fetch = originalFetch
  }
})
