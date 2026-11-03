/**
 * Context windows the Kiro backend actually serves.
 *
 * The numbers in Kiro's marketing material are not what the Q layer enforces.
 * The only reliable way to find the real ceiling is to send an oversized
 * `generateAssistantResponse` payload and watch `contextUsagePercentage` climb
 * to ~100% before the service answers
 * `{"message":"Input is too long.","reason":"CONTENT_LENGTH_EXCEEDS_THRESHOLD"}`.
 *
 * Measured 2026-11-03 against a Kiro Pro Max (Q_DEVELOPER_STANDALONE_PRO_MAX)
 * account, growing a single prompt through 1.8M / 2.1M / 2.4M / 2.7M chars:
 *
 * - claude-sonnet-4-5, claude-haiku-4-5, claude-opus-4-5 : 200K
 * - claude-opus-4-6, claude-sonnet-4-6 (and -1m)        : 1M
 * - claude-opus-4-7, claude-opus-4-8, claude-opus-5,
 *   claude-opus-5-5, claude-sonnet-5, claude-sonnet-5-5,
 *   claude-fable-5-1, auto                             : 600K
 *
 * (claude-sonnet-5-1m and claude-opus-4-7-1m are rejected by the service with
 * INVALID_MODEL_ID today, so they are not advertised in the registry.)
 *
 * This table is the single source of truth for BOTH:
 *  - the `limit.context` advertised to OpenCode, and
 *  - the denominator used to turn `contextUsagePercentage` into real tokens.
 *
 * Splitting the two was the original bug: the registry advertised 1M while
 * `getContextWindowSize()` fell back to 200K for any id without a `-1m`
 * suffix, so reported input tokens were ~2.75x too low on 5.x models and
 * auto-compaction never fired.
 *
 * Keyed by the OpenCode-facing model id.
 */
export const DEFAULT_CONTEXT_WINDOW = 200_000

/** Output cap shared by every model the plugin advertises (Kiro's P_T max). */
export const OUTPUT_TOKEN_LIMIT = 64_000

/** Served at the full 1M. */
const LONG_CONTEXT_MODELS = new Set(['claude-opus-4-6', 'claude-sonnet-4-6'])

/** Advertised as 1M, actually capped at 600K by the service. */
const SIX_HUNDRED_K_MODELS = new Set([
  'auto',
  'claude-opus-4-7',
  'claude-opus-4-8',
  'claude-opus-5',
  'claude-opus-5-5',
  'claude-sonnet-5',
  'claude-sonnet-5-5',
  'claude-fable-5-1'
])

/** Open-weight and legacy models with per-model windows instead of the Claude defaults. */
const EXPLICIT_WINDOWS: Readonly<Record<string, number>> = {
  'deepseek-3.2': 128_000,
  'minimax-m2.1': 196_000,
  'minimax-m2.5': 196_000,
  'qwen3-coder-next': 256_000,
  'glm-5': 200_000
}

function stripThinkingSuffix(model: string): string {
  return model.endsWith('-thinking') ? model.slice(0, -'-thinking'.length) : model
}

/**
 * Resolve the input-token window Kiro serves for an OpenCode-facing model id.
 *
 * Accepts both the base id (`claude-opus-5-5`) and its `-thinking` companion.
 * Unknown ids fall back to the conservative 200K so a newly added model never
 * overflows before we have measured it.
 */
export function getModelContextWindow(model: string): number {
  const base = stripThinkingSuffix(model)

  const explicit = EXPLICIT_WINDOWS[base]
  if (explicit !== undefined) return explicit

  if (LONG_CONTEXT_MODELS.has(base) || base.includes('-1m')) return 1_000_000
  if (SIX_HUNDRED_K_MODELS.has(base)) return 600_000

  return DEFAULT_CONTEXT_WINDOW
}
