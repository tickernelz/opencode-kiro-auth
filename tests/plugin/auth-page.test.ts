import { describe, test, expect } from 'bun:test'
import { getIDCAuthHtml, getIdentityCenterAuthHtml } from '../../src/plugin/auth-page'

describe('Authentication Page Titles', () => {
  test('validates Requirements 7.1 - Builder ID page shows "AWS Builder ID Authentication"', () => {
    const html = getIDCAuthHtml(
      'https://device.sso.us-east-1.amazonaws.com',
      'ABC-123',
      '/status'
    )

    expect(html).toContain('<title>AWS Builder ID Authentication</title>')
    expect(html).toContain('<h1>AWS Builder ID Authentication</h1>')
  })

  test('validates Requirements 7.2 - Identity Center page shows "AWS Identity Center Authentication"', () => {
    const html = getIdentityCenterAuthHtml(
      'https://device.sso.us-east-1.amazonaws.com',
      'ABC-123',
      '/status'
    )

    expect(html).toContain('<title>AWS Identity Center Authentication</title>')
    expect(html).toContain('<h1>AWS Identity Center Authentication</h1>')
  })

  test('validates Requirements 7.1 - Builder ID page shows correct subtitle', () => {
    const html = getIDCAuthHtml(
      'https://device.sso.us-east-1.amazonaws.com',
      'ABC-123',
      '/status'
    )

    expect(html).toContain('Complete the authentication in your browser')
  })

  test('validates Requirements 7.2 - Identity Center page shows correct subtitle', () => {
    const html = getIdentityCenterAuthHtml(
      'https://device.sso.us-east-1.amazonaws.com',
      'ABC-123',
      '/status'
    )

    expect(html).toContain("Complete the authentication with your organization's identity provider")
  })

  test('validates Requirements 7.1, 7.2 - both pages show verification code', () => {
    const builderIdHtml = getIDCAuthHtml(
      'https://device.sso.us-east-1.amazonaws.com',
      'TEST-CODE',
      '/status'
    )
    const identityCenterHtml = getIdentityCenterAuthHtml(
      'https://device.sso.us-east-1.amazonaws.com',
      'TEST-CODE',
      '/status'
    )

    expect(builderIdHtml).toContain('TEST-CODE')
    expect(identityCenterHtml).toContain('TEST-CODE')
  })

  test('validates Requirements 7.1, 7.2 - both pages show verification URL', () => {
    const testUrl = 'https://device.sso.us-east-1.amazonaws.com'
    const builderIdHtml = getIDCAuthHtml(testUrl, 'ABC-123', '/status')
    const identityCenterHtml = getIdentityCenterAuthHtml(testUrl, 'ABC-123', '/status')

    expect(builderIdHtml).toContain(testUrl)
    expect(identityCenterHtml).toContain(testUrl)
  })

  test('validates Requirements 7.1, 7.2 - both pages show polling status', () => {
    const builderIdHtml = getIDCAuthHtml(
      'https://device.sso.us-east-1.amazonaws.com',
      'ABC-123',
      '/status'
    )
    const identityCenterHtml = getIdentityCenterAuthHtml(
      'https://device.sso.us-east-1.amazonaws.com',
      'ABC-123',
      '/status'
    )

    expect(builderIdHtml).toContain('Waiting for authentication...')
    expect(identityCenterHtml).toContain('Waiting for authentication...')
  })
})
