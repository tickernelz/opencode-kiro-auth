import { KiroAuthDetails, ManagedAccount } from './types'

export function getUsageEndpointBases(region: string): string[] {
  // Kiro documents q.<region>.amazonaws.com as legacy but still required until
  // deprecation completes: https://kiro.dev/docs/cli/privacy-and-security/firewalls/
  if (region.startsWith('us-gov-')) return [`https://q-fips.${region}.amazonaws.com`]
  return [`https://management.${region}.kiro.dev`, `https://q.${region}.amazonaws.com`]
}

export function normalizeSubscriptionPlan(data: any): string | undefined {
  const plan =
    data?.subscriptionInfo?.subscriptionTitle ||
    data?.subscription?.title ||
    data?.subscriptionInfo?.tier ||
    data?.subscription?.tier ||
    data?.tierId

  if (typeof plan !== 'string') return undefined
  const cleaned = plan.trim()
  return cleaned || undefined
}

export function extractUsageTotals(data: any): { usedCount: number; limitCount: number } {
  let usedCount = 0
  let limitCount = 0

  if (Array.isArray(data?.usageBreakdownList)) {
    for (const s of data.usageBreakdownList) {
      if (s.freeTrialInfo) {
        usedCount += s.freeTrialInfo.currentUsageWithPrecision ?? s.freeTrialInfo.currentUsage ?? 0
        limitCount += s.freeTrialInfo.usageLimitWithPrecision ?? s.freeTrialInfo.usageLimit ?? 0
      }
      usedCount += s.currentUsageWithPrecision ?? s.currentUsage ?? 0
      limitCount += s.usageLimitWithPrecision ?? s.usageLimit ?? 0
    }
  }

  return { usedCount, limitCount }
}

export async function fetchUsageLimits(auth: KiroAuthDetails): Promise<any> {
  // Try different parameter combinations
  const attempts: Array<{ resourceType?: string; origin?: string }> = [
    { origin: 'KIRO_CLI' },
    { resourceType: 'AGENTIC_REQUEST', origin: 'KIRO_CLI' },
    { resourceType: 'AGENTIC_REQUEST', origin: 'AI_EDITOR' },
    { origin: 'AI_EDITOR' },
    { resourceType: 'CONVERSATION', origin: 'AI_EDITOR' },
    {}
  ]

  let lastError: Error | null = null

  const endpointBases = getUsageEndpointBases(auth.region)

  for (const [endpointIndex, endpointBase] of endpointBases.entries()) {
    for (const [attemptIndex, params] of attempts.entries()) {
      const url = new URL(`${endpointBase}/getUsageLimits`)
      url.searchParams.set('isEmailRequired', 'true')
      if (params.origin) url.searchParams.set('origin', params.origin)
      if (params.resourceType) url.searchParams.set('resourceType', params.resourceType)
      if (auth.profileArn) url.searchParams.set('profileArn', auth.profileArn)

      try {
        const res = await fetch(url.toString(), {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${auth.access}`,
            'Content-Type': 'application/json',
            'x-amzn-kiro-agent-mode': 'vibe',
            'amz-sdk-request': 'attempt=1; max=1'
          },
          signal: AbortSignal.timeout(30000)
        })

        if (!res.ok) {
          const body = await res.text().catch(() => '')
          const requestId =
            res.headers.get('x-amzn-requestid') ||
            res.headers.get('x-amzn-request-id') ||
            res.headers.get('x-amz-request-id') ||
            ''
          const errType =
            res.headers.get('x-amzn-errortype') || res.headers.get('x-amzn-error-type') || ''

          if (
            body.includes('FEATURE_NOT_SUPPORTED') &&
            (attemptIndex < attempts.length - 1 || endpointIndex < endpointBases.length - 1)
          ) {
            continue
          }

          const msg =
            body && body.length > 0
              ? `${body.slice(0, 2000)}${body.length > 2000 ? '…' : ''}`
              : `HTTP ${res.status}`
          lastError = new Error(
            `Status: ${res.status}${errType ? ` (${errType})` : ''}${
              requestId ? ` [${requestId}]` : ''
            }: ${msg}`
          )
          continue
        }

        const data: any = await res.json()
        const { usedCount, limitCount } = extractUsageTotals(data)
        return {
          usedCount,
          limitCount,
          email: data.userInfo?.email,
          subscriptionPlan: normalizeSubscriptionPlan(data)
        }
      } catch (e) {
        lastError = e instanceof Error ? e : new Error(String(e))
        if (attemptIndex < attempts.length - 1 || endpointIndex < endpointBases.length - 1) continue
      }
    }
  }

  throw lastError || new Error('All getUsageLimits attempts failed')
}

export function updateAccountQuota(
  account: ManagedAccount,
  usage: any,
  accountManager?: any
): void {
  const meta = {
    usedCount: usage.usedCount || 0,
    limitCount: usage.limitCount || 0,
    email: usage.email,
    subscriptionPlan: usage.subscriptionPlan,
    lastSync: Date.now()
  }
  account.usedCount = meta.usedCount
  account.limitCount = meta.limitCount
  account.lastSync = meta.lastSync
  if (usage.email) account.email = usage.email
  if (usage.subscriptionPlan) account.subscriptionPlan = usage.subscriptionPlan
  if (accountManager) accountManager.updateUsage(account.id, meta)
}
