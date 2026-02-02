import type { Config } from '@opencode-ai/sdk'

import { KIRO_CONSTANTS, buildUrl, normalizeRegion } from './constants.js'

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function getKiroOpenAICompatibleBaseURL(region: string | undefined): string {
  const normalizedRegion = normalizeRegion(region)
  const template = KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '')
  return buildUrl(template, normalizedRegion)
}

/**
 * Ensure OpenCode's provider options include a baseURL.
 *
 * OpenCode wires `provider.<id>.options.baseURL` into the bundled
 * `@ai-sdk/openai-compatible` provider. If missing, it can attempt to call
 * `undefined/chat/completions`.
 */
export function ensureProviderBaseURL(
  config: Config,
  providerId: string,
  baseURL: string
): boolean {
  if (!config.provider) {
    config.provider = {}
  }

  const provider = config.provider[providerId] ?? {}
  config.provider[providerId] = provider

  if (!provider.options) {
    provider.options = {}
  }

  if (isNonEmptyString(provider.options.baseURL)) {
    return false
  }

  provider.options.baseURL = baseURL
  return true
}
