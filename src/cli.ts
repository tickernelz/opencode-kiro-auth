#!/usr/bin/env node
import { render } from 'ink'
import { basename } from 'node:path'
import { createElement } from 'react'
import {
  type CommandResult,
  addCurrentKiroCliAccount,
  enableAccount,
  listAccounts,
  removeAccount,
  resetAccount,
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
      '  opencode-kiro-auth accounts add',
      '  opencode-kiro-auth accounts switch <index>',
      '  opencode-kiro-auth accounts enable <index>',
      '  opencode-kiro-auth accounts disable <index>',
      '  opencode-kiro-auth accounts reset <index>',
      '  opencode-kiro-auth accounts remove <index>',
      '  opencode-kiro-auth status',
      '',
      'Aliases:',
      '  list, add, switch, enable, disable, reset, remove, status'
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
    case 'add':
    case 'sync':
      return addCurrentKiroCliAccount()
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

async function runTui(): Promise<void> {
  const instance = render(createElement(KiroAuthTui))
  await instance.waitUntilExit()
}

if (process.argv[1] && basename(process.argv[1]) === 'cli.js') {
  try {
    const args = process.argv.slice(2)
    if ((args.length === 0 || args[0] === 'tui') && process.stdin.isTTY && process.stdout.isTTY) {
      await runTui()
      process.exit(0)
    }
    if (args.length === 0 && (!process.stdin.isTTY || !process.stdout.isTTY)) {
      const result = help()
      for (const line of result.lines) console.log(line)
      process.exit(result.exitCode)
    }
    const result = runCli()
    for (const line of result.lines) console.log(line)
    process.exit(result.exitCode)
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
