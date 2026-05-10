#!/usr/bin/env node
import { render } from 'ink'
import { spawn, spawnSync, type SpawnOptions } from 'node:child_process'
import { platform } from 'node:os'
import { basename } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { createInterface, emitKeypressEvents } from 'node:readline'
import { createElement } from 'react'
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
import { KiroAuthTui } from './tui.js'

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
      '  opencode-kiro-auth accounts add [--sync-only] [--manual] [--no-logout]',
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
      '  add        saves current Kiro login, opens the real Kiro sign-in flow, then syncs',
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
      return { exitCode: 0, lines: [] }
    default:
      return {
        exitCode: 1,
        lines: [`Unknown command: ${command}`, ...help().lines]
      }
  }
}

function askQuestion(prompt: string): Promise<string> {
  if (input.isTTY) input.setRawMode(false)
  input.resume()
  const rl = createInterface({ input, output, terminal: true })
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close()
      resolve(answer)
    })
  })
}

function shouldSkipLogout(args: string[]): boolean {
  return args.includes('--no-logout') || args.includes('--skip-logout')
}

function buildLoginArgsFromFlags(args: string[], mode: LoginMode): string[] {
  if (args.includes('--google')) return ['login', '--license', 'free', '--social', 'google']
  if (args.includes('--github')) return ['login', '--license', 'free', '--social', 'github']
  if (args.includes('--idc') || args.includes('--pro')) return ['login', '--license', 'pro']
  if (args.includes('--device') || args.includes('--manual') || mode === 'manual') {
    return ['login', '--use-device-flow']
  }
  return ['login']
}

type LoginMode = 'browser' | 'manual'

function clearScreen(): void {
  output.write('\x1b[2J\x1b[3J\x1b[H')
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
}

function renderLoginModeMenu(selected: number): void {
  const options = ['Open Browser (Easy)', 'Manual / Incognito']
  clearScreen()
  output.write('+ Get Started\n')
  output.write('  Choose how you want to continue.\n\n')
  output.write('  Sign in\n')
  for (let index = 0; index < options.length; index += 1) {
    const prefix = index === selected ? '> ' : '  '
    output.write(`${prefix}${options[index]}\n`)
  }
  output.write('\n  0 Back\n\n')
  output.write('  ↑↓ Move | Enter Select | 1 Easy | 2 Manual | Q Back\n')
  output.write('+ ')
}

async function selectLoginMode(): Promise<LoginMode | null> {
  if (!input.isTTY) return 'browser'
  emitKeypressEvents(input)
  input.setRawMode(true)
  input.resume()
  let selected = 0
  renderLoginModeMenu(selected)

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
      if (key.name === 'up' || str === 'k') selected = selected === 0 ? 1 : 0
      else if (key.name === 'down' || str === 'j') selected = selected === 1 ? 0 : 1
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
        resolve(selected === 0 ? 'browser' : 'manual')
        return
      }
      renderLoginModeMenu(selected)
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
    // Clipboard copy is best effort; the link remains printed by Kiro CLI.
  }
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

  const mode = await selectLoginMode()
  if (!mode) return 1
  const loginArgs = buildLoginArgsFromFlags(args, mode)

  if (!shouldSkipLogout(args)) {
    clearScreen()
    console.log('+ Confirm Account Change\n')
    const answer = args.includes('--yes')
      ? 'yes'
      : (
          await askQuestion(
            'This will log out the current Kiro CLI session after saving it. Continue? [y/N]: '
          )
        )
          .trim()
          .toLowerCase()
    if (answer !== 'y' && answer !== 'yes') return 1

    clearScreen()
    console.log('+ Logout Current Kiro CLI Session\n')
    console.log('Logging out so the next login can use another account...')
    const logout = runKiroCli(['logout'], { stdio: 'inherit' })
    if (logout.error) throw logout.error
  }

  clearScreen()
  console.log('+ Kiro Sign In\n')
  console.log(`Launching: kiro-cli ${loginArgs.join(' ')}`)
  if (mode === 'manual') {
    const code = await runManualLogin(loginArgs)
    if (code !== 0) return code
  } else {
    const login = runKiroCli(loginArgs, { stdio: 'inherit' })
    if (login.error) throw login.error
    if (typeof login.status === 'number' && login.status !== 0) return login.status
  }

  clearScreen()
  console.log('+ Import New Kiro Account\n')
  printResult(addCurrentKiroCliAccount())
  return 0
}

function makeManualDeviceUrl(code: string): string {
  return `https://app.kiro.dev/account/device?user_code=${encodeURIComponent(code)}&login_provider=Google`
}

function renderManualLoginScreen(state: {
  command: string
  url?: string
  code?: string
  copied: 'none' | 'url' | 'code'
  status: string
  lastOutput: string[]
}): void {
  clearScreen()
  console.log('+ Manual / Incognito Sign In\n')
  console.log(`Launching: ${state.command}`)
  console.log('Browser auto-open is suppressed by the manager as much as Kiro CLI allows.')
  console.log('')
  if (state.url) console.log(`Go to: ${state.url}`)
  if (state.code) console.log(`Code: ${state.code}`)
  if (state.copied === 'url') console.log('Copied login link to clipboard.')
  else if (state.copied === 'code') console.log('Copied login code to clipboard.')
  else console.log('Waiting for Kiro CLI to print the login URL/code...')
  console.log('')
  console.log(state.status)
  if (state.lastOutput.length) {
    console.log('\nKiro output:')
    for (const line of state.lastOutput.slice(-5)) console.log(`  ${line}`)
  }
}

function manualLoginSpawnOptions(): SpawnOptions {
  const env = {
    ...process.env,
    BROWSER: platform() === 'win32' ? 'cmd /c exit 0' : 'true',
    KIRO_DISABLE_BROWSER: '1',
    NO_BROWSER: '1'
  }
  return { stdio: ['inherit', 'pipe', 'pipe'], env }
}

function runManualLogin(loginArgs: string[]): Promise<number> {
  const command = platform() === 'win32' ? 'cmd.exe' : 'kiro-cli'
  const args =
    platform() === 'win32' ? ['/d', '/s', '/c', ['kiro-cli', ...loginArgs].join(' ')] : loginArgs
  const child = spawn(command, args, manualLoginSpawnOptions())
  const state: {
    command: string
    url?: string
    code?: string
    copied: 'none' | 'url' | 'code'
    status: string
    lastOutput: string[]
  } = {
    command: ['kiro-cli', ...loginArgs].join(' '),
    copied: 'none',
    status: 'Waiting for authorization...',
    lastOutput: []
  }
  let buffer = ''
  renderManualLoginScreen(state)

  function inspect(chunk: Buffer): void {
    const text = stripAnsi(chunk.toString('utf8'))
    buffer = (buffer + text).slice(-4096)
    state.lastOutput = buffer
      .split(/\r?\n|\r/)
      .map((line) => line.trim())
      .filter(Boolean)
      .slice(-8)

    const url = buffer.match(new RegExp('https://app\\.kiro\\.dev/account/device\\?[^\\s]+'))?.[0]
    const code = buffer.match(/(?:confirm the code:|code:)\s*([A-Z0-9-]+)/i)?.[1]
    if (url) state.url = url
    if (code) state.code = code
    if (!state.url && state.code) state.url = makeManualDeviceUrl(state.code)

    if (state.url && state.copied !== 'url') {
      copyToClipboard(state.url)
      state.copied = 'url'
    } else if (state.code && state.copied === 'none') {
      copyToClipboard(state.code)
      state.copied = 'code'
    }
    renderManualLoginScreen(state)
  }

  child.stdout?.on('data', inspect)
  child.stderr?.on('data', inspect)
  return new Promise((resolve, reject) => {
    child.on('error', reject)
    child.on('close', (code) => {
      state.status =
        code === 0 ? 'Authorization complete.' : `Kiro login exited with code ${code ?? 0}.`
      renderManualLoginScreen(state)
      resolve(code ?? 0)
    })
  })
}

async function runTui(): Promise<'quit' | 'add'> {
  let requested: 'quit' | 'add' = 'quit'
  const instance = render(
    createElement(KiroAuthTui as never, {
      onRequestGuidedAdd: () => {
        requested = 'add'
        instance.unmount()
      }
    })
  )
  await instance.waitUntilExit()
  return requested
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
        console.log('Run `kiro-auth add` from the terminal to start the guided add-account flow.')
        console.log('Use `kiro-auth sync` after completing any manual `kiro-cli login`.')
        process.exit(0)
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
