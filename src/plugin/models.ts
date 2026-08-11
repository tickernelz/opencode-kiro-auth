import {
  extractRegionFromArn,
  isLongContextModel,
  MODEL_MAPPING,
  SUPPORTED_MODELS
} from '../constants'
import type { KiroAuthDetails } from './types'

const MODEL_CATALOG_TTL_MS = 5 * 60 * 1000
const DEFAULT_CONTEXT_WINDOW = 200_000

type ModelCatalogResponse = {
  models?: Array<{
    modelId?: string
    tokenLimits?: { maxInputTokens?: number }
  }>
}

type CatalogCacheEntry = {
  expiresAt: number
  contextWindows: Map<string, number>
}

const catalogCache = new Map<string, CatalogCacheEntry>()
let activeContextWindows = new Map<string, number>()

export function resolveKiroModel(model: string): string {
  const resolved = MODEL_MAPPING[model]
  if (!resolved) {
    throw new Error(`Unsupported model: ${model}. Supported models: ${SUPPORTED_MODELS.join(', ')}`)
  }
  return resolved
}

export function getContextWindowSize(model: string): number {
  return (
    activeContextWindows.get(model) ??
    (isLongContextModel(model) ? 1_000_000 : DEFAULT_CONTEXT_WINDOW)
  )
}

function getCatalogRegion(auth: KiroAuthDetails): string {
  return extractRegionFromArn(auth.profileArn) ?? auth.region ?? 'us-east-1'
}

function applyCatalog(contextWindows: Map<string, number>): void {
  activeContextWindows = new Map(contextWindows)
}

function parseModelCatalog(data: ModelCatalogResponse): Map<string, number> {
  const contextWindows = new Map<string, number>()

  for (const model of data.models ?? []) {
    const modelId = model.modelId
    const maxInputTokens = model.tokenLimits?.maxInputTokens
    if (
      !modelId ||
      typeof maxInputTokens !== 'number' ||
      !Number.isInteger(maxInputTokens) ||
      maxInputTokens <= 0
    )
      continue

    contextWindows.set(modelId, maxInputTokens)
    for (const [alias, resolved] of Object.entries(MODEL_MAPPING)) {
      if (resolved === modelId) contextWindows.set(alias, maxInputTokens)
    }
  }

  return contextWindows
}

export async function refreshContextWindowSizes(auth: KiroAuthDetails): Promise<void> {
  const cacheKey = `${auth.access}:${getCatalogRegion(auth)}`
  const cached = catalogCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) {
    applyCatalog(cached.contextWindows)
    return
  }
  activeContextWindows = new Map()

  const regions = [getCatalogRegion(auth)]
  if (!regions.includes('us-east-1')) regions.push('us-east-1')

  for (const region of regions) {
    const endpoint = new URL(`https://q.${region}.amazonaws.com/ListAvailableModels`)
    endpoint.searchParams.set('origin', 'AI_EDITOR')

    try {
      const response = await fetch(endpoint, {
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${auth.access}`
        },
        signal: AbortSignal.timeout(5_000)
      })
      if (!response.ok) continue

      const contextWindows = parseModelCatalog((await response.json()) as ModelCatalogResponse)
      if (contextWindows.size === 0) continue

      catalogCache.set(cacheKey, {
        expiresAt: Date.now() + MODEL_CATALOG_TTL_MS,
        contextWindows
      })
      applyCatalog(contextWindows)
      return
    } catch {
      continue
    }
  }
}

export function clearContextWindowCatalog(): void {
  catalogCache.clear()
  activeContextWindows = new Map()
}
