import { stdin, stdout } from 'node:process'
import {
  type AccountRow,
  type CommandResult,
  addCurrentKiroCliAccount,
  enableAccount,
  formatDate,
  formatWait,
  getKiroCliDbPath,
  getPluginDbPath,
  readAccounts,
  readKiroCliEmail,
  removeAccount,
  resetAccount,
  switchAccount
} from './cli-service.js'
import { clamp, compactUsage, friendlyError, pageWindow, statusLabel } from './tui-model.js'

type ActionResult = 'quit' | 'add'
type Screen = 'dashboard' | 'account' | 'help' | 'search' | 'diagnostics' | 'confirm'
type MainAction = 'add' | 'import' | 'refresh' | 'diagnostics' | 'account'
type AccountAction = 'back' | 'toggle' | 'switch' | 'relogin' | 'reset' | 'delete'
type ConfirmAction =
  | { type: 'import' }
  | { type: 'switch'; index: number }
  | { type: 'toggle'; index: number }
  | { type: 'reset'; index: number }
  | { type: 'delete'; index: number }

type Snapshot = {
  accounts: AccountRow[]
  cliEmail?: string
  pluginDbPath: string
  kiroCliDbPath: string
}

type MenuItem = {
  id: string
  label: string
  kind: 'heading' | 'separator' | 'action' | 'account'
  color?: 'green' | 'yellow' | 'red' | 'muted'
  hint?: string
  action?: MainAction
  accountIndex?: number
}

type State = {
  screen: Screen
  cursor: number
  accountCursor: number
  query: string
  status: string
  confirm?: ConfirmAction
  renderedLines: number
}

const ANSI = {
  hide: '\x1b[?25l',
  show: '\x1b[?25h',
  clearScreen: '\x1b[2J',
  clearLine: '\x1b[2K',
  moveTo: (row: number, col: number) => `\x1b[${row};${col}H`,
  up: (lines: number) => `\x1b[${lines}A`,
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  muted: '\x1b[90m',
  bgGreen: '\x1b[42m',
  black: '\x1b[30m'
} as const

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}

function fit(value: string, width: number): string {
  const plain = stripAnsi(value.replace(/\s+/g, ' ').trimEnd())
  if (plain.length <= width) return value.trimEnd()
  if (width <= 1) return plain.slice(0, width)
  return `${plain.slice(0, width - 1)}…`
}

function paint(value: string, code?: string): string {
  return code ? `${code}${value}${ANSI.reset}` : value
}

function tone(color: MenuItem['color']): string | undefined {
  if (color === 'green') return ANSI.green
  if (color === 'yellow') return ANSI.yellow
  if (color === 'red') return ANSI.red
  if (color === 'muted') return ANSI.muted
  return ANSI.green
}

function badge(label: string, color: string = ANSI.green): string {
  return `${color}${ANSI.bold}[${label}]${ANSI.reset}`
}

function statusTone(account: AccountRow): string {
  const label = statusLabel(account)
  if (label === 'OK') return ANSI.green
  if (label === 'LIMITED') return ANSI.yellow
  if (label === 'OFF') return ANSI.muted
  return ANSI.red
}

function readSnapshot(): Snapshot {
  return {
    accounts: readAccounts(),
    cliEmail: readKiroCliEmail(),
    pluginDbPath: getPluginDbPath(),
    kiroCliDbPath: getKiroCliDbPath()
  }
}

function relativeTime(value?: number | null): string {
  if (!value) return 'never'
  const age = Date.now() - value
  if (age < 86_400_000) return 'today'
  const days = Math.floor(age / 86_400_000)
  if (days === 1) return 'yesterday'
  if (days < 7) return `${days}d ago`
  return formatDate(value).slice(0, 10)
}

function quotaText(account: AccountRow): string {
  const used = account.used_count ?? 0
  const limit = account.limit_count ?? 0
  if (limit <= 0) return `usage ${used}`
  const left = Math.max(0, limit - used)
  const pct = Math.max(0, Math.round((left / limit) * 100))
  return `${compactUsage(account)} · ${pct}% left`
}

function filteredAccountIndexes(snapshot: Snapshot, query: string): number[] {
  const needle = query.trim().toLowerCase()
  return snapshot.accounts
    .map((account, index) => ({ account, index }))
    .filter(
      ({ account }) =>
        !needle ||
        account.email.toLowerCase().includes(needle) ||
        account.region.toLowerCase().includes(needle) ||
        statusLabel(account).toLowerCase().includes(needle)
    )
    .map(({ index }) => index)
}

function currentIndex(snapshot: Snapshot): number {
  return snapshot.accounts.findIndex((account) => account.email === snapshot.cliEmail)
}

function buildMainItems(snapshot: Snapshot, query: string): MenuItem[] {
  const accountIndexes = filteredAccountIndexes(snapshot, query)
  const items: MenuItem[] = [
    { id: 'actions', label: 'Kiro Actions', kind: 'heading' },
    { id: 'add', label: 'Add Account', kind: 'action', action: 'add', color: 'green' },
    {
      id: 'import',
      label: 'Import Current Kiro Login',
      kind: 'action',
      action: 'import',
      color: 'green'
    },
    {
      id: 'refresh',
      label: 'Refresh Account List',
      kind: 'action',
      action: 'refresh',
      color: 'green'
    },
    {
      id: 'diagnostics',
      label: 'Diagnostics',
      kind: 'action',
      action: 'diagnostics',
      color: 'yellow'
    },
    { id: 'sep1', label: '', kind: 'separator' },
    {
      id: 'accounts',
      label: query ? `Saved Accounts - Search: ${query}` : 'Saved Accounts',
      kind: 'heading'
    }
  ]

  if (accountIndexes.length === 0) {
    items.push({
      id: 'no-accounts',
      label: query ? 'No accounts match your search' : 'No saved accounts yet',
      kind: 'action',
      color: 'muted',
      action: 'add'
    })
  } else {
    for (const index of accountIndexes) {
      const account = snapshot.accounts[index]
      if (!account) continue
      items.push({
        id: `account-${index}`,
        label: accountLabel(snapshot, account, index),
        kind: 'account',
        action: 'account',
        accountIndex: index,
        color:
          statusLabel(account) === 'OK'
            ? 'green'
            : statusLabel(account) === 'BAD'
              ? 'red'
              : 'yellow',
        hint: accountHint(account)
      })
    }
  }

  return items
}

function accountLabel(snapshot: Snapshot, account: AccountRow, index: number): string {
  const tags: string[] = []
  if (index === currentIndex(snapshot)) tags.push(badge('current', ANSI.green))
  if (account.enabled === 0) tags.push(badge('disabled', ANSI.muted))
  else tags.push(badge('active', ANSI.green))
  const status = statusLabel(account)
  if (status !== 'OK') tags.push(badge(status.toLowerCase(), statusTone(account)))
  return `${index + 1}. ${account.email} ${tags.join(' ')}`
}

function accountHint(account: AccountRow): string {
  return `Last used: ${relativeTime(account.last_used)} | Limits: ${quotaText(account)} | Reset: ${formatWait(account.rate_limit_reset)}`
}

function isSelectable(item: MenuItem): boolean {
  return item.kind === 'action' || item.kind === 'account'
}

function firstAccountSelectable(items: MenuItem[]): number {
  const index = items.findIndex((item) => item.kind === 'account')
  return index === -1 ? firstSelectable(items) : index
}

function firstSelectable(items: MenuItem[]): number {
  const index = items.findIndex(isSelectable)
  return index >= 0 ? index : 0
}

function decodeKeys(input: string): string[] {
  const keys: string[] = []
  for (let index = 0; index < input.length; index += 1) {
    const ch = input[index]!
    if (ch === '\x1b') {
      const arrow = input.slice(index, index + 3)
      if (arrow === '\x1b[A' || arrow === '\x1b[B' || arrow === '\x1b[C' || arrow === '\x1b[D') {
        keys.push(arrow)
        index += 2
      } else {
        keys.push(ch)
      }
    } else if (ch === '\r' && input[index + 1] === '\n') {
      keys.push('\r')
      index += 1
    } else {
      keys.push(ch)
    }
  }
  return keys
}

function moveCursor(items: MenuItem[], cursor: number, direction: 1 | -1): number {
  if (items.length === 0) return 0
  let next = cursor
  for (let tries = 0; tries < items.length; tries += 1) {
    next = (next + direction + items.length) % items.length
    if (isSelectable(items[next]!)) return next
  }
  return cursor
}

function writeFrame(state: State, lines: string[]): void {
  if (state.renderedLines === 0) stdout.write(ANSI.clearScreen + ANSI.moveTo(1, 1))
  else stdout.write(ANSI.up(state.renderedLines))
  let written = 0
  for (const line of lines) {
    stdout.write(`${ANSI.clearLine}${line}\n`)
    written += 1
  }
  while (written < state.renderedLines) {
    stdout.write(`${ANSI.clearLine}\n`)
    written += 1
  }
  state.renderedLines = written
}

function renderMenuItems(items: MenuItem[], state: State, width: number, rows: number): string[] {
  const maxItems = clamp(rows - 4, 6, 18)
  const win = pageWindow(items.length, state.cursor, maxItems)
  const visible = items.slice(win.start, win.end)
  const lines: string[] = []
  for (const [offset, item] of visible.entries()) {
    const index = win.start + offset
    if (item.kind === 'separator') {
      lines.push('')
      continue
    }
    if (item.kind === 'heading') {
      lines.push(`  ${paint(item.label, ANSI.muted)}`)
      continue
    }
    const selected = index === state.cursor
    const prefix = selected ? '>' : 'o'
    const text = `${prefix} ${item.label}`
    if (selected) {
      lines.push(
        ` ${ANSI.bgGreen}${ANSI.black}${ANSI.bold}${fit(stripAnsi(text), Math.max(8, width - 2))}${ANSI.reset}`
      )
      if (item.hint) lines.push(`   ${paint(fit(item.hint, Math.max(8, width - 5)), ANSI.muted)}`)
    } else {
      lines.push(
        ` ${paint(prefix, ANSI.muted)} ${fit(item.label, Math.max(8, width - 4)).replace(stripAnsi(item.label), paint(stripAnsi(item.label), tone(item.color)))}`
      )
    }
  }
  if (items.length > visible.length)
    lines.push(` ${paint(`${win.start + 1}-${win.end}/${items.length}`, ANSI.muted)}`)
  return lines
}

function renderDashboard(snapshot: Snapshot, state: State, width: number, rows: number): string[] {
  const items = buildMainItems(snapshot, state.query)
  if (!isSelectable(items[state.cursor]!)) state.cursor = firstSelectable(items)
  const title = `${paint('+', ANSI.green)} Accounts Dashboard ${paint('(Kiro)', ANSI.muted)}`
  const subtitle =
    state.status ||
    `${snapshot.accounts.length} saved | active: ${snapshot.cliEmail || 'not detected'}`
  return [
    fit(title, width),
    state.query
      ? fit(`  ${paint('Search:', ANSI.yellow)} ${state.query}`, width)
      : fit(`  ${paint(subtitle, ANSI.muted)}`, width),
    '',
    ...renderMenuItems(items, state, width, rows),
    fit(` ${paint('↑↓ Move | Enter Select | / Search | 1-9 Switch | Q Back', ANSI.muted)}`, width),
    paint('+', ANSI.green)
  ]
}

function accountActions(account: AccountRow): MenuItem[] {
  return [
    { id: 'back', label: 'Back', kind: 'action', action: 'account', color: 'green' },
    {
      id: 'toggle',
      label: account.enabled === 0 ? 'Enable Account' : 'Disable Account',
      kind: 'action',
      color: account.enabled === 0 ? 'green' : 'yellow'
    },
    { id: 'switch', label: 'Set As Current', kind: 'action', color: 'green' },
    { id: 'relogin', label: 'Re-Login', kind: 'action', color: 'green' },
    { id: 'reset', label: 'Reset Health', kind: 'action', color: 'yellow' },
    { id: 'delete', label: 'Delete Account', kind: 'action', color: 'red' }
  ]
}

function renderAccount(snapshot: Snapshot, state: State, width: number, rows: number): string[] {
  const index = Math.max(0, Math.min(snapshot.accounts.length - 1, state.accountCursor))
  const account = snapshot.accounts[index]
  if (!account)
    return [
      paint('+', ANSI.green),
      'No account selected.',
      ` ${paint('Q Back', ANSI.muted)}`,
      paint('+', ANSI.green)
    ]
  const items = accountActions(account)
  state.cursor = clamp(state.cursor, 0, items.length - 1)
  const heading = `${paint('+', ANSI.green)} ${index + 1}. ${account.email} ${account.enabled === 0 ? badge('disabled', ANSI.muted) : badge('active', ANSI.green)}`
  const info = `  Added: ${formatDate(account.last_sync).slice(0, 10)} | Used: ${relativeTime(account.last_used)} | Status: ${statusLabel(account).toLowerCase()}`
  return [
    fit(heading, width),
    fit(info, width),
    '',
    ...renderMenuItems(items, state, width, rows),
    fit(
      ` ${paint('↑↓ Move | Enter Select | S Use | R Re-Login | D Delete | Q Back', ANSI.muted)}`,
      width
    ),
    paint('+', ANSI.green)
  ]
}

function renderHelp(width: number): string[] {
  return [
    `${paint('+', ANSI.green)} Help`,
    'Dashboard matches codex-multi-auth style but stays Kiro-scoped.',
    'Enter selects. / searches. 1-9 switches saved accounts with confirm.',
    'Add/import use supported Kiro CLI login and sync only.',
    'Disable/reset/delete only change the local plugin pool unless noted.',
    '',
    ` ${paint('Q Back', ANSI.muted)}`,
    paint('+', ANSI.green)
  ].map((line) => fit(line, width))
}

function renderSearch(state: State, width: number): string[] {
  return [
    `${paint('+', ANSI.green)} Search`,
    `  ${state.query}`,
    '',
    ` ${paint('Type filter | Enter Apply | Esc Clear | Q Back', ANSI.muted)}`,
    paint('+', ANSI.green)
  ].map((line) => fit(line, width))
}

function renderDiagnostics(snapshot: Snapshot, width: number): string[] {
  return [
    `${paint('+', ANSI.green)} Diagnostics`,
    ` Plugin DB: ${snapshot.pluginDbPath}`,
    ` Kiro DB:   ${snapshot.kiroCliDbPath}`,
    ` Active:    ${snapshot.cliEmail || 'not detected'}`,
    '',
    ` ${paint('Q Back', ANSI.muted)}`,
    paint('+', ANSI.green)
  ].map((line) => fit(line, width))
}

function confirmText(action: ConfirmAction, snapshot: Snapshot): string {
  if (action.type === 'import') return 'Import active Kiro CLI login into the saved pool?'
  const account = snapshot.accounts[action.index]
  const email = account?.email || 'selected account'
  if (action.type === 'switch') return `Set ${email} as current Kiro CLI account?`
  if (action.type === 'toggle')
    return account?.enabled === 0 ? `Enable ${email}?` : `Disable ${email}?`
  if (action.type === 'reset') return `Reset local health/rate-limit markers for ${email}?`
  return `Delete saved account ${email}? This does not log out Kiro CLI.`
}

function renderConfirm(snapshot: Snapshot, state: State, width: number): string[] {
  return [
    `${paint('+', ANSI.green)} ${paint('Confirm', ANSI.yellow)}`,
    ` ${state.confirm ? confirmText(state.confirm, snapshot) : 'Confirm?'}`,
    '',
    ` ${paint('Y Confirm | N/Q Back', ANSI.muted)}`,
    paint('+', ANSI.green)
  ].map((line) => fit(line, width))
}

function render(snapshot: Snapshot, state: State): void {
  const width = Math.max(40, Math.min(stdout.columns || 100, 140))
  const rows = stdout.rows || 28
  const lines =
    state.screen === 'account'
      ? renderAccount(snapshot, state, width, rows)
      : state.screen === 'help'
        ? renderHelp(width)
        : state.screen === 'search'
          ? renderSearch(state, width)
          : state.screen === 'diagnostics'
            ? renderDiagnostics(snapshot, width)
            : state.screen === 'confirm'
              ? renderConfirm(snapshot, state, width)
              : renderDashboard(snapshot, state, width, rows)
  writeFrame(state, lines)
}

function runConfirmed(action: ConfirmAction, snapshot: Snapshot, state: State): Snapshot {
  let result: CommandResult
  if (action.type === 'import') result = addCurrentKiroCliAccount()
  else {
    const cliIndex = String(action.index + 1)
    if (action.type === 'switch') result = switchAccount(cliIndex)
    else if (action.type === 'toggle')
      result = enableAccount(cliIndex, snapshot.accounts[action.index]?.enabled === 0)
    else if (action.type === 'reset') result = resetAccount(cliIndex)
    else result = removeAccount(cliIndex)
  }
  state.status = result.lines[0] || 'Done.'
  state.screen = 'dashboard'
  state.confirm = undefined
  state.cursor = firstSelectable(buildMainItems(readSnapshot(), state.query))
  return readSnapshot()
}

export async function runKiroAuthTui(): Promise<ActionResult> {
  if (!stdin.isTTY || !stdout.isTTY) return 'quit'
  let snapshot = readSnapshot()
  const state: State = {
    screen: 'dashboard',
    cursor: 1,
    accountCursor: 0,
    query: '',
    status: '',
    renderedLines: 0
  }
  const wasRaw = stdin.isRaw ?? false
  stdout.write(ANSI.hide)
  stdin.setRawMode(true)
  stdin.resume()

  return new Promise((resolve) => {
    const finish = (value: ActionResult) => {
      stdin.off('data', onData)
      stdin.setRawMode(wasRaw)
      stdin.pause()
      stdout.write(ANSI.show)
      resolve(value)
    }
    const toDashboard = () => {
      state.screen = 'dashboard'
      state.confirm = undefined
      state.cursor = firstSelectable(buildMainItems(snapshot, state.query))
    }
    const ask = (confirm: ConfirmAction) => {
      state.confirm = confirm
      state.screen = 'confirm'
    }
    const onDashboardEnter = () => {
      const item = buildMainItems(snapshot, state.query)[state.cursor]
      if (!item) return
      if (item.kind === 'account' && item.accountIndex !== undefined) {
        state.accountCursor = item.accountIndex
        state.cursor = 0
        state.screen = 'account'
        return
      }
      if (item.action === 'add') return finish('add')
      if (item.action === 'import') return ask({ type: 'import' })
      if (item.action === 'refresh') {
        snapshot = readSnapshot()
        state.status = 'Refreshed account state.'
        return
      }
      if (item.action === 'diagnostics') {
        state.screen = 'diagnostics'
        return
      }
    }
    const onAccountEnter = () => {
      const item = accountActions(snapshot.accounts[state.accountCursor]!)[state.cursor]
      if (!item) return
      if (item.id === 'back') return toDashboard()
      if (item.id === 'toggle') return ask({ type: 'toggle', index: state.accountCursor })
      if (item.id === 'switch') return ask({ type: 'switch', index: state.accountCursor })
      if (item.id === 'relogin') return finish('add')
      if (item.id === 'reset') return ask({ type: 'reset', index: state.accountCursor })
      if (item.id === 'delete') return ask({ type: 'delete', index: state.accountCursor })
    }
    const handleKey = (key: string): boolean => {
      if (key === '\x03') {
        finish('quit')
        return false
      }
      if (state.screen === 'search') {
        if (key === '\r' || key === '\n') {
          state.screen = 'dashboard'
          state.confirm = undefined
          state.cursor = firstAccountSelectable(buildMainItems(snapshot, state.query))
        } else if (key === '\x1b' || key.toLowerCase() === 'q') toDashboard()
        else if (key === '\x7f' || key === '\b') state.query = state.query.slice(0, -1)
        else if (/^[\x20-\x7e]$/.test(key)) state.query += key
        render(snapshot, state)
        return true
      }
      if (state.screen === 'confirm') {
        if (key.toLowerCase() === 'y' && state.confirm)
          snapshot = runConfirmed(state.confirm, snapshot, state)
        else if (key.toLowerCase() === 'n' || key.toLowerCase() === 'q' || key === '\x1b')
          toDashboard()
        render(snapshot, state)
        return true
      }
      if (key === '\x1b' || key.toLowerCase() === 'q') {
        if (state.screen === 'dashboard') {
          finish('quit')
          return false
        }
        toDashboard()
        render(snapshot, state)
        return true
      }
      const items =
        state.screen === 'account'
          ? accountActions(snapshot.accounts[state.accountCursor]!)
          : buildMainItems(snapshot, state.query)
      if (key === '\x1b[A' || key.toLowerCase() === 'k')
        state.cursor = moveCursor(items, state.cursor, -1)
      else if (key === '\x1b[B' || key.toLowerCase() === 'j')
        state.cursor = moveCursor(items, state.cursor, 1)
      else if (key === '\r' || key === '\n')
        state.screen === 'account' ? onAccountEnter() : onDashboardEnter()
      else if (key === '?') state.screen = 'help'
      else if (key === '/') {
        state.query = ''
        state.screen = 'search'
      } else if (key.toLowerCase() === 'd' && state.screen === 'account')
        ask({ type: 'delete', index: state.accountCursor })
      else if (key.toLowerCase() === 'd') state.screen = 'diagnostics'
      else if (key.toLowerCase() === 'g') {
        finish('add')
        return false
      } else if (key.toLowerCase() === 'i') ask({ type: 'import' })
      else if (key.toLowerCase() === 's' && state.screen === 'account')
        ask({ type: 'switch', index: state.accountCursor })
      else if (key.toLowerCase() === 'r' && state.screen === 'account') {
        finish('add')
        return false
      } else if (key.toLowerCase() === 'h' && state.screen === 'account')
        ask({ type: 'reset', index: state.accountCursor })
      else if (/^[1-9]$/.test(key)) {
        const index = Number(key) - 1
        if (snapshot.accounts[index]) ask({ type: 'switch', index })
      }
      render(snapshot, state)
      return true
    }
    const onData = (data: Buffer) => {
      try {
        for (const key of decodeKeys(data.toString('utf8'))) {
          if (!handleKey(key)) return
        }
      } catch (error) {
        state.status = friendlyError(error instanceof Error ? error.message : String(error)).join(
          ' '
        )
        toDashboard()
        render(snapshot, state)
      }
    }
    stdin.on('data', onData)
    render(snapshot, state)
  })
}
