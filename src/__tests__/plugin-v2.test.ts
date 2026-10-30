import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { ResponseHandler } from '../core/request/response-handler.js'
import { buildV2Models, buildV2ProviderInfo, KIRO_V2_PACKAGE } from '../plugin-v2.js'
import { THINKING_BUDGETS } from '../plugin/effort.js'
import { buildModelRegistry } from '../plugin/model-registry.js'
import { KIRO_PROVIDER_ID } from '../runtime.js'
import * as v2Sdk from '../v2-sdk.js'
import { createKiroSDK, KIRO_SDK_NAME, mergeOverlay } from '../v2-sdk.js'

const BASE_URL = 'https://q.us-east-1.amazonaws.com'

function kiroStream(events: any[]) {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
    })()
  }
}

/** Drive the V2 SDK the way OpenCode does and collect the stream parts. */
async function stream(input: {
  events: any[]
  overlay?: unknown
  providerOptions?: Record<string, any>
}) {
  const bodies: any[] = []
  const urls: string[] = []
  const sdk = createKiroSDK(
    { baseURL: BASE_URL, name: 'kiro' },
    {
      baseURL: BASE_URL,
      overlay: input.overlay,
      fetch: async (url, init) => {
        urls.push(String(url))
        bodies.push(JSON.parse(String(init?.body)))
        return new ResponseHandler().handleSdkSuccess(
          kiroStream(input.events),
          'claude-opus-5',
          'conversation-1',
          true
        )
      }
    }
  )

  const result = await sdk.languageModel('claude-opus-5-thinking').doStream({
    prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    providerOptions: input.providerOptions
  } as any)

  const parts: any[] = []
  const reader = result.stream.getReader()
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    parts.push(value)
  }

  const join = (type: string) =>
    parts
      .filter((p) => p.type === type)
      .map((p) => p.delta)
      .join('')

  return { parts, bodies, urls, reasoning: join('reasoning-delta'), text: join('text-delta') }
}

describe('OpenCode V2 provider', () => {
  test('registers an enabled AI SDK provider pointing at the Kiro base URL', () => {
    const info = buildV2ProviderInfo(BASE_URL) as any
    expect(info.id).toBe('kiro')
    expect(info.activation).toBe('enabled')
    expect(info.package).toBe(KIRO_V2_PACKAGE)
    expect(info.settings).toEqual({ baseURL: BASE_URL })
  })

  test('names the SDK module by file URL so V2 never rewrites it to a native route', () => {
    // V2 maps `aisdk:@ai-sdk/openai-compatible` onto its native route, which
    // skips the sdk hook and sends requests straight to the Kiro endpoint.
    expect(KIRO_V2_PACKAGE.startsWith('aisdk:file://')).toBe(true)
    expect(KIRO_V2_PACKAGE.endsWith('/v2-sdk.js')).toBe(true)
    // Tests run from src/ (.ts); the published dist/ holds the .js sibling.
    const path = fileURLToPath(KIRO_V2_PACKAGE.slice('aisdk:'.length))
    expect(existsSync(path) || existsSync(path.replace(/\.js$/, '.ts'))).toBe(true)
  })

  test('the SDK name matches the provider ID V2 keys provider options by', () => {
    // V2 passes variant settings as providerOptions[providerID] for file:// packages,
    // and the openai-compatible SDK reads providerOptions[name].
    expect(KIRO_SDK_NAME).toBe(KIRO_PROVIDER_ID)
  })

  test('every model pins the SDK package so user config cannot reroute it', () => {
    for (const model of buildV2Models() as any[]) expect(model.package).toBe(KIRO_V2_PACKAGE)
  })

  test('the SDK module exposes a create* factory for the V2 dynamic loader', () => {
    const factories = Object.keys(v2Sdk).filter((name) => name.startsWith('create'))
    expect(factories).toEqual(['createKiroSDK'])
    const sdk = (v2Sdk as any)[factories[0]!]({ baseURL: BASE_URL })
    expect(typeof sdk.languageModel).toBe('function')
  })

  test('advertises the same models as the V1 registry', () => {
    const v1 = buildModelRegistry() as Record<string, any>
    const v2 = buildV2Models() as any[]
    expect(v2.map((m) => m.id).sort()).toEqual(Object.keys(v1).sort())

    for (const model of v2) {
      expect(model.providerID).toBe('kiro')
      expect(model.modelID).toBe(model.id)
      expect(model.name).toBe(v1[model.id].name)
      expect(model.limit).toEqual(v1[model.id].limit)
      expect(model.capabilities.input).toEqual(v1[model.id].modalities.input)
      expect(model.capabilities.tools).toBe(true)
      expect(model.enabled).toBe(true)
      // V2 ignores the V1-only reasoning flags; reasoning comes from the stream.
      expect(model.reasoning).toBeUndefined()
      expect(model.interleaved).toBeUndefined()
    }
  })

  test('turns V1 thinking variants into V2 variant settings', () => {
    const v1 = buildModelRegistry() as Record<string, any>
    const opus = (buildV2Models() as any[]).find((m) => m.id === 'claude-opus-5-thinking')
    expect(opus.variants.map((v: any) => v.id)).toEqual(
      Object.keys(v1['claude-opus-5-thinking'].variants)
    )
    expect(opus.variants.find((v: any) => v.id === 'xhigh').settings).toEqual({
      thinkingConfig: { thinkingBudget: THINKING_BUDGETS.xhigh }
    })

    const plain = (buildV2Models() as any[]).find((m) => m.id === 'claude-opus-5')
    expect(plain.variants).toEqual([])
  })
})

describe('OpenCode V2 SDK', () => {
  test('routes requests through the plugin fetch and streams reasoning and text', async () => {
    const { urls, reasoning, text, parts } = await stream({
      events: [
        { reasoningContentEvent: { text: 'weighing ' } },
        { reasoningContentEvent: { text: 'options' } },
        { assistantResponseEvent: { content: 'Hello!' } }
      ]
    })

    expect(urls).toEqual([`${BASE_URL}/chat/completions`])
    expect(reasoning).toBe('weighing options')
    expect(text).toBe('Hello!')
    expect(parts.some((p) => p.type === 'finish')).toBe(true)
  })

  test('streams tool calls in the shape the AI SDK expects', async () => {
    const { parts } = await stream({
      events: [
        { toolUseEvent: { toolUseId: 't1', name: 'read', input: '{"path":' } },
        { toolUseEvent: { toolUseId: 't1', name: 'read', input: '"a.ts"}', stop: true } }
      ]
    })

    const call = parts.find((p) => p.type === 'tool-call')
    expect(call?.toolName).toBe('read')
    expect(JSON.parse(call?.input)).toEqual({ path: 'a.ts' })
  })

  test('sends variant settings as provider options in the request body', async () => {
    const { bodies } = await stream({
      events: [{ assistantResponseEvent: { content: 'ok' } }],
      providerOptions: { kiro: { thinkingConfig: { thinkingBudget: THINKING_BUDGETS.xhigh } } }
    })

    expect(bodies[0].thinkingConfig).toEqual({ thinkingBudget: THINKING_BUDGETS.xhigh })
    expect(bodies[0].model).toBe('claude-opus-5-thinking')
    expect(bodies[0].stream).toBe(true)
  })

  test('merges a V2 body overlay into the request body', async () => {
    const { bodies } = await stream({
      events: [{ assistantResponseEvent: { content: 'ok' } }],
      overlay: { thinkingConfig: { thinkingBudget: THINKING_BUDGETS.low } }
    })

    expect(bodies[0].thinkingConfig).toEqual({ thinkingBudget: THINKING_BUDGETS.low })
    expect(bodies[0].messages.length).toBeGreaterThan(0)
  })
})

describe('mergeOverlay', () => {
  test('merges objects recursively and replaces arrays and scalars', () => {
    expect(
      mergeOverlay({ a: { b: 1, c: [1, 2] }, d: 'x', keep: true }, { a: { c: [3], e: 2 }, d: 'y' })
    ).toEqual({ a: { b: 1, c: [3], e: 2 }, d: 'y', keep: true })
  })
})
