import { createOpenAICompatible } from '@ai-sdk/openai-compatible'

/**
 * The AI SDK provider OpenCode V2 runs Kiro models through.
 *
 * This module is also the provider's `package`: V2 names it as
 * `aisdk:file://.../v2-sdk.js` (see plugin-v2.ts). A `file://` specifier keeps
 * V2 from rewriting the provider onto its native openai-compatible route, which
 * would bypass the plugin's fetch. V2's dynamic loader imports this file and
 * calls the first `create*` export with the provider options; the plugin's
 * `sdk` hook then replaces that SDK with one wired to the Kiro request handler.
 */

type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type Overlay = Record<string, unknown>

export const KIRO_SDK_NAME = 'kiro'

const isRecord = (value: unknown): value is Overlay =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Recursively merge a V2 `body` overlay into a request body: objects merge,
 * arrays and scalars replace. This mirrors what OpenCode does for its own
 * fetch, which the plugin's fetch replaces.
 */
export function mergeOverlay(base: Overlay, overlay: Overlay): Overlay {
  const result: Overlay = { ...base }
  for (const [key, value] of Object.entries(overlay)) {
    const current = result[key]
    result[key] = isRecord(current) && isRecord(value) ? mergeOverlay(current, value) : value
  }
  return result
}

function applyBodyOverlay(
  init: RequestInit | undefined,
  overlay: unknown
): RequestInit | undefined {
  if (!isRecord(overlay) || Object.keys(overlay).length === 0) return init
  if (typeof init?.body !== 'string') return init
  try {
    const parsed = JSON.parse(init.body)
    if (!isRecord(parsed)) return init
    return { ...init, body: JSON.stringify(mergeOverlay(parsed, overlay)) }
  } catch {
    return init
  }
}

/**
 * @param options AI SDK provider options from OpenCode (baseURL, headers, ...).
 * @param kiro Kiro wiring. Without it the SDK uses the fetch in `options`,
 *   which only happens for V2's throwaway dynamic-loader instance.
 */
export function createKiroSDK(
  options: Record<string, unknown>,
  kiro?: { baseURL: string; fetch: Fetch; overlay?: unknown }
) {
  const baseURL =
    typeof options.baseURL === 'string' && options.baseURL ? options.baseURL : kiro?.baseURL
  const send: Fetch | undefined =
    kiro?.fetch ?? (typeof options.fetch === 'function' ? (options.fetch as Fetch) : undefined)

  return createOpenAICompatible({
    name: KIRO_SDK_NAME,
    baseURL: baseURL ?? 'https://q.us-east-1.amazonaws.com',
    headers: isRecord(options.headers) ? (options.headers as Record<string, string>) : undefined,
    includeUsage: true,
    fetch: send
      ? (((request: RequestInfo | URL, init?: RequestInit) =>
          send(request, applyBodyOverlay(init, kiro?.overlay))) as typeof fetch)
      : undefined
  })
}
