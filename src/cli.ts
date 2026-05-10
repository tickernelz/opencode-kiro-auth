#!/usr/bin/env node
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { platform } from 'node:os'
import { basename } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { emitKeypressEvents } from 'node:readline'
import {
  addCurrentKiroCliAccount,
  enableAccount,
  listAccounts,
  removeAccount,
  resetAccount,
  runKiroCli,
  switchAccount,
  type CommandResult
} from './cli-service.js'
import { runKiroAuthTui } from './tui.js'

function help(): CommandResult {
  return {
    exitCode: 0,
    lines: [
      'opencode-kiro-auth account manager',
      '',
      'Usage:',
      '  opencode-kiro-auth',
      '  opencode-kiro-auth tui',
      '  opencode-kiro-auth accounts list',
      '  opencode-kiro-auth accounts add [--sync-only] [--manual|--browser] [--yes] [--no-logout]',
      '  opencode-kiro-auth accounts sync',
      '  opencode-kiro-auth accounts switch <index>',
      '  opencode-kiro-auth accounts enable <index>',
      '  opencode-kiro-auth accounts disable <index>',
      '  opencode-kiro-auth accounts reset <index>',
      '  opencode-kiro-auth accounts remove <index>',
      '  opencode-kiro-auth status',
      '',
      'Aliases:',
      '  list, add, sync, switch, enable, disable, reset, remove, status',
      '',
      'Add flow:',
      '  add        saves current Kiro login, opens/copies the real Kiro sign-in flow, then syncs',
      '  sync       only imports the currently active kiro-cli login'
    ]
  }
}

export function runCli(argv: string[] = process.argv.slice(2)): CommandResult {
  const args = argv[0] === 'accounts' ? argv.slice(1) : argv
  const command = args[0] || 'help'
  const index = args[1]

  switch (command) {
    case 'list':
    case 'status':
      return listAccounts()
    case 'sync':
      return addCurrentKiroCliAccount()
    case 'add':
      if (args.includes('--sync-only')) return addCurrentKiroCliAccount()
      return {
        exitCode: 1,
        lines: [
          'Interactive add requires a real terminal. Run `kiro-auth add` directly, or use `kiro-auth sync` after `kiro-cli login`.'
        ]
      }
    case 'switch':
      return switchAccount(index)
    case 'enable':
      return enableAccount(index, true)
    case 'disable':
      return enableAccount(index, false)
    case 'reset':
      return resetAccount(index)
    case 'remove':
    case 'rm':
      return removeAccount(index)
    case 'help':
    case '--help':
    case '-h':
      return help()
    case 'tui':
      return {
        exitCode: 1,
        lines: [
          'The TUI requires an interactive terminal. Run `kiro-auth tui` directly in a TTY, or use `kiro-auth --help` for non-interactive commands.'
        ]
      }
    default:
      return {
        exitCode: 1,
        lines: [`Unknown command: ${command}`, ...help().lines]
      }
  }
}

function shouldSkipLogout(args: string[]): boolean {
  return args.includes('--no-logout') || args.includes('--skip-logout')
}

type LoginMode = 'browser' | 'manual'

function requestedLoginMode(args: string[]): LoginMode | null {
  if (args.includes('--manual')) return 'manual'
  if (args.includes('--browser') || args.includes('--easy')) return 'browser'
  return null
}

function buildLoginArgsFromFlags(args: string[], mode: LoginMode): string[] {
  if (args.includes('--google')) return ['login', '--license', 'free', '--social', 'google']
  if (args.includes('--github')) return ['login', '--license', 'free', '--social', 'github']
  if (args.includes('--idc') || args.includes('--pro')) return ['login', '--license', 'pro']
  if (mode === 'manual') return ['login']
  if (args.includes('--device')) return ['login', '--use-device-flow']
  return ['login']
}

function clearScreen(): void {
  output.write('\x1b[2J\x1b[3J\x1b[H')
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}

function terminalWidth(): number {
  return Math.max(24, Math.min(100, output.columns || 80))
}

function fitTerminal(value: string, width: number): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  if (clean.length <= width) return clean
  if (width <= 1) return clean.slice(0, width)
  return `${clean.slice(0, width - 1)}…`
}

function wrapTerminal(value: string, width: number, indent = ''): string[] {
  const available = Math.max(8, width - indent.length)
  const words = value.replace(/\s+/g, ' ').trim().split(' ')
  const lines: string[] = []
  let line = ''
  for (const word of words) {
    const next = line ? `${line} ${word}` : word
    if (next.length > available && line) {
      lines.push(`${indent}${line}`)
      line = word
    } else {
      line = next
    }
  }
  if (line) lines.push(`${indent}${line}`)
  return lines
}

const CLI_ANSI = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  yellow: '\x1b[33m',
  muted: '\x1b[90m',
  bgGreen: '\x1b[42m',
  black: '\x1b[30m',
  bold: '\x1b[1m'
} as const

function cliPaint(value: string, code: string): string {
  return `${code}${value}${CLI_ANSI.reset}`
}

function cliSelected(value: string, width: number): string {
  return ` ${CLI_ANSI.bgGreen}${CLI_ANSI.black}${CLI_ANSI.bold}${fitTerminal(value, Math.max(8, width - 2))}${CLI_ANSI.reset}`
}
function renderMenuScreen(
  title: string,
  subtitle: string,
  items: Array<{ label: string; hint?: string }>,
  selected: number,
  help: string
): void {
  const width = terminalWidth()
  clearScreen()
  output.write(`${cliPaint('+', CLI_ANSI.green)} ${cliPaint(title, CLI_ANSI.cyan)}\n`)
  for (const line of wrapTerminal(subtitle, width, '  ')) {
    output.write(`${cliPaint(line, CLI_ANSI.muted)}\n`)
  }
  output.write('\n')
  output.write(`  ${cliPaint('Sign in', CLI_ANSI.muted)}\n`)
  for (const [index, item] of items.entries()) {
    const selectedRow = index === selected
    if (selectedRow) {
      output.write(`${cliSelected(`> ${item.label}`, width)}\n`)
      if (item.hint) {
        for (const line of wrapTerminal(item.hint, width, '   ')) {
          output.write(`${cliPaint(line, CLI_ANSI.muted)}\n`)
        }
      }
    } else {
      output.write(
        ` ${cliPaint('o', CLI_ANSI.muted)} ${cliPaint(fitTerminal(item.label, Math.max(8, width - 4)), CLI_ANSI.green)}\n`
      )
    }
  }
  output.write(` ${cliPaint(fitTerminal(help, Math.max(8, width - 2)), CLI_ANSI.muted)}\n`)
  output.write(`${cliPaint('+', CLI_ANSI.green)}\n`)
}

function renderStatusScreen(title: string, lines: string[], help?: string): void {
  const width = terminalWidth()
  clearScreen()
  output.write(`${cliPaint('+', CLI_ANSI.green)} ${cliPaint(title, CLI_ANSI.cyan)}\n`)
  for (const line of lines) {
    for (const wrapped of wrapTerminal(line, width, '  ')) {
      output.write(`${wrapped}\n`)
    }
  }
  if (help)
    output.write(` ${cliPaint(fitTerminal(help, Math.max(8, width - 2)), CLI_ANSI.muted)}\n`)
  output.write(`${cliPaint('+', CLI_ANSI.green)}\n`)
}

async function selectLoginMode(): Promise<LoginMode | null> {
  if (!input.isTTY) return 'browser'
  emitKeypressEvents(input)
  input.setRawMode(true)
  input.resume()
  let selected = 0
  const items = [
    { label: 'Open Browser (Easy)', hint: 'Use normal Kiro CLI browser login.' },
    {
      label: 'Manual / Incognito',
      hint: 'Copy the real Kiro chooser link for another browser/profile.'
    },
    { label: 'Back', hint: 'Return to account manager.' }
  ]
  const draw = () =>
    renderMenuScreen(
      'Kiro Add Account',
      'Choose how to sign in.',
      items,
      selected,
      terminalWidth() < 58
        ? '↑↓ Move | Enter | Q Back'
        : '↑↓ Move | Enter Select | 1 Easy | 2 Manual | Q Back'
    )
  draw()

  return new Promise((resolve) => {
    const cleanup = () => {
      input.off('keypress', onKey)
      input.setRawMode(false)
      output.write('\n')
    }
    const onKey = (str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        cleanup()
        resolve(null)
        return
      }
      if (key.name === 'q' || key.name === 'escape' || str === '0') {
        cleanup()
        resolve(null)
        return
      }
      if (key.name === 'up' || str === 'k')
        selected = selected === 0 ? items.length - 1 : selected - 1
      else if (key.name === 'down' || str === 'j') selected = (selected + 1) % items.length
      else if (str === '1') {
        cleanup()
        resolve('browser')
        return
      } else if (str === '2') {
        cleanup()
        resolve('manual')
        return
      } else if (key.name === 'return') {
        cleanup()
        resolve(selected === 0 ? 'browser' : selected === 1 ? 'manual' : null)
        return
      }
      draw()
    }
    input.on('keypress', onKey)
  })
}

async function confirmScreen(title: string, message: string): Promise<string> {
  if (!input.isTTY) return 'no'
  emitKeypressEvents(input)
  input.setRawMode(true)
  input.resume()
  renderStatusScreen(title, [message], 'Y Confirm | N/Q Back')
  return new Promise((resolve) => {
    const cleanup = () => {
      input.off('keypress', onKey)
      input.setRawMode(false)
      output.write('\n')
    }
    const onKey = (str: string, key: { name?: string; ctrl?: boolean }) => {
      if (key.ctrl && key.name === 'c') {
        cleanup()
        resolve('no')
        return
      }
      const value = str.toLowerCase()
      if (value === 'y') {
        cleanup()
        resolve('yes')
        return
      }
      if (value === 'n' || value === 'q' || key.name === 'escape') {
        cleanup()
        resolve('no')
      }
    }
    input.on('keypress', onKey)
  })
}
function printResult(result: CommandResult): void {
  for (const line of result.lines) console.log(line)
}

function copyToClipboard(value: string): void {
  try {
    if (platform() === 'win32') {
      spawnSync('clip.exe', { input: value, encoding: 'utf8' })
      return
    }
    if (platform() === 'darwin') {
      spawnSync('pbcopy', { input: value, encoding: 'utf8' })
      return
    }
    spawnSync('xclip', ['-selection', 'clipboard'], { input: value, encoding: 'utf8' })
  } catch {
    // Clipboard copy is best effort; the link remains printed by the manager.
  }
}

function spawnKiroCli(args: string[], options: SpawnOptions) {
  if (platform() === 'win32') {
    return spawn('cmd.exe', ['/d', '/s', '/c', ['kiro-cli', ...args].join(' ')], options)
  }
  return spawn('kiro-cli', args, options)
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        reject(new Error('Failed to start local Kiro auth capture server.'))
        return
      }
      resolve(address.port)
    })
  })
}

function formatUrlPreview(value: string): string {
  const match = value.match(
    /^(https:\/\/app\.kiro\.dev\/signin\?state=[^&]+).*(&redirect_from=kirocli)$/
  )
  if (!match) return value.length > 88 ? `${value.slice(0, 84)}...` : value
  return `${match[1]}...${match[2]}`
}

function renderManualLoginScreen(state: {
  command: string
  url?: string
  copied: boolean
  status: string
  lastOutput: string[]
}): void {
  const lines = [`Launching: ${state.command}`]
  if (state.url) {
    lines.push('Kiro chooser link copied to clipboard.')
    lines.push(`Preview: ${formatUrlPreview(state.url)}`)
  } else {
    lines.push('Waiting for Kiro CLI to generate the real Kiro chooser link...')
  }
  lines.push(
    state.copied
      ? 'Open your browser/incognito and paste the copied link.'
      : 'The temporary localhost tab may flicker and close after copying the link.'
  )
  lines.push(state.status)
  const visible = state.lastOutput.filter((line) => !line.includes('Opening auth portal')).slice(-3)
  for (const line of visible) lines.push(`Kiro: ${line}`)
  renderStatusScreen('Manual / Incognito Sign In', lines)
}

function shouldRenderKiroOutput(previous: string[], next: string[], copied: boolean): boolean {
  if (previous.join('\n') === next.join('\n')) return false
  if (!copied) return true
  const meaningful = next.filter(
    (line) => !line.includes('Logging in') && !line.includes('Opening auth portal')
  )
  const previousMeaningful = previous.filter(
    (line) => !line.includes('Logging in') && !line.includes('Opening auth portal')
  )
  return meaningful.join('\n') !== previousMeaningful.join('\n')
}

async function runManualPortalLogin(loginArgs: string[]): Promise<void> {
  let captured = false
  const state: {
    command: string
    url?: string
    copied: boolean
    status: string
    lastOutput: string[]
  } = {
    command: ['kiro-cli', ...loginArgs].join(' '),
    copied: false,
    status:
      'Manual mode copies the real Kiro chooser URL. Open it in incognito, finish sign-in, then return here.',
    lastOutput: []
  }

  const server = createServer((request, response) => {
    const rawUrl = request.url || '/'
    if (!captured && rawUrl.startsWith('/signin?')) {
      captured = true
      state.url = `https://app.kiro.dev${rawUrl}`
      copyToClipboard(state.url)
      state.copied = true
      state.status =
        'Copied the real Kiro chooser link. Continue in the browser/profile you choose.'
      renderManualLoginScreen(state)
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    response.end(`<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Kiro auth link copied</title>
    <style>
      html, body { margin: 0; background: #05070a; color: #e6edf3; font-family: system-ui, sans-serif; }
      body { padding: 24px; }
    </style>
  </head>
  <body>
    <p>Kiro auth link copied. Returning you to the terminal...</p>
    <script>
      window.open('', '_self');
      window.close();
      setTimeout(() => { document.body.textContent = 'Kiro auth link copied. You can close this tab and return to your terminal.'; }, 500);
    </script>
  </body>
</html>`)
  })

  const port = await listen(server)
  const child = spawnKiroCli(loginArgs, {
    stdio: ['inherit', 'pipe', 'pipe'],
    env: { ...process.env, KIRO_AUTH_PORTAL_URL: `http://127.0.0.1:${port}` }
  })
  let buffer = ''
  renderManualLoginScreen(state)

  function inspect(chunk: Buffer): void {
    const text = stripAnsi(chunk.toString('utf8'))
    buffer = (buffer + text).slice(-4096)
    const nextOutput = buffer
      .split(/\r?\n|\r/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-8)
    if (shouldRenderKiroOutput(state.lastOutput, nextOutput, state.copied)) {
      state.lastOutput = nextOutput
      renderManualLoginScreen(state)
    }
  }

  child.stdout?.on('data', inspect)
  child.stderr?.on('data', inspect)

  return new Promise((resolve, reject) => {
    let done = false
    const closeServer = () => {
      try {
        server.close()
      } catch {
        // Ignore shutdown races.
      }
    }
    child.on('error', (error) => {
      if (done) return
      done = true
      closeServer()
      reject(error)
    })
    child.on('close', (code) => {
      if (done) return
      done = true
      closeServer()
      if (code && code !== 0) {
        state.status = `Kiro CLI login exited with code ${code}.`
        renderManualLoginScreen(state)
        reject(new Error(state.status))
        return
      }
      state.status = 'Kiro CLI login completed.'
      renderManualLoginScreen(state)
      resolve()
    })
  })
}
async function guidedAdd(args: string[]): Promise<number> {
  if (args.includes('--sync-only')) {
    printResult(addCurrentKiroCliAccount())
    return 0
  }

  clearScreen()
  console.log('+ Save Current Account\n')
  console.log('Saving currently active Kiro CLI login into the plugin pool first...')
  try {
    printResult(addCurrentKiroCliAccount())
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error))
    console.log('Continuing to Kiro login anyway.')
  }

  const mode = requestedLoginMode(args) || (await selectLoginMode())
  if (!mode) return 1
  const loginArgs = buildLoginArgsFromFlags(args, mode)

  if (!shouldSkipLogout(args)) {
    const answer = args.includes('--yes')
      ? 'yes'
      : await confirmScreen(
          'Confirm Account Change',
          'This will log out the current Kiro CLI session after saving it. Continue?'
        )
    if (answer !== 'y' && answer !== 'yes') return 1

    clearScreen()
    console.log('+ Logout Current Kiro CLI Session\n')
    console.log('Logging out so the next login can use another account...')
    const logout = runKiroCli(['logout'], { stdio: 'inherit' })
    if (logout.error) throw logout.error
  }

  clearScreen()
  console.log('+ Kiro Sign In\n')
  if (mode === 'manual') {
    await runManualPortalLogin(loginArgs)
  } else {
    console.log(`Launching: kiro-cli ${loginArgs.join(' ')}`)
    const login = runKiroCli(loginArgs, { stdio: 'inherit' })
    if (login.error) throw login.error
    if (typeof login.status === 'number' && login.status !== 0) return login.status
  }

  clearScreen()
  console.log('+ Import New Kiro Account\n')
  printResult(addCurrentKiroCliAccount())
  return 0
}

async function runTui(): Promise<'quit' | 'add'> {
  return runKiroAuthTui()
}

if (process.argv[1] && basename(process.argv[1]) === 'cli.js') {
  try {
    const args = process.argv.slice(2)
    const normalized = args[0] === 'accounts' ? args.slice(1) : args
    if (
      (normalized[0] === 'add' || normalized[0] === 'login') &&
      process.stdin.isTTY &&
      process.stdout.isTTY
    ) {
      const code = await guidedAdd(normalized.slice(1))
      process.exit(code)
    }
    if ((args.length === 0 || args[0] === 'tui') && process.stdin.isTTY && process.stdout.isTTY) {
      const action = await runTui()
      if (input.isTTY) input.setRawMode(false)
      input.resume()
      if (action === 'add') {
        const code = await guidedAdd([])
        process.exit(code)
      }
      process.exit(0)
    }
    if (args.length === 0 && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      const result = help()
      printResult(result)
      process.exit(result.exitCode)
    }
    const result = runCli()
    printResult(result)
    process.exit(result.exitCode)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
