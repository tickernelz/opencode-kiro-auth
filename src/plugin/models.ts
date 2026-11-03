import { MODEL_MAPPING, SUPPORTED_MODELS } from '../constants'
import { getModelContextWindow } from './context-windows.js'

export function resolveKiroModel(model: string): string {
  const resolved = MODEL_MAPPING[model]
  if (!resolved) {
    throw new Error(`Unsupported model: ${model}. Supported models: ${SUPPORTED_MODELS.join(', ')}`)
  }
  return resolved
}

/**
 * Input-token window Kiro serves for this model.
 *
 * Delegates to the measured table in `context-windows.ts`; the old
 * `-1m`-suffix heuristic returned 200K for the 5.x models, which are actually
 * served at 600K, so every reported token count was ~2.75x too low.
 */
export function getContextWindowSize(model: string): number {
  return getModelContextWindow(model)
}