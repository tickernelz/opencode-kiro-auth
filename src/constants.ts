import { RegionSchema } from './plugin/config/schema'
import type { KiroRegion } from './plugin/types'

export const KIRO_PROVIDER_ID = 'kiro'
export const KIRO_LEGACY_PROVIDER_ID = 'kiro-auth'

export function isValidRegion(region: string): region is KiroRegion {
  return RegionSchema.safeParse(region).success
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

export const KIRO_CONSTANTS = {
  REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
  REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
  BASE_URL: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse',
  USAGE_LIMITS_URL: 'https://q.{{region}}.amazonaws.com/getUsageLimits',
  DEFAULT_REGION: 'us-east-1' as KiroRegion,
  AXIOS_TIMEOUT: 120000,
  USER_AGENT: 'KiroIDE',
  SDK_VERSION: '3.738.0',
  SDK_VERSION_USAGE: '3.0.0',
  CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
  ORIGIN_AI_EDITOR: 'AI_EDITOR'
}

const TEXT_ONLY = ['text'] as const
const TEXT_IMAGE = ['text', 'image'] as const
const TEXT_IMAGE_PDF = ['text', 'image', 'pdf'] as const
const TEXT_OUTPUT = ['text'] as const

const STANDARD_CONTEXT = 200000
const LONG_CONTEXT = 1000000
const DEFAULT_OUTPUT = 64000

export const THINKING_BUDGET_BY_EFFORT = {
  low: 8192,
  medium: 16384,
  high: 32768,
  max: 32768,
  xhigh: 49152
} as const

export interface KiroModelDefinition {
  name: string
  apiModelId: string
  context: number
  output: number
  input: readonly string[]
  outputModalities: readonly string[]
  costMultiplier?: string
  releaseDate?: string
  reasoning?: boolean
}

function model(input: KiroModelDefinition): KiroModelDefinition {
  return input
}

export const KIRO_MODEL_CATALOG = {
  auto: model({
    name: 'Auto (1.0x)',
    apiModelId: 'auto',
    context: STANDARD_CONTEXT,
    output: DEFAULT_OUTPUT,
    input: TEXT_IMAGE_PDF,
    outputModalities: TEXT_OUTPUT
  }),

  'claude-opus-4.7': model({
    name: 'Claude Opus 4.7 (2.2x)',
    apiModelId: 'claude-opus-4.7',
    context: LONG_CONTEXT,
    output: DEFAULT_OUTPUT,
    input: TEXT_IMAGE_PDF,
    outputModalities: TEXT_OUTPUT,
    costMultiplier: '2.2x',
    releaseDate: '2026-04-16',
    reasoning: true
  }),

  'claude-opus-4.6': model({
    name: 'Claude Opus 4.6 (2.2x)',
    apiModelId: 'claude-opus-4.6',
    context: LONG_CONTEXT,
    output: DEFAULT_OUTPUT,
    input: TEXT_IMAGE_PDF,
    outputModalities: TEXT_OUTPUT,
    costMultiplier: '2.2x',
    releaseDate: '2026-02-05',
    reasoning: true
  }),

  'claude-sonnet-4.6': model({
    name: 'Claude Sonnet 4.6 (1.3x)',
    apiModelId: 'claude-sonnet-4.6',
    context: LONG_CONTEXT,
    output: DEFAULT_OUTPUT,
    input: TEXT_IMAGE_PDF,
    outputModalities: TEXT_OUTPUT,
    costMultiplier: '1.3x',
    releaseDate: '2026-02-17',
    reasoning: true
  }),

  'claude-opus-4.5': model({
    name: 'Claude Opus 4.5 (2.2x)',
    apiModelId: 'claude-opus-4.5',
    context: STANDARD_CONTEXT,
    output: DEFAULT_OUTPUT,
    input: TEXT_IMAGE_PDF,
    outputModalities: TEXT_OUTPUT,
    costMultiplier: '2.2x'
  }),
  'claude-sonnet-4.5': model({
    name: 'Claude Sonnet 4.5 (1.3x)',
    apiModelId: 'claude-sonnet-4.5',
    context: STANDARD_CONTEXT,
    output: DEFAULT_OUTPUT,
    input: TEXT_IMAGE_PDF,
    outputModalities: TEXT_OUTPUT,
    costMultiplier: '1.3x'
  }),
  'claude-sonnet-4': model({
    name: 'Claude Sonnet 4 (1.3x)',
    apiModelId: 'claude-sonnet-4',
    context: STANDARD_CONTEXT,
    output: DEFAULT_OUTPUT,
    input: TEXT_IMAGE_PDF,
    outputModalities: TEXT_OUTPUT,
    costMultiplier: '1.3x',
    reasoning: true
  }),
  'claude-haiku-4.5': model({
    name: 'Claude Haiku 4.5 (0.4x)',
    apiModelId: 'claude-haiku-4.5',
    context: STANDARD_CONTEXT,
    output: DEFAULT_OUTPUT,
    input: TEXT_IMAGE,
    outputModalities: TEXT_OUTPUT,
    costMultiplier: '0.4x',
    reasoning: true
  }),

  'deepseek-3.2': model({
    name: 'DeepSeek 3.2 (0.25x)',
    apiModelId: 'deepseek-3.2',
    context: 128000,
    output: DEFAULT_OUTPUT,
    input: TEXT_ONLY,
    outputModalities: TEXT_OUTPUT,
    costMultiplier: '0.25x',
    releaseDate: '2026-02-10'
  }),
  'glm-5': model({
    name: 'GLM-5 (0.5x)',
    apiModelId: 'glm-5',
    context: STANDARD_CONTEXT,
    output: DEFAULT_OUTPUT,
    input: TEXT_ONLY,
    outputModalities: TEXT_OUTPUT,
    costMultiplier: '0.5x',
    releaseDate: '2026-03-31',
    reasoning: true
  }),
  'minimax-m2.5': model({
    name: 'MiniMax M2.5 (0.25x)',
    apiModelId: 'minimax-m2.5',
    context: STANDARD_CONTEXT,
    output: DEFAULT_OUTPUT,
    input: TEXT_ONLY,
    outputModalities: TEXT_OUTPUT,
    costMultiplier: '0.25x',
    releaseDate: '2026-03-18'
  }),
  'minimax-m2.1': model({
    name: 'MiniMax M2.1 (0.15x)',
    apiModelId: 'minimax-m2.1',
    context: STANDARD_CONTEXT,
    output: DEFAULT_OUTPUT,
    input: TEXT_ONLY,
    outputModalities: TEXT_OUTPUT,
    costMultiplier: '0.15x',
    releaseDate: '2026-02-10'
  }),
  'qwen3-coder-next': model({
    name: 'Qwen3 Coder Next (0.05x)',
    apiModelId: 'qwen3-coder-next',
    context: 256000,
    output: DEFAULT_OUTPUT,
    input: TEXT_ONLY,
    outputModalities: TEXT_OUTPUT,
    costMultiplier: '0.05x',
    releaseDate: '2026-02-10'
  })
} as const satisfies Record<string, KiroModelDefinition>

export const LEGACY_MODEL_MAPPING: Record<string, string> = {
  'claude-3-7-sonnet': 'CLAUDE_3_7_SONNET_20250219_V1_0',
  'nova-swe': 'AGI_NOVA_SWE_V1_5',
  'gpt-oss-120b': 'OPENAI_GPT_OSS_120B_1_0',
  'minimax-m2': 'MINIMAX_MINIMAX_M2',
  'kimi-k2-thinking': 'MOONSHOT_KIMI_K2_THINKING'
}

const HYPHENATED_CLAUDE_ALIASES = [
  'claude-opus-4.7',
  'claude-opus-4.6',
  'claude-sonnet-4.6',
  'claude-opus-4.5',
  'claude-sonnet-4.5',
  'claude-haiku-4.5'
] as const

export const MODEL_ALIASES = {
  ...Object.fromEntries(HYPHENATED_CLAUDE_ALIASES.map((id) => [id.replace(/\./g, '-'), id])),
  'claude-opus-4-6-1m': 'claude-opus-4.6',
  'claude-opus-4.6-1m': 'claude-opus-4.6',
  'claude-sonnet-4-6-1m': 'claude-sonnet-4.6',
  'claude-sonnet-4.6-1m': 'claude-sonnet-4.6'
} as Record<string, keyof typeof KIRO_MODEL_CATALOG>

function stripThinkingSuffix(model: string): string {
  return model.endsWith('-thinking') ? model.slice(0, -'-thinking'.length) : model
}

function getCanonicalModelID(model: string): keyof typeof KIRO_MODEL_CATALOG | undefined {
  const base = stripThinkingSuffix(model)
  const canonical = MODEL_ALIASES[base] ?? base
  return canonical in KIRO_MODEL_CATALOG
    ? (canonical as keyof typeof KIRO_MODEL_CATALOG)
    : undefined
}

function getModelDefinition(model: string): KiroModelDefinition | undefined {
  const canonical = getCanonicalModelID(model)
  return canonical ? KIRO_MODEL_CATALOG[canonical] : undefined
}

export function getKiroApiModelId(model: string): string | undefined {
  const canonical = getCanonicalModelID(model)
  if (canonical) return KIRO_MODEL_CATALOG[canonical].apiModelId
  return LEGACY_MODEL_MAPPING[model]
}

export const MODEL_MAPPING: Record<string, string> = {
  ...Object.fromEntries(
    Object.entries(KIRO_MODEL_CATALOG).map(([id, definition]) => [id, definition.apiModelId])
  ),
  ...Object.fromEntries(
    Object.entries(MODEL_ALIASES).map(([alias, canonical]) => [
      alias,
      KIRO_MODEL_CATALOG[canonical].apiModelId
    ])
  ),
  ...LEGACY_MODEL_MAPPING
}

export const DEFAULT_MODEL_IDS = Object.keys(KIRO_MODEL_CATALOG)
export const SUPPORTED_MODELS = DEFAULT_MODEL_IDS

export const DEFAULT_PROVIDER_MODELS = Object.fromEntries(
  Object.entries(KIRO_MODEL_CATALOG).map(([id, definition]) => [
    id,
    {
      id: definition.apiModelId,
      name: definition.name,
      release_date: definition.releaseDate,
      reasoning: definition.reasoning,
      tool_call: true,
      limit: { context: definition.context, output: definition.output },
      modalities: { input: [...definition.input], output: [...definition.outputModalities] }
    }
  ])
)

export function isLongContextModel(model: string): boolean {
  return (getModelDefinition(model)?.context ?? 0) >= LONG_CONTEXT
}

export function getModelContextWindow(model: string): number {
  return getModelDefinition(model)?.context || STANDARD_CONTEXT
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
