import type { Effort } from './config/schema'

export type EffortSchemaPath = 'output_config' | 'reasoning'

/** Effort levels ordered from lowest to highest reasoning depth. */
export const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const

/**
 * Reference thinking budget for each effort level. The values also define the
 * inclusive bands used by budgetToEffort, keeping advertised variants and wire
 * effort values in sync.
 */
export const THINKING_BUDGETS: Readonly<Record<Effort, number>> = {
  low: 16384,
  medium: 32768,
  high: 65536,
  xhigh: 98304,
  max: 128000
}

/** GPT-5.6 uses `reasoning.effort` and supports low through xhigh, but not max. */
const GPT_REASONING_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])

/** Models whose advertised effort enum includes xhigh. */
const XHIGH_CAPABLE_MODELS = new Set([
  'claude-opus-4.7',
  'claude-opus-4.8',
  'claude-opus-5',
  'claude-sonnet-5',
  'claude-sonnet-5-1m',
  ...GPT_REASONING_MODELS
])

/** Models that accept an effort parameter through either supported schema path. */
const EFFORT_CAPABLE_MODELS = new Set([
  'claude-opus-4.5',
  'claude-opus-4.6',
  'claude-opus-4.6-1m',
  'claude-sonnet-4.5',
  'claude-sonnet-4.5-1m',
  'claude-sonnet-4.6',
  'claude-sonnet-4.6-1m',
  ...XHIGH_CAPABLE_MODELS
])

export function supportsEffort(kiroModel: string): boolean {
  return EFFORT_CAPABLE_MODELS.has(kiroModel)
}

export function supportsXHighEffort(kiroModel: string): boolean {
  return XHIGH_CAPABLE_MODELS.has(kiroModel)
}

export function usesReasoningEffortSchema(kiroModel: string): boolean {
  return GPT_REASONING_MODELS.has(kiroModel)
}

/** Match Kiro CLI's schema-driven additionalModelRequestFields selection. */
export function getEffortSchemaPath(kiroModel: string): EffortSchemaPath | undefined {
  if (!supportsEffort(kiroModel)) return undefined
  return usesReasoningEffortSchema(kiroModel) ? 'reasoning' : 'output_config'
}

/** Return only effort levels that the selected model advertises. */
export function getSupportedEffortLevels(kiroModel: string): readonly Effort[] {
  if (!supportsEffort(kiroModel)) return []
  if (usesReasoningEffortSchema(kiroModel)) return EFFORT_LEVELS.filter((level) => level !== 'max')
  if (!supportsXHighEffort(kiroModel)) return EFFORT_LEVELS.filter((level) => level !== 'xhigh')
  return EFFORT_LEVELS
}

/**
 * Resolve an effort level against model-specific capabilities.
 * GPT maps the plugin's global `max` setting to its highest valid value,
 * `xhigh`; Claude models without xhigh clamp xhigh to max.
 */
export function resolveEffort(kiroModel: string, requested: Effort): Effort | undefined {
  if (!supportsEffort(kiroModel)) return undefined
  if (usesReasoningEffortSchema(kiroModel) && requested === 'max') return 'xhigh'
  if (requested === 'xhigh' && !supportsXHighEffort(kiroModel)) return 'max'
  return requested
}

export function buildEffortRequestFields(
  effort: Effort,
  schemaPath: EffortSchemaPath
): Record<string, { effort: Effort }> {
  return schemaPath === 'reasoning' ? { reasoning: { effort } } : { output_config: { effort } }
}

/** Map an OpenCode thinking budget to a valid Kiro effort level. */
export function budgetToEffort(budget: number, kiroModel: string): Effort | undefined {
  if (!supportsEffort(kiroModel)) return undefined

  const effort =
    EFFORT_LEVELS.find((level) => budget <= THINKING_BUDGETS[level]) ??
    EFFORT_LEVELS[EFFORT_LEVELS.length - 1]!

  return resolveEffort(kiroModel, effort)
}

/**
 * Resolve effort by priority: explicit config, mapped thinking budget, medium
 * fallback, or no field when reasoning is not enabled.
 */
export function getEffectiveEffort(
  kiroModel: string,
  thinking: boolean,
  budget: number,
  configEffort?: Effort,
  autoEffortMapping = true
): Effort | undefined {
  if (!supportsEffort(kiroModel)) return undefined
  if (configEffort) return resolveEffort(kiroModel, configEffort)
  if (!thinking) return undefined
  if (autoEffortMapping) return budgetToEffort(budget, kiroModel)
  return 'medium'
}
