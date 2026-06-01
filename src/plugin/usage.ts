import { KiroAuthDetails, ManagedAccount } from './types'

export async function fetchUsageLimits(auth: KiroAuthDetails): Promise<any> {
  // Try different parameter combinations
  const attempts: Array<{ resourceType?: string; origin?: string }> = [
    { resourceType: 'AGENTIC_REQUEST', origin: 'AI_EDITOR' },
    { origin: 'AI_EDITOR' },
    { resourceType: 'CONVERSATION', origin: 'AI_EDITOR' },
    {}
  ]

  let lastError: Error | null = null

  for (const [index, params] of attempts.entries()) {
    const url = new URL(`https://q.${auth.region}.amazonaws.com/getUsageLimits`)
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
        }
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

        const msg =
          body && body.length > 0
            ? `${body.slice(0, 2000)}${body.length > 2000 ? '…' : ''}`
            : `HTTP ${res.status}`
        const errorMessage = `Status: ${res.status}${errType ? ` (${errType})` : ''}${
          requestId ? ` [${requestId}]` : ''
        }: ${msg}`

        // Only chain to the next param combo for FEATURE_NOT_SUPPORTED.
        // Other failures (429, 401, 5xx, network) bubble up so the caller's
        // retry/backoff handles them, instead of hitting the API 4x per call.
        if (body.includes('FEATURE_NOT_SUPPORTED') && index < attempts.length - 1) {
          lastError = new Error(errorMessage)
          continue
        }

        throw new Error(errorMessage)
      }

      const data: any = await res.json()
      let usedCount = 0,
        limitCount = 0
      if (Array.isArray(data.usageBreakdownList)) {
        for (const s of data.usageBreakdownList) {
          // Kiro reports a rounded integer (currentUsage) plus the exact value
          // (currentUsageWithPrecision) — the latter is what the Kiro dashboard
          // shows (e.g. 70.45 credits). Prefer it; fall back to the integer.
          if (s.freeTrialInfo) {
            usedCount +=
              s.freeTrialInfo.currentUsageWithPrecision ?? s.freeTrialInfo.currentUsage ?? 0
            limitCount += s.freeTrialInfo.usageLimitWithPrecision ?? s.freeTrialInfo.usageLimit ?? 0
          }
          usedCount += s.currentUsageWithPrecision ?? s.currentUsage ?? 0
          limitCount += s.usageLimitWithPrecision ?? s.usageLimit ?? 0
        }
      }
      return { usedCount, limitCount, email: data.userInfo?.email }
    } catch (e) {
      // Network errors bubble up — don't try the next param combo.
      throw e instanceof Error ? e : new Error(String(e))
    }
  }

  throw lastError || new Error('All getUsageLimits attempts failed')
}

// Credits come back fractional (e.g. 70.45); round for display and derive the
// percentage in one place so the startup summary and the high-usage warning agree.
export function summarizeUsage(
  usedCount: number,
  limitCount: number
): { used: number; limit: number; pct: number } {
  const used = Number(usedCount.toFixed(2))
  const limit = Number(limitCount.toFixed(2))
  const pct = limit > 0 ? Math.round((used / limit) * 100) : 0
  return { used, limit, pct }
}

export function updateAccountQuota(
  account: ManagedAccount,
  usage: any,
  accountManager?: any
): void {
  const meta = {
    usedCount: usage.usedCount || 0,
    limitCount: usage.limitCount || 0,
    email: usage.email
  }
  account.usedCount = meta.usedCount
  account.limitCount = meta.limitCount
  if (usage.email) account.email = usage.email
  if (accountManager) accountManager.updateUsage(account.id, meta)
}
