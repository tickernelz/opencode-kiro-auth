import { EFFORT_LEVELS, supportsEffort, supportsXHighEffort, THINKING_BUDGETS } from './effort.js'
import { resolveKiroModel } from './models.js'

type Modalities = {
  input: Array<'text' | 'image' | 'pdf'>
  output: ['text']
}

const TEXT_ONLY: Modalities = { input: ['text'], output: ['text'] }
const TEXT_IMAGE: Modalities = { input: ['text', 'image'], output: ['text'] }
const MULTIMODAL: Modalities = { input: ['text', 'image', 'pdf'], output: ['text'] }

const CONTEXT_200K = { context: 200000, output: 64000 }
const CONTEXT_1M = { context: 1000000, output: 64000 }

interface ModelSpec {
  /** Display name, without the credit multiplier suffix. */
  name: string
  /** Kiro credit multiplier, rendered into the display name. */
  rate: string
  limit: { context: number; output: number }
  modalities: Modalities
  /**
   * Emit a companion `-thinking` entry. Only set for Claude models that accept
   * `output_config.effort`; the effort ladder is derived from the model's own
   * capabilities in effort.ts.
   */
  thinking?: boolean
}

/**
 * Models Kiro exposes, keyed by the OpenCode-facing model ID.
 *
 * Anthropic and open-weight models only. Kiro's GPT-5.6 tiers are deliberately
 * absent: they configure reasoning through `reasoning.effort` / `reasoning.mode`
 * rather than `output_config.effort`, so they need their own request path.
 */
const MODEL_SPECS: Record<string, ModelSpec> = {
  auto: { name: 'Auto', rate: '1.0x', limit: CONTEXT_200K, modalities: MULTIMODAL },

  // Claude Sonnet
  'claude-sonnet-4': {
    name: 'Claude Sonnet 4.0',
    rate: '1.3x',
    limit: CONTEXT_200K,
    modalities: MULTIMODAL
  },
  'claude-sonnet-4-5': {
    name: 'Claude Sonnet 4.5',
    rate: '1.3x',
    limit: CONTEXT_200K,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-sonnet-4-6': {
    name: 'Claude Sonnet 4.6',
    rate: '1.3x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-sonnet-5': {
    name: 'Claude Sonnet 5',
    rate: '1.3x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-sonnet-5-5': {
    name: 'Claude Sonnet 5.5',
    rate: '1.3x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },

  // Claude Haiku
  'claude-haiku-4-5': {
    name: 'Claude Haiku 4.5',
    rate: '0.4x',
    limit: CONTEXT_200K,
    modalities: TEXT_IMAGE
  },
  'claude-haiku-5-5': {
    name: 'Claude Haiku 5.5',
    rate: '0.4x',
    limit: CONTEXT_1M,
    modalities: TEXT_IMAGE
  },

  // Claude Opus
  'claude-opus-4-5': {
    name: 'Claude Opus 4.5',
    rate: '2.2x',
    limit: CONTEXT_200K,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-4-6': {
    name: 'Claude Opus 4.6',
    rate: '2.2x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-4-7': {
    name: 'Claude Opus 4.7',
    rate: '2.2x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-4-8': {
    name: 'Claude Opus 4.8',
    rate: '2.2x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-5': {
    name: 'Claude Opus 5',
    rate: '2.2x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },
  'claude-opus-5-5': {
    name: 'Claude Opus 5.5',
    rate: '2.0x',
    limit: CONTEXT_1M,
    modalities: MULTIMODAL,
    thinking: true
  },

  // Open weight models
  'deepseek-3.2': {
    name: 'DeepSeek 3.2',
    rate: '0.25x',
    limit: { context: 128000, output: 64000 },
    modalities: TEXT_ONLY
  },
  'glm-5': { name: 'GLM-5', rate: '0.5x', limit: CONTEXT_200K, modalities: TEXT_ONLY },
  'minimax-m2.5': {
    name: 'MiniMax M2.5',
    rate: '0.25x',
    limit: { context: 196000, output: 64000 },
    modalities: TEXT_ONLY
  },
  'minimax-m2.1': {
    name: 'MiniMax M2.1',
    rate: '0.15x',
    limit: { context: 196000, output: 64000 },
    modalities: TEXT_ONLY
  },
  'qwen3-coder-next': {
    name: 'Qwen3 Coder Next',
    rate: '0.05x',
    limit: { context: 256000, output: 64000 },
    modalities: TEXT_ONLY
  }
}

/**
 * Build the thinking variants a model supports.
 *
 * Levels come from the model's own effort capabilities, so xhigh only appears on
 * models that accept it and the budgets stay in step with budgetToEffort.
 */
function buildVariants(kiroModel: string): Record<string, unknown> {
  const variants: Record<string, unknown> = {}

  for (const level of EFFORT_LEVELS) {
    if (level === 'xhigh' && !supportsXHighEffort(kiroModel)) continue
    variants[level] = { thinkingConfig: { thinkingBudget: THINKING_BUDGETS[level] } }
  }

  return variants
}

/**
 * Model registry advertised to OpenCode.
 *
 * `-thinking` entries carry `reasoning` and `interleaved`. Both are required:
 * `reasoning` declares the capability, and `interleaved.field` tells OpenCode
 * that reasoning arrives in the non-standard `reasoning_content` delta this
 * plugin emits (see streaming/openai-converter.ts). Without them OpenCode
 * silently drops every reasoning chunk and no thinking block is rendered.
 */
export function buildModelRegistry(): Record<string, unknown> {
  const models: Record<string, unknown> = {}

  for (const [modelID, spec] of Object.entries(MODEL_SPECS)) {
    models[modelID] = {
      name: `${spec.name} (${spec.rate})`,
      limit: spec.limit,
      modalities: spec.modalities
    }

    if (!spec.thinking) continue

    // Effort capability is keyed on the resolved Kiro model ID, not the
    // OpenCode-facing one (e.g. claude-opus-5 vs claude-opus-4-6).
    const kiroModel = resolveKiroModel(modelID)
    if (!supportsEffort(kiroModel)) continue

    models[`${modelID}-thinking`] = {
      name: `${spec.name} Thinking (${spec.rate})`,
      limit: spec.limit,
      modalities: spec.modalities,
      reasoning: true,
      interleaved: { field: 'reasoning_content' },
      variants: buildVariants(kiroModel)
    }
  }

  return models
}
