import { Buffer } from 'node:buffer'
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const binaryToBase64Replacer = (_key: string, value: unknown): unknown => {
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64')
  return value
}

const getLogDir = () => {
  const platform = process.platform
  const base =
    platform === 'win32'
      ? join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
      : join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
  return join(base, 'kiro-logs')
}

const writeToFile = (level: string, message: string, ...args: unknown[]) => {
  try {
    const dir = getLogDir()
    mkdirSync(dir, { recursive: true })
    const path = join(dir, 'plugin.log')
    const timestamp = new Date().toISOString()
    const content = `[${timestamp}] ${level}: ${message} ${args
      .map((a) => {
        if (a instanceof Error) {
          return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ''}`
        }
        if (typeof a === 'object') {
          try {
            return JSON.stringify(a)
          } catch {
            return '[Unserializable object]'
          }
        }
        return String(a)
      })
      .join(' ')}\n`
    appendFileSync(path, content)
  } catch (e) {}
}

const writeApiLog = (
  type: 'request' | 'response',
  data: any,
  timestamp: string,
  isError = false
) => {
  try {
    const dir = getLogDir()
    mkdirSync(dir, { recursive: true })
    const prefix = isError ? 'error_' : ''
    const filename = `${prefix}${timestamp}_${type}.json`
    const path = join(dir, filename)
    const content = JSON.stringify(data, binaryToBase64Replacer, 2)
    writeFileSync(path, content)
  } catch (e) {}
}

export function log(message: string, ...args: unknown[]): void {
  writeToFile('INFO', message, ...args)
}

export function error(message: string, ...args: unknown[]): void {
  writeToFile('ERROR', message, ...args)
}

export function warn(message: string, ...args: unknown[]): void {
  writeToFile('WARN', message, ...args)
}

export function debug(message: string, ...args: unknown[]): void {
  if (process.env.DEBUG || process.env.OPENCODE_LOG_LEVEL === 'debug') {
    writeToFile('DEBUG', message, ...args)
  }
}

export function logApiRequest(data: any, timestamp: string): void {
  writeApiLog('request', data, timestamp)
}

export function logApiResponse(data: any, timestamp: string): void {
  writeApiLog('response', data, timestamp)
}

export function logApiError(requestData: any, responseData: any, timestamp: string): void {
  writeApiLog('request', requestData, timestamp, true)
  writeApiLog('response', responseData, timestamp, true)
  const errorType = responseData.status ? `HTTP ${responseData.status}` : 'Network Error'
  const email = requestData.email || 'unknown'
  error(`${errorType} on ${email} - See error_${timestamp}_request.json`)
}

export function getTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
