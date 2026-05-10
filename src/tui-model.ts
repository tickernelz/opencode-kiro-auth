import { type AccountRow, formatWait, statusFor } from './cli-service.js'

export type TuiMode = 'main' | 'actions' | 'confirm' | 'help' | 'diagnostics'
export type TuiActionKind =
  | 'guided-add'
  | 'import'
  | 'switch'
  | 'enable'
  | 'disable'
  | 'reset'
  | 'remove'

export type TuiAction = {
  kind: TuiActionKind
  label: string
  shortcut: string
  description: string
  needsAccount?: boolean
  confirm?: boolean
  danger?: boolean
}

export const TUI_ACTIONS: TuiAction[] = [
  {
    kind: 'guided-add',
    label: 'Guided add account',
    shortcut: 'g / a',
    description: 'Save current login, run Kiro sign-in, then import the new login.'
  },
  {
    kind: 'import',
    label: 'Import current Kiro login',
    shortcut: 'i / y',
    description: 'Copy the currently active kiro-cli login into this plugin account pool.',
    confirm: true
  },
  {
    kind: 'switch',
    label: 'Switch Kiro CLI to selected account',
    shortcut: 's',
    description: 'Write the selected saved account into the real Kiro CLI session.',
    needsAccount: true,
    confirm: true
  },
  {
    kind: 'enable',
    label: 'Enable selected account',
    shortcut: 'e',
    description: 'Allow this account to be used again and clear local unhealthy state.',
    needsAccount: true
  },
  {
    kind: 'disable',
    label: 'Disable selected account',
    shortcut: 'e',
    description: 'Keep this account saved but stop using it for rotation/switching.',
    needsAccount: true,
    confirm: true
  },
  {
    kind: 'reset',
    label: 'Reset selected account health',
    shortcut: 'r',
    description: 'Clear local disabled, unhealthy, cooldown, and rate-limit markers only.',
    needsAccount: true,
    confirm: true
  },
  {
    kind: 'remove',
    label: 'Remove selected saved account',
    shortcut: 'x',
    description: 'Delete this saved plugin account. This does not log out Kiro CLI.',
    needsAccount: true,
    confirm: true,
    danger: true
  }
]

export type AccountSummary = {
  total: number
  ready: number
  disabled: number
  limited: number
  unhealthy: number
}

export function summarizeAccounts(accounts: AccountRow[]): AccountSummary {
  const summary: AccountSummary = {
    total: accounts.length,
    ready: 0,
    disabled: 0,
    limited: 0,
    unhealthy: 0
  }
  for (const account of accounts) {
    const status = statusFor(account)
    if (status === 'healthy') summary.ready += 1
    else if (status === 'disabled') summary.disabled += 1
    else if (status === 'rate-limited') summary.limited += 1
    else summary.unhealthy += 1
  }
  return summary
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function selectedAccount(accounts: AccountRow[], selected: number): AccountRow | undefined {
  return accounts[clamp(selected, 0, Math.max(0, accounts.length - 1))]
}

export function statusLabel(account: AccountRow): 'OK' | 'LIMITED' | 'OFF' | 'BAD' {
  const status = statusFor(account)
  if (status === 'healthy') return 'OK'
  if (status === 'rate-limited') return 'LIMITED'
  if (status === 'disabled') return 'OFF'
  return 'BAD'
}

export function actionEnabled(action: TuiAction, accounts: AccountRow[]): boolean {
  return !action.needsAccount || accounts.length > 0
}

export function actionByKind(kind: TuiActionKind): TuiAction {
  const action = TUI_ACTIONS.find((item) => item.kind === kind)
  if (!action) throw new Error(`Unknown TUI action: ${kind}`)
  return action
}

export function truncate(value: string, width: number): string {
  if (width <= 0) return ''
  if (value.length <= width) return value.padEnd(width)
  if (width <= 1) return value.slice(0, width)
  return `${value.slice(0, Math.max(0, width - 1))}…`
}

export function fitLine(value: string, width: number): string {
  return truncate(value.replace(/\s+/g, ' ').trim(), width).trimEnd()
}

export function wrapText(value: string, width: number): string[] {
  const clean = value.replace(/\s+/g, ' ').trim()
  if (width <= 0) return []
  if (!clean) return ['']
  const words = clean.split(' ')
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    if (word.length > width) {
      if (line) {
        lines.push(line)
        line = ''
      }
      for (let index = 0; index < word.length; index += width)
        lines.push(word.slice(index, index + width))
      continue
    }
    const next = line ? `${line} ${word}` : word
    if (next.length > width) {
      lines.push(line)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(line)
  return lines
}

export function pageWindow(
  total: number,
  selected: number,
  pageSize: number
): { start: number; end: number; page: number; pages: number } {
  if (total <= 0) return { start: 0, end: 0, page: 0, pages: 0 }
  const safePageSize = Math.max(1, pageSize)
  const safeSelected = clamp(selected, 0, total - 1)
  const pages = Math.ceil(total / safePageSize)
  const page = Math.floor(safeSelected / safePageSize)
  const start = page * safePageSize
  return { start, end: Math.min(total, start + safePageSize), page: page + 1, pages }
}

export type ResponsiveLayout = {
  width: number
  innerWidth: number
  compact: boolean
  ultraCompact: boolean
  pageSize: number
}

export function responsiveLayout(columns: number, rows = 30): ResponsiveLayout {
  const width = clamp(columns - 2, 24, 108)
  const ultraCompact = width < 46
  const compact = width < 76
  const reservedRows = ultraCompact ? 15 : compact ? 17 : 19
  return {
    width,
    innerWidth: Math.max(10, width - 6),
    compact,
    ultraCompact,
    pageSize: clamp(rows - reservedRows, 3, ultraCompact ? 5 : 9)
  }
}

export function compactUsage(account: AccountRow): string {
  const used = account.used_count ?? 0
  const limit = account.limit_count ?? 0
  return limit > 0 ? `${used}/${limit}` : `${used}`
}

export function explainStatus(account: AccountRow): string {
  const status = statusFor(account)
  if (status === 'healthy') return 'Ready to use.'
  if (status === 'disabled') return 'Turned off locally. Enable or reset it before use.'
  if (status === 'rate-limited')
    return `Cooling down locally. Reset marker: ${formatWait(account.rate_limit_reset)}.`
  return account.unhealthy_reason || 'Marked unhealthy locally. Reset health if this was temporary.'
}

export function friendlyError(message: string): string[] {
  if (message.includes('node:sqlite') || message.includes('Node 22.5')) {
    return [
      'Node is too old for this CLI.',
      'Use Node.js 22.5+ because Kiro auth storage needs node:sqlite.'
    ]
  }
  if (message.includes('Kiro CLI database not found')) {
    return [
      'Kiro CLI database was not found.',
      'Run `kiro-auth add` or `kiro-cli login`, then import again.'
    ]
  }
  if (message.includes('No Kiro CLI token rows')) {
    return [
      'No active Kiro login token was found.',
      'Use Guided add, complete Kiro sign-in, then return here.'
    ]
  }
  if (message.includes('disabled')) {
    return [message, 'Enable or reset this account before switching to it.']
  }
  return [message]
}
