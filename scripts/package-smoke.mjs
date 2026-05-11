#!/usr/bin/env node
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'

const root = process.cwd()
const smokeRoot = mkdtempSync(join(tmpdir(), 'opencode-kiro-auth-pack-smoke-'))
const packDir = join(smokeRoot, 'pack')
const installDir = join(smokeRoot, 'install')
const homeDir = join(smokeRoot, 'home')
const appDataDir = join(smokeRoot, 'appdata')
const kiroCliDbPath = join(smokeRoot, 'missing-kiro-cli.sqlite3')
const npmCommand = process.env.npm_execpath
  ? process.execPath
  : process.platform === 'win32'
    ? 'npm.cmd'
    : 'npm'
const npmPrefixArgs = process.env.npm_execpath ? [process.env.npm_execpath] : []

mkdirSync(packDir, { recursive: true })
mkdirSync(installDir, { recursive: true })
mkdirSync(homeDir, { recursive: true })
mkdirSync(appDataDir, { recursive: true })

function run(command, args, options = {}) {
  const isWindowsCmd = process.platform === 'win32' && command.endsWith('.cmd')
  const file = isWindowsCmd ? 'cmd.exe' : command
  const fileArgs = isWindowsCmd ? ['/d', '/c', 'call', command, ...args] : args

  return execFileSync(file, fileArgs, {
    cwd: options.cwd || root,
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    env: {
      ...process.env,
      HOME: homeDir,
      USERPROFILE: homeDir,
      APPDATA: appDataDir,
      XDG_CONFIG_HOME: join(smokeRoot, 'xdg-config'),
      KIROCLI_DB_PATH: kiroCliDbPath,
      npm_config_update_notifier: 'false',
      npm_config_fund: 'false',
      npm_config_audit: 'false',
      ...options.env
    }
  })
}

function binPath(name) {
  return join(
    installDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? `${name}.cmd` : name
  )
}

function assertIncludes(output, expected, label) {
  if (!output.includes(expected)) {
    throw new Error(`${label} did not include ${JSON.stringify(expected)}. Output:\n${output}`)
  }
}

function runNpm(args, options = {}) {
  return run(npmCommand, [...npmPrefixArgs, ...args], options)
}

try {
  runNpm(['pack', '--pack-destination', packDir])
  const tarball = join(
    packDir,
    run('node', [
      '-e',
      "console.log(require('fs').readdirSync(process.argv[1]).find((name) => name.endsWith('.tgz')))",
      packDir
    ]).trim()
  )
  if (!existsSync(tarball)) throw new Error(`npm pack did not create a tarball in ${packDir}`)

  runNpm(['init', '-y'], { cwd: installDir })
  runNpm(['install', tarball, '--ignore-scripts'], { cwd: installDir })

  const helpOutput = run(binPath('kiro-auth'), ['--help'], { cwd: installDir })
  assertIncludes(helpOutput, 'opencode-kiro-auth account manager', 'kiro-auth --help')

  const listOutput = run(binPath('opencode-kiro-auth'), ['list'], { cwd: installDir })
  assertIncludes(listOutput, 'No Kiro accounts found', 'opencode-kiro-auth list')

  console.log(`package smoke passed: ${basename(tarball)}`)
} finally {
  if (!process.env.KEEP_PACKAGE_SMOKE) rmSync(smokeRoot, { recursive: true, force: true })
}
