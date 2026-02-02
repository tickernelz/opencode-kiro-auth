import type { KiroRegion } from './plugin/types'

const VALID_REGIONS: readonly KiroRegion[] = ['us-east-1', 'us-west-2']

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

export const KIRO_CONSTANTS = {
  REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
  REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
  BASE_URL: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse',
  USAGE_LIMITS_URL: 'https://q.{{region}}.amazonaws.com/getUsageLimits',
  DEFAULT_REGION: 'us-east-1' as KiroRegion,
  AXIOS_TIMEOUT: 120000,
  USER_AGENT: 'KiroIDE',
  KIRO_VERSION: '0.7.5',
  CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
  ORIGIN_AI_EDITOR: 'AI_EDITOR'
}

export const MODEL_MAPPING: Record<string, string> = {
  'claude-haiku-4-5': 'CLAUDE_HAIKU_4_5_20251001_V1_0',
  'claude-haiku-4-5-thinking': 'CLAUDE_HAIKU_4_5_20251001_V1_0',
  'claude-sonnet-4-5': 'CLAUDE_SONNET_4_5_20250929_V1_0',
  'claude-sonnet-4-5-thinking': 'CLAUDE_SONNET_4_5_20250929_V1_0',
  'claude-sonnet-4-5-1m': 'CLAUDE_SONNET_4_5_20250929_LONG_V1_0',
  'claude-sonnet-4-5-1m-thinking': 'CLAUDE_SONNET_4_5_20250929_LONG_V1_0',
  'claude-opus-4-5': 'CLAUDE_OPUS_4_5_20251101_V1_0',
  'claude-opus-4-5-thinking': 'CLAUDE_OPUS_4_5_20251101_V1_0',
  'claude-sonnet-4': 'CLAUDE_SONNET_4_20250514_V1_0',
  'claude-3-7-sonnet': 'CLAUDE_3_7_SONNET_20250219_V1_0',
  'nova-swe': 'AGI_NOVA_SWE_V1_5',
  'gpt-oss-120b': 'OPENAI_GPT_OSS_120B_1_0',
  'qwen3-coder-480b': 'QWEN3_CODER_480B_A35B_1_0',
  'minimax-m2': 'MINIMAX_MINIMAX_M2',
  'kimi-k2-thinking': 'MOONSHOT_KIMI_K2_THINKING'
}

export const SUPPORTED_MODELS = Object.keys(MODEL_MAPPING)

export const KIRO_AUTH_SERVICE = {
  ENDPOINT: 'https://prod.{{region}}.auth.desktop.kiro.dev',
  SSO_OIDC_ENDPOINT: 'https://oidc.{{region}}.amazonaws.com',
  BUILDER_ID_START_URL: 'https://view.awsapps.com/start',
  SCOPES: [
    'codewhisperer:completions',
    'codewhisperer:analysis',
    'codewhisperer:conversations',
    'codewhisperer:transformations',
    'codewhisperer:taskassist'
  ]
}
