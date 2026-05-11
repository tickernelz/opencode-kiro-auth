import { describe, expect, test } from 'bun:test'
import { type AccountRow } from '../cli-service.js'
import {
  actionByKind,
  actionEnabled,
  clamp,
  friendlyError,
  pageWindow,
  responsiveLayout,
  selectedAccount,
  statusLabel,
  summarizeAccounts,
  truncate,
  wrapText
} from '../tui-model.js'

function account(patch: Partial<AccountRow> = {}): AccountRow {
  return {
    id: patch.id || 'id-1',
    email: patch.email || 'user@example.com',
    auth_method: patch.auth_method || 'desktop',
    region: patch.region || 'us-east-1',
    refresh_token: patch.refresh_token || 'refresh',
    access_token: patch.access_token || 'access',
    expires_at: patch.expires_at || Date.now() + 60_000,
    enabled: patch.enabled ?? 1,
    is_healthy: patch.is_healthy ?? 1,
    rate_limit_reset: patch.rate_limit_reset ?? 0,
    ...patch
  }
}

describe('tui-model', () => {
  test('clamps selection and selected account safely', () => {
    const accounts = [account({ id: 'a' }), account({ id: 'b' })]
    expect(clamp(-1, 0, 1)).toBe(0)
    expect(clamp(5, 0, 1)).toBe(1)
    expect(selectedAccount(accounts, 99)?.id).toBe('b')
  })

  test('summarizes account health with readable status labels', () => {
    const accounts = [
      account({ id: 'ok' }),
      account({ id: 'off', enabled: 0 }),
      account({ id: 'limited', rate_limit_reset: Date.now() + 60_000 }),
      account({ id: 'bad', is_healthy: 0 })
    ]
    expect(summarizeAccounts(accounts)).toMatchObject({
      total: 4,
      ready: 1,
      disabled: 1,
      limited: 1,
      unhealthy: 1
    })
    expect(statusLabel(accounts[0]!)).toBe('OK')
    expect(statusLabel(accounts[1]!)).toBe('OFF')
    expect(statusLabel(accounts[2]!)).toBe('LIMITED')
    expect(statusLabel(accounts[3]!)).toBe('BAD')
  })

  test('disables account-only actions when the pool is empty', () => {
    expect(actionEnabled(actionByKind('guided-add'), [])).toBe(true)
    expect(actionEnabled(actionByKind('import'), [])).toBe(true)
    expect(actionEnabled(actionByKind('switch'), [])).toBe(false)
    expect(actionEnabled(actionByKind('remove'), [])).toBe(false)
  })

  test('truncates using an ellipsis without exceeding target width', () => {
    expect(truncate('abcdef', 4)).toBe('abc…')
    expect(truncate('ab', 4)).toBe('ab  ')
  })

  test('maps common auth errors to friendly recovery copy', () => {
    expect(friendlyError('Kiro CLI database not found: x')[0]).toContain('database')
    expect(friendlyError('No Kiro CLI token rows were found.')[1]).toContain('Guided add')
    expect(friendlyError('Account 1 is disabled')[1]).toContain('Enable')
  })

  test('calculates responsive layouts for tiny and wide terminals', () => {
    expect(responsiveLayout(32, 20)).toMatchObject({
      width: 30,
      ultraCompact: true,
      pageSize: 5
    })
    expect(responsiveLayout(120, 40)).toMatchObject({
      width: 108,
      compact: false,
      pageSize: 9
    })
  })

  test('keeps selected account visible inside a paged account window', () => {
    expect(pageWindow(20, 0, 5)).toEqual({ start: 0, end: 5, page: 1, pages: 4 })
    expect(pageWindow(20, 8, 5)).toEqual({ start: 5, end: 10, page: 2, pages: 4 })
    expect(pageWindow(2, 99, 5)).toEqual({ start: 0, end: 2, page: 1, pages: 1 })
  })

  test('wraps long copy for narrow screens', () => {
    const lines = wrapText('Guided add copies the real Kiro chooser link for manual login.', 18)
    expect(lines.length).toBeGreaterThan(1)
    expect(lines.every((line) => line.length <= 18)).toBe(true)
  })
})
