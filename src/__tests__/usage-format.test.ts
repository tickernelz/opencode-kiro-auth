import { describe, expect, test } from 'bun:test'
import { formatUsageLimit, formatUsageRatio, formatUsageValue } from '../plugin/usage-format.js'
import {
  extractUsageTotals,
  getUsageEndpointBases,
  normalizeSubscriptionPlan
} from '../plugin/usage.js'

describe('usage formatting', () => {
  test('formats used requests with two decimals and whole plan limits without grouping', () => {
    expect(formatUsageValue(208.823)).toBe('208.82')
    expect(formatUsageLimit(2000)).toBe('2000')
    expect(formatUsageRatio(208.96, 2000)).toBe('208.96 / 2000')
  })

  test('preserves subscription titles returned by getUsageLimits', () => {
    expect(
      normalizeSubscriptionPlan({ subscriptionInfo: { subscriptionTitle: 'KIRO PRO+' } })
    ).toBe('KIRO PRO+')
    expect(normalizeSubscriptionPlan({ subscription: { title: 'PRO' } })).toBe('PRO')
    expect(normalizeSubscriptionPlan({ tierId: 'FREE' })).toBe('FREE')
  })

  test('prefers backend precision fields for usage totals', () => {
    expect(
      extractUsageTotals({
        usageBreakdownList: [
          {
            currentUsage: 209,
            currentUsageWithPrecision: 209.64,
            usageLimit: 2000,
            usageLimitWithPrecision: 2000
          }
        ]
      })
    ).toEqual({ usedCount: 209.64, limitCount: 2000 })
  })

  test('tries Kiro management usage endpoint before legacy q endpoint', () => {
    expect(getUsageEndpointBases('us-east-1')).toEqual([
      'https://management.us-east-1.kiro.dev',
      'https://q.us-east-1.amazonaws.com'
    ])
  })
})
