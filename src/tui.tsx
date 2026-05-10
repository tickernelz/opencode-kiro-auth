import { Box, Text, useApp, useInput, useStdout } from 'ink'
import React, { useEffect, useMemo, useState } from 'react'
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
  statusFor,
  switchAccount
} from './cli-service.js'

type Mode = 'main' | 'actions' | 'confirm-remove' | 'help'

type Action =
  | { label: string; kind: 'guided-add' }
  | { label: string; kind: 'sync'; run: () => CommandResult }
  | { label: string; kind: 'account'; run: (index: number) => CommandResult }

const actions: Action[] = [
  { label: 'Guided add account', kind: 'guided-add' },
  { label: 'Sync current Kiro login', kind: 'sync', run: addCurrentKiroCliAccount },
  { label: 'Switch account', kind: 'account', run: (index) => switchAccount(String(index + 1)) },
  {
    label: 'Enable account',
    kind: 'account',
    run: (index) => enableAccount(String(index + 1), true)
  },
  {
    label: 'Disable account',
    kind: 'account',
    run: (index) => enableAccount(String(index + 1), false)
  },
  { label: 'Reset health', kind: 'account', run: (index) => resetAccount(String(index + 1)) },
  { label: 'Remove account', kind: 'account', run: (index) => removeAccount(String(index + 1)) }
]

function usage(account: AccountRow): string {
  const used = account.used_count ?? 0
  const limit = account.limit_count ?? 0
  return limit > 0 ? `${used}/${limit}` : `${used}`
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value.padEnd(width)
  if (width <= 1) return value.slice(0, width)
  return `${value.slice(0, Math.max(0, width - 3))}...`
}

function statusColor(status: string): 'green' | 'yellow' | 'red' | 'gray' {
  if (status === 'healthy') return 'green'
  if (status === 'rate-limited') return 'yellow'
  if (status === 'disabled') return 'gray'
  return 'red'
}

function AccountRowView(props: {
  account: AccountRow
  index: number
  selected: boolean
  width: number
}): React.ReactElement {
  const { account, index, selected, width } = props
  const status = statusFor(account)
  const emailWidth = Math.max(12, Math.min(26, width - 40))
  const shortStatus = status === 'rate-limited' ? 'limited' : status
  const line = `${String(index + 1).padStart(2, ' ')} ${truncate(account.email, emailWidth)} ${shortStatus.slice(0, 7).padEnd(7)} ${usage(account).padEnd(9)} ${account.region.slice(0, 9).padEnd(9)} ${formatWait(account.rate_limit_reset).slice(0, 7)}`
  return (
    <Text inverse={selected} color={selected ? 'cyan' : statusColor(status)}>
      {line}
    </Text>
  )
}

function ResultPane(props: { result: string[]; error: string | null }): React.ReactElement {
  if (props.error) return <Text color="red">{props.error}</Text>
  if (props.result.length === 0) return <Text color="gray">Ready.</Text>
  return (
    <Box flexDirection="column">
      {props.result.slice(0, 4).map((line) => (
        <Text key={line} color="green">
          {line}
        </Text>
      ))}
    </Box>
  )
}

export function KiroAuthTui(props: { onRequestGuidedAdd?: () => void } = {}): React.ReactElement {
  const { exit } = useApp()
  const { stdout } = useStdout()
  const terminalWidth = stdout.columns || 100
  const contentWidth = Math.max(58, Math.min(96, terminalWidth - 14))
  const [accounts, setAccounts] = useState<AccountRow[]>(() => readAccounts())
  const [selected, setSelected] = useState(0)
  const [mode, setMode] = useState<Mode>('main')
  const [actionIndex, setActionIndex] = useState(0)
  const [result, setResult] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [cliEmail, setCliEmail] = useState<string | undefined>(() => readKiroCliEmail())

  const account = accounts[selected]
  const canSelect = accounts.length > 0

  function reload(): void {
    const next = readAccounts()
    setAccounts(next)
    setSelected((current) => clamp(current, 0, Math.max(0, next.length - 1)))
    setCliEmail(readKiroCliEmail())
  }

  function runSafely(fn: () => CommandResult): void {
    try {
      setError(null)
      const response = fn()
      setResult(response.lines)
      reload()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }

  function runAction(action: Action): void {
    if (action.kind === 'guided-add') {
      props.onRequestGuidedAdd?.()
      return
    }
    if (action.kind === 'sync') {
      runSafely(action.run)
      setMode('main')
      return
    }
    if (!canSelect) return
    runSafely(() => action.run(selected))
    setMode('main')
  }

  function runAccountAction(actionIndex: number): void {
    const action = actions[actionIndex]
    if (!action) return
    runAction(action)
  }

  useEffect(() => {
    setSelected((current) => clamp(current, 0, Math.max(0, accounts.length - 1)))
  }, [accounts.length])

  useInput((input, key) => {
    if (key.ctrl && input === 'c') exit()
    if (input === 'q') exit()
    if (input === '?') {
      setMode(mode === 'help' ? 'main' : 'help')
      return
    }
    if (input === 'f') {
      setResult(['Refreshed account table.'])
      reload()
      return
    }
    if (mode === 'help') {
      if (key.escape || key.return || input === ' ') setMode('main')
      return
    }
    if (mode === 'confirm-remove') {
      if (input === 'y' && canSelect) {
        runAccountAction(6)
        return
      }
      if (input === 'n' || key.escape) setMode('main')
      return
    }
    if (mode === 'actions') {
      if (key.upArrow || input === 'k')
        setActionIndex((value) => clamp(value - 1, 0, actions.length - 1))
      else if (key.downArrow || input === 'j')
        setActionIndex((value) => clamp(value + 1, 0, actions.length - 1))
      else if (key.escape) setMode('main')
      else if (key.return) {
        if (actionIndex === 6) setMode('confirm-remove')
        else runAccountAction(actionIndex)
      }
      return
    }
    if (key.upArrow || input === 'k')
      setSelected((value) => clamp(value - 1, 0, Math.max(0, accounts.length - 1)))
    else if (key.downArrow || input === 'j')
      setSelected((value) => clamp(value + 1, 0, Math.max(0, accounts.length - 1)))
    else if (key.return) setMode('actions')
    else if (input === 'a') runAccountAction(0)
    else if (input === 'y') runAccountAction(1)
    else if (input === 's' && canSelect) runAccountAction(2)
    else if (input === 'e' && canSelect) runAccountAction(account?.enabled === 0 ? 3 : 4)
    else if (input === 'r' && canSelect) runAccountAction(5)
    else if (input === 'x' && canSelect) setMode('confirm-remove')
  })

  const detailLines = useMemo(() => {
    if (!account) return ['No account selected.']
    return [
      `Email: ${account.email}`,
      `Status: ${statusFor(account)} | Usage: ${usage(account)} | Method: ${account.auth_method}`,
      `Region: ${account.region} | Reset: ${formatWait(account.rate_limit_reset)}`,
      `Last used: ${formatDate(account.last_used)}`,
      `ID: ${account.id.slice(0, 12)}...${account.id.slice(-8)}`
    ]
  }, [account])

  return (
    <Box flexDirection="column" paddingX={1} width={contentWidth}>
      <Box borderStyle="round" borderColor="cyan" paddingX={1} flexDirection="column">
        <Text bold color="cyan">
          Kiro Auth Manager
        </Text>
        <Text color="gray">Pool: {getPluginDbPath()}</Text>
        <Text color="gray">Kiro CLI: {cliEmail || 'not detected'}</Text>
        <Text color="gray">CLI DB: {getKiroCliDbPath()}</Text>
      </Box>

      <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} marginTop={1}>
        <Text bold>Accounts</Text>
        <Text color="gray"># email status usage region reset</Text>
        {accounts.length === 0 ? (
          <Text color="yellow">No accounts. Press a to launch guided Kiro login.</Text>
        ) : (
          accounts.map((item, index) => (
            <AccountRowView
              key={item.id}
              account={item}
              index={index}
              selected={index === selected}
              width={contentWidth - 6}
            />
          ))
        )}
      </Box>

      <Box
        flexDirection="column"
        borderStyle="round"
        borderColor="magenta"
        paddingX={1}
        marginTop={1}
      >
        <Text bold>Details</Text>
        {detailLines.map((line) => (
          <Text key={line}>{line}</Text>
        ))}
        <Box marginTop={1} flexDirection="column">
          <Text bold>Result</Text>
          <ResultPane result={result} error={error} />
        </Box>
      </Box>

      {mode === 'actions' && (
        <Box
          borderStyle="round"
          borderColor="yellow"
          paddingX={1}
          flexDirection="column"
          marginTop={1}
        >
          <Text bold>Action menu</Text>
          {actions.map((action, index) => (
            <Text
              key={action.label}
              inverse={index === actionIndex}
            >{`${index === actionIndex ? '>' : ' '} ${action.label}`}</Text>
          ))}
        </Box>
      )}

      {mode === 'confirm-remove' && (
        <Box borderStyle="round" borderColor="red" paddingX={1} marginTop={1}>
          <Text color="red">Remove {account?.email}? Press y to confirm, n/esc to cancel.</Text>
        </Box>
      )}

      {mode === 'help' && (
        <Box
          borderStyle="round"
          borderColor="green"
          paddingX={1}
          flexDirection="column"
          marginTop={1}
        >
          <Text bold>Help</Text>
          <Text>
            arrows/j/k move | enter action menu | a guided add | y sync | s switch | e toggle
          </Text>
          <Text>r reset | x remove | f refresh | ? help | q quit</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text color="gray">
          arrows/j/k move | enter actions | a add | y sync | s switch | e toggle | r reset | x
          remove | f refresh | ? help | q quit
        </Text>
      </Box>
    </Box>
  )
}
