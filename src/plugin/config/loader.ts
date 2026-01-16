import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { homedir } from 'node:os'
import {
  AccountSelectionStrategySchema,
  KiroConfigSchema,
  RegionSchema,
  DEFAULT_CONFIG,
  type KiroConfig
} from './schema'
import * as logger from '../logger'

function getConfigDir(): string {
  const platform = process.platform
  if (platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
  return join(xdgConfig, 'opencode')
}

export function getUserConfigPath(): string {
  return join(getConfigDir(), 'kiro.json')
}

function ensureUserConfigTemplate(): void {
  const path = getUserConfigPath()
  if (!existsSync(path)) {
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf-8')
      logger.log(`Created default config template at ${path}`)
    } catch (error) {
      logger.warn(`Failed to create config template at ${path}: ${String(error)}`)
    }
  }
}

export function getProjectConfigPath(directory: string): string {
  return join(directory, '.opencode', 'kiro.json')
}

function loadConfigFile(path: string): Partial<KiroConfig> | null {
  try {
    if (!existsSync(path)) {
      return null
    }

    const content = readFileSync(path, 'utf-8')
    const rawConfig = JSON.parse(content)

    const result = KiroConfigSchema.partial().safeParse(rawConfig)

    if (!result.success) {
      const issues = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join(', ')
      logger.warn(`Config validation error at ${path}: ${issues}`)
      return null
    }

    return result.data
  } catch (error) {
    if (error instanceof SyntaxError) {
      logger.warn(`Invalid JSON in config file ${path}: ${error.message}`)
    } else {
      logger.warn(`Failed to load config file ${path}: ${String(error)}`)
    }
    return null
  }
}

function mergeConfigs(base: KiroConfig, override: Partial<KiroConfig>): KiroConfig {
  return {
    ...base,
    ...override
  }
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback
  }
  if (value === '1' || value === 'true') {
    return true
  }
  if (value === '0' || value === 'false') {
    return false
  }
  return fallback
}

function parseNumberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback
  }
  const parsed = Number(value)
  if (isNaN(parsed)) {
    return fallback
  }
  return parsed
}

function applyEnvOverrides(config: KiroConfig): KiroConfig {
  const env = process.env

  return {
    ...config,

    account_selection_strategy: env.KIRO_ACCOUNT_SELECTION_STRATEGY
      ? AccountSelectionStrategySchema.catch('lowest-usage').parse(
          env.KIRO_ACCOUNT_SELECTION_STRATEGY
        )
      : config.account_selection_strategy,

    default_region: env.KIRO_DEFAULT_REGION
      ? RegionSchema.catch('us-east-1').parse(env.KIRO_DEFAULT_REGION)
      : config.default_region,

    rate_limit_retry_delay_ms: parseNumberEnv(
      env.KIRO_RATE_LIMIT_RETRY_DELAY_MS,
      config.rate_limit_retry_delay_ms
    ),

    rate_limit_max_retries: parseNumberEnv(
      env.KIRO_RATE_LIMIT_MAX_RETRIES,
      config.rate_limit_max_retries
    ),

    max_request_iterations: parseNumberEnv(
      env.KIRO_MAX_REQUEST_ITERATIONS,
      config.max_request_iterations
    ),

    request_timeout_ms: parseNumberEnv(env.KIRO_REQUEST_TIMEOUT_MS, config.request_timeout_ms),

    token_expiry_buffer_ms: parseNumberEnv(
      env.KIRO_TOKEN_EXPIRY_BUFFER_MS,
      config.token_expiry_buffer_ms
    ),

    usage_sync_max_retries: parseNumberEnv(
      env.KIRO_USAGE_SYNC_MAX_RETRIES,
      config.usage_sync_max_retries
    ),

    auth_server_port_start: parseNumberEnv(
      env.KIRO_AUTH_SERVER_PORT_START,
      config.auth_server_port_start
    ),

    auth_server_port_range: parseNumberEnv(
      env.KIRO_AUTH_SERVER_PORT_RANGE,
      config.auth_server_port_range
    ),

    usage_tracking_enabled: parseBooleanEnv(
      env.KIRO_USAGE_TRACKING_ENABLED,
      config.usage_tracking_enabled
    ),

    enable_log_api_request: parseBooleanEnv(
      env.KIRO_ENABLE_LOG_API_REQUEST,
      config.enable_log_api_request
    )
  }
}

export function loadConfig(directory: string): KiroConfig {
  ensureUserConfigTemplate()
  let config: KiroConfig = { ...DEFAULT_CONFIG }

  const userConfigPath = getUserConfigPath()
  const userConfig = loadConfigFile(userConfigPath)
  if (userConfig) {
    config = mergeConfigs(config, userConfig)
  }

  const projectConfigPath = getProjectConfigPath(directory)
  const projectConfig = loadConfigFile(projectConfigPath)
  if (projectConfig) {
    config = mergeConfigs(config, projectConfig)
  }

  config = applyEnvOverrides(config)

  return config
}

export function configExists(path: string): boolean {
  return existsSync(path)
}

export function getDefaultLogsDir(): string {
  return join(getConfigDir(), 'kiro-logs')
}
