import { createHash } from 'crypto'
import { hostname } from 'os'
import { RegionSchema } from './plugin/config/schema'
import type { KiroRegion } from './plugin/types'

const VALID_REGIONS: readonly KiroRegion[] = RegionSchema.options

export function isValidRegion(region: string): region is KiroRegion {
  return VALID_REGIONS.includes(region as KiroRegion)
}

export function normalizeRegion(region: string | undefined): KiroRegion {
  if (!region || !isValidRegion(region)) {
    return 'us-east-1'
  }
  return region
}

export function buildUrl(template: string, region: KiroRegion): string {
  const url = template.replace('{{region}}', region)

  try {
    new URL(url)
    return url
  } catch {
    throw new Error(`Invalid URL generated: ${url}`)
  }
}

export function extractRegionFromArn(arn: string | undefined): KiroRegion | undefined {
  if (!arn) return undefined
  const parts = arn.split(':')
  if (parts.length < 6) return undefined
  if (parts[0] !== 'arn') return undefined
  const region = parts[3]
  if (typeof region !== 'string' || !region) return undefined
  return isValidRegion(region) ? (region as KiroRegion) : undefined
}

// Kiro rejects clients that do not report a supported IDE version
// (UnsupportedClientVersionException, enforced since 2026-11-09, kirodotdev/Kiro#11335).
// KIRO_IDE_VERSION lets users follow the next minimum-version bump without a release.
export const KIRO_IDE_VERSION = process.env.KIRO_IDE_VERSION?.trim() || '1.4.178'

export const KIRO_CONSTANTS = {
  REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
  REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
  BASE_URL: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse',
  USAGE_LIMITS_URL: 'https://q.{{region}}.amazonaws.com/getUsageLimits',
  DEFAULT_REGION: 'us-east-1' as KiroRegion,
  AXIOS_TIMEOUT: 120000,
  USER_AGENT: `KiroIDE-${KIRO_IDE_VERSION}`,
  SDK_VERSION: '3.738.0',
  SDK_VERSION_USAGE: '3.0.0',
  CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
  ORIGIN_AI_EDITOR: 'AI_EDITOR'
}

export const MODEL_MAPPING: Record<string, string> = {
  // Claude Haiku
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-haiku-4-5-thinking': 'claude-haiku-4.5',
  // Claude Sonnet
  'claude-sonnet-4': 'claude-sonnet-4',
  'claude-sonnet-4-5': 'claude-sonnet-4.5',
  'claude-sonnet-4-5-thinking': 'claude-sonnet-4.5',
  'claude-sonnet-4-5-1m': 'claude-sonnet-4.5-1m',
  'claude-sonnet-4-5-1m-thinking': 'claude-sonnet-4.5-1m',
  'claude-sonnet-4-6': 'claude-sonnet-4.6',
  'claude-sonnet-4-6-thinking': 'claude-sonnet-4.6',
  'claude-sonnet-4-6-1m': 'claude-sonnet-4.6-1m',
  'claude-sonnet-4-6-1m-thinking': 'claude-sonnet-4.6-1m',
  'claude-sonnet-5': 'claude-sonnet-5',
  'claude-sonnet-5-thinking': 'claude-sonnet-5',
  'claude-sonnet-5-1m': 'claude-sonnet-5-1m',
  'claude-sonnet-5-1m-thinking': 'claude-sonnet-5-1m',
  // Claude Opus
  'claude-opus-4-5': 'claude-opus-4.5',
  'claude-opus-4-5-thinking': 'claude-opus-4.5',
  'claude-opus-4-6': 'claude-opus-4.6',
  'claude-opus-4-6-thinking': 'claude-opus-4.6',
  'claude-opus-4-6-1m': 'claude-opus-4.6-1m',
  'claude-opus-4-6-1m-thinking': 'claude-opus-4.6-1m',
  'claude-opus-4-7': 'claude-opus-4.7',
  'claude-opus-4-7-thinking': 'claude-opus-4.7',
  'claude-opus-4-8': 'claude-opus-4.8',
  'claude-opus-4-8-thinking': 'claude-opus-4.8',
  'claude-opus-5': 'claude-opus-5',
  'claude-opus-5-thinking': 'claude-opus-5',
  // Auto
  auto: 'auto',
  // Open weight models
  'deepseek-3.2': 'deepseek-3.2',
  'glm-5': 'glm-5',
  'minimax-m2.5': 'minimax-m2.5',
  'minimax-m2.1': 'minimax-m2.1',
  'qwen3-coder-next': 'qwen3-coder-next',
  // Legacy / internal mappings kept for backwards compatibility
  'claude-3-7-sonnet': 'CLAUDE_3_7_SONNET_20250219_V1_0',
  'nova-swe': 'AGI_NOVA_SWE_V1_5',
  'gpt-oss-120b': 'OPENAI_GPT_OSS_120B_1_0',
  'minimax-m2': 'MINIMAX_MINIMAX_M2',
  'kimi-k2-thinking': 'MOONSHOT_KIMI_K2_THINKING'
}

export const SUPPORTED_MODELS = Object.keys(MODEL_MAPPING)

const LONG_CONTEXT_MODELS = new Set(Object.keys(MODEL_MAPPING).filter((k) => k.includes('-1m')))

export function isLongContextModel(model: string): boolean {
  return LONG_CONTEXT_MODELS.has(model)
}

export const KIRO_AUTH_SERVICE = {
  ENDPOINT: 'https://prod.{{region}}.auth.desktop.kiro.dev',
  SSO_OIDC_ENDPOINT: 'https://oidc.{{region}}.amazonaws.com',
  BUILDER_ID_START_URL: 'https://view.awsapps.com/start',
  USER_INFO_URL: 'https://view.awsapps.com/api/user/info',
  SCOPES: [
    'codewhisperer:completions',
    'codewhisperer:analysis',
    'codewhisperer:conversations',
    'codewhisperer:transformations',
    'codewhisperer:taskassist'
  ]
}

/**
 * Client id in the same shape the Kiro IDE sends: `KiroIDE-<version>-<machineId>`.
 * The machine id is a stable, non-reversible hash of the hostname.
 */
export function getKiroClientId(): string {
  const machineId = createHash('sha256').update(hostname()).digest('hex')
  return `${KIRO_CONSTANTS.USER_AGENT}-${machineId}`
}
