import { MODEL_MAPPING, SUPPORTED_MODELS, isLongContextModel } from '../constants'

export function resolveKiroModel(model: string): string {
  const resolved = MODEL_MAPPING[model]
  if (!resolved) {
    throw new Error(`Unsupported model: ${model}. Supported models: ${SUPPORTED_MODELS.join(', ')}`)
  }
  return resolved
}

const GPT_272K_MODELS = new Set(['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna'])

export function getContextWindowSize(model: string): number {
  if (GPT_272K_MODELS.has(model)) return 272000
  return isLongContextModel(model) ? 1000000 : 200000
}
