type RawBody = {
  variant?: unknown
  providerOptions?: {
    variant?: unknown
    modelVariant?: unknown
    thinkingConfig?: {
      thinkingBudget?: unknown
    }
  }
}

export type ThinkingVariant = 'low' | 'medium' | 'high' | 'max'

export function resolveThinkingConfig(
  model: string,
  body: unknown,
  defaults: { budget: number } = { budget: 20000 }
): { enabled: boolean; budget: number; variant?: string } {
  const b = (body || {}) as RawBody

  const rawVariant =
    (typeof b.variant === 'string' && b.variant) ||
    (typeof b.providerOptions?.variant === 'string' && b.providerOptions.variant) ||
    (typeof b.providerOptions?.modelVariant === 'string' && b.providerOptions.modelVariant) ||
    undefined

  const explicitBudget = b.providerOptions?.thinkingConfig?.thinkingBudget
  const budgetFromBody =
    typeof explicitBudget === 'number' && Number.isFinite(explicitBudget) && explicitBudget > 0
      ? explicitBudget
      : undefined

  const budgetFromVariant = variantToBudget(rawVariant)
  const enabled =
    model.endsWith('-thinking') ||
    budgetFromBody !== undefined ||
    b.providerOptions?.thinkingConfig !== undefined ||
    budgetFromVariant !== undefined

  return {
    enabled,
    budget: budgetFromBody ?? budgetFromVariant ?? defaults.budget,
    variant: rawVariant
  }
}

function variantToBudget(rawVariant: string | undefined): number | undefined {
  if (!rawVariant) return undefined

  const v = rawVariant.toLowerCase()
  if (v === 'low') return 8192
  if (v === 'medium') return 16384
  // "high" is the documented name, but "max" is kept as backward compat
  if (v === 'high' || v === 'max') return 32768
  return undefined
}
