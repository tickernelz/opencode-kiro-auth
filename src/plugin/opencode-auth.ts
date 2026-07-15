import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import lockfile from 'proper-lockfile'
import { KIRO_LEGACY_PROVIDER_ID, KIRO_PROVIDER_ID } from '../constants'
import * as logger from './logger'

const PLACEHOLDER_KEY = 'opencode-kiro-auth-placeholder'
const LOCK_RETRY_MS = 25
const LOCK_TIMEOUT_MS = 5000
const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4))

function getDataDir(): string {
  const dataRoot =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      : process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share')
  return join(dataRoot, 'opencode')
}

export function getOpenCodeAuthPath(): string {
  return join(getDataDir(), 'auth.json')
}

type ReadAuthResult =
  | { status: 'ok'; data: Record<string, any> }
  | { status: 'missing' }
  | { status: 'unparseable'; error?: string }

function readAuthFile(path: string): ReadAuthResult {
  if (!existsSync(path)) return { status: 'missing' }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { status: 'ok', data: parsed }
    }
    // Valid JSON but not an object (e.g. an array or scalar). Treat it as
    // unparseable so we never clobber an unexpected file shape.
    return { status: 'unparseable', error: 'auth.json is not an object' }
  } catch (error) {
    return {
      status: 'unparseable',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function withInterprocessFileLock<T>(path: string, operation: () => T): T {
  mkdirSync(dirname(path), { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  let release: (() => void) | undefined

  while (!release) {
    try {
      release = lockfile.lockSync(path, { realpath: false, stale: 10000 })
    } catch (error) {
      if (
        !(error && typeof error === 'object' && 'code' in error && error.code === 'ELOCKED') ||
        Date.now() >= deadline
      ) {
        throw error
      }
      Atomics.wait(lockWaitBuffer, 0, 0, LOCK_RETRY_MS)
    }
  }

  try {
    return operation()
  } finally {
    release()
  }
}

export function atomicWritePrivateJsonFile(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`
  try {
    writeFileSync(tempPath, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 })
    if (process.platform !== 'win32') chmodSync(tempPath, 0o600)
    renameSync(tempPath, path)
  } finally {
    rmSync(tempPath, { force: true })
  }
}

export type OpenCodeAuthUpdateResult =
  { status: 'updated' } | { status: 'unchanged' } | { status: 'unparseable'; error?: string }

export function updateOpenCodeAuthPlaceholder(
  providerID: string,
  placeholderKey: string
): OpenCodeAuthUpdateResult {
  const path = getOpenCodeAuthPath()
  return withInterprocessFileLock(path, () => {
    // Read only after acquiring the lock so concurrent provider updates are merged.
    const result = readAuthFile(path)
    if (result.status === 'unparseable') return result

    const data = result.status === 'ok' ? result.data : {}
    let changed = false

    if (
      providerID === KIRO_PROVIDER_ID &&
      data[KIRO_LEGACY_PROVIDER_ID] &&
      !data[KIRO_PROVIDER_ID]
    ) {
      data[KIRO_PROVIDER_ID] = data[KIRO_LEGACY_PROVIDER_ID]
      changed = true
    }

    if (!data[providerID]) {
      data[providerID] = { type: 'api', key: placeholderKey }
      changed = true
    }

    if (!changed) {
      if (process.platform !== 'win32' && result.status === 'ok') chmodSync(path, 0o600)
      return { status: 'unchanged' }
    }

    atomicWritePrivateJsonFile(path, data)
    return { status: 'updated' }
  })
}

export function ensureOpenCodeAuthPlaceholder(providerID = KIRO_PROVIDER_ID): void {
  try {
    const result = updateOpenCodeAuthPlaceholder(providerID, PLACEHOLDER_KEY)
    if (result.status === 'unparseable') {
      logger.warn('OpenCode auth file could not be parsed; skipping placeholder auth setup', {
        path: getOpenCodeAuthPath(),
        error: result.error
      })
    } else if (result.status === 'updated') {
      logger.log('OpenCode auth placeholder ensured', { providerID })
    }
  } catch (error) {
    logger.warn('Failed to write OpenCode auth placeholder', {
      providerID,
      error: error instanceof Error ? error.message : String(error)
    })
  }
}
