import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { AccountSelectionStrategySchema, KiroConfigSchema, RegionSchema, DEFAULT_CONFIG, type KiroConfig } from "./schema";
import * as logger from "../logger";

function getConfigDir(): string {
  const platform = process.platform;
  if (platform === "win32") {
    return join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "opencode");
  }
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

export function getUserConfigPath(): string {
  return join(getConfigDir(), "kiro.json");
}

export function getProjectConfigPath(directory: string): string {
  return join(directory, ".opencode", "kiro.json");
}

function loadConfigFile(path: string): Partial<KiroConfig> | null {
  try {
    if (!existsSync(path)) {
      return null;
    }

    const content = readFileSync(path, "utf-8");
    const rawConfig = JSON.parse(content);

    const result = KiroConfigSchema.partial().safeParse(rawConfig);

    if (!result.success) {
      const issues = result.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", ");
      logger.warn(`Config validation error at ${path}: ${issues}`);
      return null;
    }

    return result.data;
  } catch (error) {
    if (error instanceof SyntaxError) {
      logger.warn(`Invalid JSON in config file ${path}: ${error.message}`);
    } else {
      logger.warn(`Failed to load config file ${path}: ${String(error)}`);
    }
    return null;
  }
}

function mergeConfigs(
  base: KiroConfig,
  override: Partial<KiroConfig>
): KiroConfig {
  return {
    ...base,
    ...override,
  };
}

function parseBooleanEnv(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (value === "1" || value === "true") {
    return true;
  }
  if (value === "0" || value === "false") {
    return false;
  }
  return fallback;
}

function parseNumberEnv(value: string | undefined, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  const parsed = Number(value);
  if (isNaN(parsed)) {
    return fallback;
  }
  return parsed;
}

function applyEnvOverrides(config: KiroConfig): KiroConfig {
  const env = process.env;

  return {
    ...config,

    quiet_mode: parseBooleanEnv(env.KIRO_QUIET_MODE, config.quiet_mode),

    debug: parseBooleanEnv(env.KIRO_DEBUG, config.debug),

    session_recovery: parseBooleanEnv(env.KIRO_SESSION_RECOVERY, config.session_recovery),

    auto_resume: parseBooleanEnv(env.KIRO_AUTO_RESUME, config.auto_resume),

    max_recovery_attempts: parseNumberEnv(env.KIRO_MAX_RECOVERY_ATTEMPTS, config.max_recovery_attempts),

    proactive_token_refresh: parseBooleanEnv(env.KIRO_PROACTIVE_TOKEN_REFRESH, config.proactive_token_refresh),

    token_refresh_interval_seconds: parseNumberEnv(
      env.KIRO_TOKEN_REFRESH_INTERVAL_SECONDS,
      config.token_refresh_interval_seconds
    ),

    token_refresh_buffer_seconds: parseNumberEnv(
      env.KIRO_TOKEN_REFRESH_BUFFER_SECONDS,
      config.token_refresh_buffer_seconds
    ),

    account_selection_strategy: env.KIRO_ACCOUNT_SELECTION_STRATEGY
      ? AccountSelectionStrategySchema.catch('sticky').parse(env.KIRO_ACCOUNT_SELECTION_STRATEGY)
      : config.account_selection_strategy,

    thinking_enabled: parseBooleanEnv(env.KIRO_THINKING_ENABLED, config.thinking_enabled),

    thinking_budget_tokens: parseNumberEnv(env.KIRO_THINKING_BUDGET_TOKENS, config.thinking_budget_tokens),

    default_region: env.KIRO_DEFAULT_REGION
      ? RegionSchema.catch('us-east-1').parse(env.KIRO_DEFAULT_REGION)
      : config.default_region,

    request_timeout_ms: parseNumberEnv(env.KIRO_REQUEST_TIMEOUT_MS, config.request_timeout_ms),

    rate_limit_retry_delay_ms: parseNumberEnv(
      env.KIRO_RATE_LIMIT_RETRY_DELAY_MS,
      config.rate_limit_retry_delay_ms
    ),

    rate_limit_max_retries: parseNumberEnv(env.KIRO_RATE_LIMIT_MAX_RETRIES, config.rate_limit_max_retries),

    quota_warning_threshold: parseNumberEnv(env.KIRO_QUOTA_WARNING_THRESHOLD, config.quota_warning_threshold),

    usage_tracking_enabled: parseBooleanEnv(env.KIRO_USAGE_TRACKING_ENABLED, config.usage_tracking_enabled),

    usage_fetch_interval_seconds: parseNumberEnv(
      env.KIRO_USAGE_FETCH_INTERVAL_SECONDS,
      config.usage_fetch_interval_seconds
    ),
  };
}

export function loadConfig(directory: string): KiroConfig {
  let config: KiroConfig = { ...DEFAULT_CONFIG };

  const userConfigPath = getUserConfigPath();
  const userConfig = loadConfigFile(userConfigPath);
  if (userConfig) {
    config = mergeConfigs(config, userConfig);
  }

  const projectConfigPath = getProjectConfigPath(directory);
  const projectConfig = loadConfigFile(projectConfigPath);
  if (projectConfig) {
    config = mergeConfigs(config, projectConfig);
  }

  config = applyEnvOverrides(config);

  return config;
}

export function configExists(path: string): boolean {
  return existsSync(path);
}

export function getDefaultLogsDir(): string {
  return join(getConfigDir(), "kiro-logs");
}
