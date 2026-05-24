import { Database } from 'bun:sqlite'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { formatUsageRatio } from './plugin/usage-format.js'

export const USAGE_REFRESH_INTERVAL_MS = 15000

export type UsageAccount = {
  email: string
  authMethod: string
  region: string
  usedCount: number
  limitCount: number
  subscriptionPlan?: string
  isHealthy: boolean
  lastSync: number
  lastUsed: number
}

export type UsageSnapshot = {
  accounts: UsageAccount[]
  error?: string
}

export type UsageSummary = {
  account?: UsageAccount
  plan: string
  used: number
  limit: number
}

export type TuiDisplayOptions = {
  showAccountEmail: boolean
  showPlan: boolean
  showCredits: boolean
}

export type SessionProviderMessage = {
  providerID?: string
  model?: {
    providerID?: string
  }
  info?: {
    providerID?: string
  }
}

export function getOpencodeConfigDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
}

export function getDefaultKiroDbPath(): string {
  return join(getOpencodeConfigDir(), 'kiro.db')
}

export function readUsageSnapshot(dbPath = getDefaultKiroDbPath()): UsageSnapshot {
  if (!existsSync(dbPath)) return { accounts: [] }

  let db: Database | undefined
  try {
    db = new Database(dbPath, { readonly: true })
    const columns = db.prepare('PRAGMA table_info(accounts)').all() as Array<{ name: string }>
    const names = new Set(columns.map((column) => column.name))
    const subscriptionColumn = names.has('subscription_plan')
      ? 'subscription_plan'
      : 'NULL AS subscription_plan'

    const rows = db
      .prepare(
        `
        SELECT email, auth_method, region, used_count, limit_count, ${subscriptionColumn},
               is_healthy, last_sync, last_used
        FROM accounts
        ORDER BY last_used DESC, email ASC
      `
      )
      .all() as any[]

    return { accounts: rows.map(normalizeUsageAccount) }
  } catch (error) {
    return { accounts: [], error: error instanceof Error ? error.message : String(error) }
  } finally {
    db?.close()
  }
}

function normalizeUsageAccount(row: any): UsageAccount {
  return {
    email: String(row.email || ''),
    authMethod: String(row.auth_method || ''),
    region: String(row.region || ''),
    usedCount: Number(row.used_count || 0),
    limitCount: Number(row.limit_count || 0),
    subscriptionPlan: typeof row.subscription_plan === 'string' ? row.subscription_plan : undefined,
    isHealthy: row.is_healthy === 1 || row.is_healthy === true,
    lastSync: Number(row.last_sync || 0),
    lastUsed: Number(row.last_used || 0)
  }
}

export function planLabel(account: UsageAccount | undefined): string {
  if (!account) return 'Kiro'
  if (account.subscriptionPlan) return account.subscriptionPlan
  return account.authMethod === 'idc' ? 'Q Developer' : 'Kiro'
}

export function summarizeUsage(snapshot: UsageSnapshot): UsageSummary {
  const account = snapshot.accounts.find((item) => item.isHealthy) || snapshot.accounts[0]
  const used = account?.usedCount || 0
  const limit = account?.limitCount || 0

  return {
    account,
    plan: planLabel(account),
    used,
    limit
  }
}

export function formatRequestQuota(summary: UsageSummary): string {
  return `Credits: ${formatUsageRatio(summary.used, summary.limit)}`
}

export function resolveTuiDisplayOptions(options: Record<string, unknown> = {}): TuiDisplayOptions {
  return {
    showAccountEmail: options.show_account_email === true,
    showPlan: options.show_plan !== false,
    showCredits: options.show_credits !== false
  }
}

export function isKiroProviderID(providerID: string | undefined): boolean {
  return providerID === 'kiro'
}

export function getMessageProviderID(message: SessionProviderMessage): string | undefined {
  return message.providerID || message.model?.providerID || message.info?.providerID
}

export function getSessionProviderID(
  messages: ReadonlyArray<SessionProviderMessage>
): string | undefined {
  const message = messages.findLast((item) => getMessageProviderID(item))
  return message ? getMessageProviderID(message) : undefined
}

export function shouldShowKiroUsage(
  messages: ReadonlyArray<SessionProviderMessage>,
  fallbackModel?: string
): boolean {
  const sessionProviderID = getSessionProviderID(messages)
  if (sessionProviderID) return isKiroProviderID(sessionProviderID)

  const fallbackProviderID = fallbackModel?.split('/')[0]
  return isKiroProviderID(fallbackProviderID)
}
