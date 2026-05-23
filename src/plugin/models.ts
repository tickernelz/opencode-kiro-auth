import { SUPPORTED_MODELS, getKiroApiModelId, getModelContextWindow } from '../constants'

export function resolveKiroModel(model: string): string {
  const resolved = getKiroApiModelId(model)
  if (!resolved) {
    throw new Error(`Unsupported model: ${model}. Supported models: ${SUPPORTED_MODELS.join(', ')}`)
  }
  return resolved
}

export function getContextWindowSize(model: string): number {
  return getModelContextWindow(model)
}
