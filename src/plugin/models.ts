import { MODEL_MAPPING, SUPPORTED_MODELS, isLongContextModel } from '../constants'

const MODEL_CONTEXT_WINDOWS = {
  auto: 200_000,
  'claude-sonnet-4': 200_000,
  'claude-sonnet-4-5': 200_000,
  'claude-sonnet-4-6': 1_000_000,
  'claude-sonnet-5': 1_000_000,
  'claude-haiku-4-5': 200_000,
  'claude-opus-4-5': 200_000,
  'claude-opus-4-6': 1_000_000,
  'claude-opus-4-7': 1_000_000,
  'claude-opus-4-8': 1_000_000,
  'claude-opus-4-8-thinking': 1_000_000,
  'deepseek-3.2': 128_000,
  'glm-5': 200_000,
  'minimax-m2.5': 200_000,
  'minimax-m2.1': 200_000,
  'qwen3-coder-next': 256_000
} as const

export function resolveKiroModel(model: string): string {
  const resolved = MODEL_MAPPING[model]
  if (!resolved) {
    throw new Error(`Unsupported model: ${model}. Supported models: ${SUPPORTED_MODELS.join(', ')}`)
  }
  return resolved
}

export function getContextWindowSize(model: string): number {
  if (model in MODEL_CONTEXT_WINDOWS) {
    return MODEL_CONTEXT_WINDOWS[model as keyof typeof MODEL_CONTEXT_WINDOWS]
  }
  return isLongContextModel(model) ? 1000000 : 200000
}
