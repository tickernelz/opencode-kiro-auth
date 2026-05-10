#!/usr/bin/env node
import { render } from 'ink'
import { basename } from 'node:path'
import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline'
import { createElement } from 'react'
import {
  type CommandResult,
  addCurrentKiroCliAccount,
  enableAccount,
  listAccounts,
  removeAccount,
  resetAccount,
  runKiroCli,
  switchAccount
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
      '  opencode-kiro-auth accounts add [--sync-only] [--no-logout]',
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

function buildLoginArgsFromFlags(args: string[]): string[] {
  if (args.includes('--google')) return ['login', '--license', 'free', '--social', 'google']
  if (args.includes('--github')) return ['login', '--license', 'free', '--social', 'github']
  if (args.includes('--device')) return ['login', '--license', 'free', '--use-device-flow']
  if (args.includes('--idc') || args.includes('--pro')) return ['login', '--license', 'pro']
  return ['login']
}

function printResult(result: CommandResult): void {
  for (const line of result.lines) console.log(line)
}

async function guidedAdd(args: string[]): Promise<number> {
  if (args.includes('--sync-only')) {
    printResult(addCurrentKiroCliAccount())
    return 0
  }

  console.log('Saving currently active Kiro CLI login into the plugin pool first...')
  try {
    printResult(addCurrentKiroCliAccount())
  } catch (error) {
    console.log(error instanceof Error ? error.message : String(error))
    console.log('Continuing to Kiro login anyway.')
  }

  const loginArgs = buildLoginArgsFromFlags(args)

  if (!shouldSkipLogout(args)) {
    if (!args.includes('--yes')) {
      const answer = (
        await askQuestion(
          'This will log out the current Kiro CLI session after saving it. Continue? [y/N]: '
        )
      )
        .trim()
        .toLowerCase()
      if (answer !== 'y' && answer !== 'yes') return 1
    }

    console.log(
      '\nLogging out of the current Kiro CLI session so the next login can use another account...'
    )
    const logout = runKiroCli(['logout'], { stdio: 'inherit' })
    if (logout.error) throw logout.error
  }

  console.log(`\nLaunching: kiro-cli ${loginArgs.join(' ')}`)
  const login = runKiroCli(loginArgs, { stdio: 'inherit' })
  if (login.error) throw login.error
  if (typeof login.status === 'number' && login.status !== 0) return login.status

  console.log('\nImporting the newly active Kiro CLI login into the plugin pool...')
  printResult(addCurrentKiroCliAccount())
  return 0
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
