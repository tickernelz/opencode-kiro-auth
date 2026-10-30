import { describe, expect, test } from 'bun:test'
import { KIRO_V2_PACKAGE, setupKiroV2 } from '../plugin-v2.js'
import type { KiroRuntime } from '../runtime.js'

const BASE_URL = 'https://q.us-east-1.amazonaws.com'

/** A plugin context that records every transform and hook callback. */
function fakeContext() {
  const recorded = {
    integration: [] as Array<(editor: any) => void>,
    provider: [] as Array<(editor: any) => void>,
    tool: [] as Array<(editor: any) => void>,
    sdkHooks: [] as Array<{ callback: (event: any) => void; options: any }>,
    toolReloads: 0
  }
  const registration = { dispose: async () => {} }
  const ctx = {
    location: { directory: '/tmp/project' },
    integration: {
      transform: async (cb: any) => (recorded.integration.push(cb), registration)
    },
    provider: { transform: async (cb: any) => (recorded.provider.push(cb), registration) },
    tool: {
      transform: async (cb: any) => (recorded.tool.push(cb), registration),
      reload: async () => {
        recorded.toolReloads++
      }
    },
    aisdk: {
      hook: async (name: string, callback: any, options: any) => {
        if (name === 'sdk') recorded.sdkHooks.push({ callback, options })
        return registration
      }
    }
  }
  return { ctx: ctx as any, recorded }
}

function fakeRuntime(input: { profileArn?: string; webSearch?: boolean } = {}) {
  const requests: Array<{ url: string; body: any }> = []
  const runtime = {
    config: { web_search_enabled: input.webSearch ?? true, default_region: 'us-east-1' },
    repository: {},
    accountManager: {
      getCurrentOrNext: () => (input.profileArn ? { profileArn: input.profileArn } : { id: 'a' })
    },
    authHandler: { initialize: async () => {} },
    requestHandler: {
      handle: async (url: any, init: any) => {
        requests.push({ url: String(url), body: JSON.parse(init.body) })
        return new Response('{}', { status: 500 })
      }
    },
    baseURL: BASE_URL
  } as unknown as KiroRuntime
  return { runtime, requests }
}

/** Replay a recorded transform against a minimal editor and capture its writes. */
function runEditor(callbacks: Array<(editor: any) => void>) {
  const added: any[] = []
  const methods: any[] = []
  const integrations = new Map<string, any>()
  const editor = {
    add: (value: any) => added.push(value),
    update: (id: string, update: (value: any) => void) => {
      const current = integrations.get(id) ?? { id, name: id }
      update(current)
      integrations.set(id, current)
    },
    method: { update: (value: any) => methods.push(value) }
  }
  for (const cb of callbacks) cb(editor)
  return { added, methods, integrations }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('setupKiroV2', () => {
  test('registers the kiro provider with every model pinned to the plugin SDK', async () => {
    const { ctx, recorded } = fakeContext()
    await setupKiroV2(ctx, async () => fakeRuntime().runtime)

    const { added } = runEditor(recorded.provider)
    expect(added).toHaveLength(1)
    expect(added[0].info).toMatchObject({
      id: 'kiro',
      activation: 'enabled',
      package: KIRO_V2_PACKAGE
    })
    expect(added[0].models.length).toBeGreaterThan(0)
    for (const model of added[0].models) expect(model.package).toBe(KIRO_V2_PACKAGE)
  })

  test('registers both login methods with forms V2 can validate', async () => {
    const { ctx, recorded } = fakeContext()
    await setupKiroV2(ctx, async () => fakeRuntime().runtime)

    const { methods, integrations } = runEditor(recorded.integration)
    expect(integrations.get('kiro')?.name).toBe('Kiro')
    expect(methods.map((m) => m.method.id)).toEqual(['idc', 'idc-profile'])

    const keys = (m: any) => m.method.form.map((f: any) => f.key)
    expect(keys(methods[0])).toEqual(['start_url', 'idc_region'])
    expect(keys(methods[1])).toEqual(['start_url', 'idc_region', 'profile_arn'])

    for (const method of methods) {
      expect(method.integrationID).toBe('kiro')
      for (const field of method.method.form) {
        expect(field.type).toBe('string')
        // Every pattern must accept a blank answer, which means "use the default".
        expect(new RegExp(field.pattern).test('')).toBe(true)
      }
    }
  })

  test('rejects invalid login input before starting a device flow', async () => {
    const { ctx, recorded } = fakeContext()
    await setupKiroV2(ctx, async () => fakeRuntime().runtime)
    const [idc] = runEditor(recorded.integration).methods

    const field = (key: string) => idc.method.form.find((f: any) => f.key === key)
    expect(new RegExp(field('start_url').pattern).test('not-a-url')).toBe(false)
    expect(new RegExp(field('idc_region').pattern).test('mars')).toBe(false)
    await expect(idc.authorize({ start_url: 'not-a-url' })).rejects.toThrow('valid URL')
    await expect(idc.authorize({ idc_region: 'mars' })).rejects.toThrow('valid AWS region')
  })

  test('the sdk hook only claims kiro models and routes them through the request handler', async () => {
    const { ctx, recorded } = fakeContext()
    const { runtime, requests } = fakeRuntime()
    await setupKiroV2(ctx, async () => runtime)

    expect(recorded.sdkHooks).toHaveLength(1)
    const [{ callback, options }] = recorded.sdkHooks as [any]
    expect(options).toEqual({ providerID: 'kiro' })

    const other = { model: { providerID: 'anthropic' }, options: {} } as any
    callback(other)
    expect(other.sdk).toBeUndefined()

    const event = {
      model: { providerID: 'kiro', body: { thinkingConfig: { thinkingBudget: 1024 } } },
      options: { baseURL: BASE_URL }
    } as any
    callback(event)
    expect(typeof event.sdk?.languageModel).toBe('function')

    await event.sdk
      .languageModel('claude-opus-5-thinking')
      .doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }] })
      .catch(() => {})
    expect(requests).toHaveLength(1)
    expect(requests[0]!.url).toBe(`${BASE_URL}/chat/completions`)
    expect(requests[0]!.body.thinkingConfig).toEqual({ thinkingBudget: 1024 })
  })

  test('offers web search only to Pro accounts and reloads tools once accounts sync', async () => {
    const free = fakeContext()
    await setupKiroV2(free.ctx, async () => fakeRuntime().runtime)
    expect(runEditor(free.recorded.tool).added).toHaveLength(0)

    const pro = fakeContext()
    await setupKiroV2(pro.ctx, async () => fakeRuntime({ profileArn: 'arn:aws:x' }).runtime)
    const tools = runEditor(pro.recorded.tool).added
    expect(tools.map((t) => t.name)).toEqual(['kiro_web_search'])
    expect(tools[0].input.required).toEqual(['query'])

    await flush()
    expect(pro.recorded.toolReloads).toBe(1)
  })
})
