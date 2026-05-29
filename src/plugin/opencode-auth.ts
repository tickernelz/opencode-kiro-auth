import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { KIRO_LEGACY_PROVIDER_ID, KIRO_PROVIDER_ID } from '../constants'
import * as logger from './logger'

const PLACEHOLDER_KEY = 'opencode-kiro-auth-placeholder'

function getDataDir(): string {
  const xdgData = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(xdgData, 'opencode')
}

export function getOpenCodeAuthPath(): string {
  return join(getDataDir(), 'auth.json')
}

type ReadAuthResult =
  | { status: 'ok'; data: Record<string, any> }
  | { status: 'missing' }
  | { status: 'unparseable' }

function readAuthFile(): ReadAuthResult {
  const path = getOpenCodeAuthPath()
  if (!existsSync(path)) return { status: 'missing' }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { status: 'ok', data: parsed }
    }
    // Valid JSON but not an object (e.g. an array or scalar). Treat it as
    // unparseable so we never clobber an unexpected file shape.
    return { status: 'unparseable' }
  } catch (error) {
    logger.warn('OpenCode auth file could not be parsed; skipping placeholder auth setup', {
      path,
      error: error instanceof Error ? error.message : String(error)
    })
    return { status: 'unparseable' }
  }
}

function writeAuthFile(data: Record<string, any>): void {
  const path = getOpenCodeAuthPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
}

export function ensureOpenCodeAuthPlaceholder(providerID = KIRO_PROVIDER_ID): void {
  const result = readAuthFile()

  // Never write when the existing file is present but unparseable: doing so
  // would drop other providers' credentials if auth.json is temporarily
  // truncated or corrupt.
  if (result.status === 'unparseable') return

  const data = result.status === 'ok' ? result.data : {}
  let changed = false

  if (providerID === KIRO_PROVIDER_ID && data[KIRO_LEGACY_PROVIDER_ID] && !data[KIRO_PROVIDER_ID]) {
    data[KIRO_PROVIDER_ID] = data[KIRO_LEGACY_PROVIDER_ID]
    changed = true
  }

  if (!data[providerID]) {
    data[providerID] = { type: 'api', key: PLACEHOLDER_KEY }
    changed = true
  }

  if (!changed) return

  try {
    writeAuthFile(data)
    logger.log('OpenCode auth placeholder ensured', { providerID })
  } catch (error) {
    logger.warn('Failed to write OpenCode auth placeholder', {
      providerID,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
