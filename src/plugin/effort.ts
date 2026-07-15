import type { Effort } from './config/schema'

/**
 * Effort levels ordered from lowest to highest reasoning depth.
 */
export const EFFORT_LEVELS: readonly Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const

export type EffortSchemaPath = 'output_config' | 'reasoning'

const REASONING_EFFORT_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])

/**
 * Models that support the 5-value effort enum (including xhigh).
 */
const XHIGH_CAPABLE_MODELS = new Set([
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'claude-opus-4.7',
  'claude-opus-4.8'
])

/**
 * Models that support the 4-value effort enum (no xhigh).
 */
const EFFORT_CAPABLE_MODELS = new Set([
  'claude-opus-4.6',
  'claude-opus-4.6-1m',
  'claude-sonnet-4.6',
  'claude-sonnet-4.6-1m',
  ...XHIGH_CAPABLE_MODELS
])

/**
 * Check if a model supports the effort parameter.
 */
export function supportsEffort(kiroModel: string): boolean {
  return EFFORT_CAPABLE_MODELS.has(kiroModel)
}

/**
 * Check if a model supports xhigh effort level.
 */
export function supportsXHighEffort(kiroModel: string): boolean {
  return XHIGH_CAPABLE_MODELS.has(kiroModel)
}

export function getEffortSchemaPath(kiroModel: string): EffortSchemaPath | undefined {
  if (!supportsEffort(kiroModel)) return undefined
  return REASONING_EFFORT_MODELS.has(kiroModel) ? 'reasoning' : 'output_config'
}

/**
 * Resolve effort level for a given model.
 * - Returns undefined if model doesn't support effort
 * - Returns undefined when the requested level is unsupported by the model
 */
export function resolveEffort(kiroModel: string, requested: Effort): Effort | undefined {
  if (!supportsEffort(kiroModel)) {
    return undefined
  }

  if (requested === 'xhigh' && !supportsXHighEffort(kiroModel)) {
    return undefined
  }

  return requested
}

/**
 * Map OpenCode thinking budget to Kiro effort level.
 *
 * OpenCode sends thinkingBudget from its variant config. Standard values:
 * - low:    8192
 * - medium: 16384
 * - high:   24576
 * - max:    32768
 *
 * We map these ranges to Kiro effort levels:
 * - ≤10000  → low
 * - ≤20000  → medium
 * - ≤28000  → high
 * - ≤32768  → max (or xhigh on opus-4.7/4.8, max otherwise)
 * - >32768  → max
 */
export function budgetToEffort(budget: number, kiroModel: string): Effort | undefined {
  if (!supportsEffort(kiroModel)) {
    return undefined
  }

  let effort: Effort
  if (budget <= 10000) {
    effort = 'low'
  } else if (budget <= 20000) {
    effort = 'medium'
  } else if (budget <= 28000) {
    effort = 'high'
  } else {
    effort = 'max'
  }

  return effort
}

/**
 * Get the effective effort level based on config, budget, and model.
 *
 * Priority:
 * 1. Explicit effort config (if set) - always applied regardless of thinking state
 * 2. Budget-to-effort mapping (if auto_effort_mapping enabled and thinking)
 * 3. 'medium' default (if thinking enabled)
 * 4. undefined (if not thinking)
 */
export function getEffectiveEffort(
  kiroModel: string,
  thinking: boolean,
  budget: number,
  configEffort?: Effort,
  autoEffortMapping = false,
  requestEffort?: Effort
): Effort | undefined {
  if (!supportsEffort(kiroModel)) {
    return undefined
  }

  // A selected OpenCode model variant is specific to this request.
  if (requestEffort) {
    return resolveEffort(kiroModel, requestEffort)
  }

  // Explicit config applies even without thinking.
  if (configEffort) {
    return resolveEffort(kiroModel, configEffort)
  }

  // If not thinking, no effort needed
  if (!thinking) {
    return undefined
  }

  // Auto-map budget to effort
  if (autoEffortMapping) {
    return budgetToEffort(budget, kiroModel)
  }

  // Default to medium when thinking without auto-mapping
  return 'medium'
}
