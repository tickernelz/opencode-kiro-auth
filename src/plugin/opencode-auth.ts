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

function readAuthFile(): Record<string, any> {
  const path = getOpenCodeAuthPath()
  if (!existsSync(path)) return {}
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch (error) {
    logger.warn('OpenCode auth file could not be parsed; skipping placeholder auth setup', {
      path,
      error: error instanceof Error ? error.message : String(error)
    })
    return {}
  }
}

function writeAuthFile(data: Record<string, any>): void {
  const path = getOpenCodeAuthPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
}

export function ensureOpenCodeAuthPlaceholder(providerID = KIRO_PROVIDER_ID): void {
  const data = readAuthFile()
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
