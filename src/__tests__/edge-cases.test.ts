import { describe, expect, mock, test } from 'bun:test'

// Stateful mock so consecutive calls can resolve prior setConversationId
// entries — mirrors the real DB enough to exercise deriveConversationIds.
const convStore = new Map<string, { convId: string; agentContinuationId: string }>()

mock.module('../plugin/storage/sqlite.js', () => ({
  kiroDb: {
    getConversationId: (_ws: string, fp: string) => convStore.get(fp),
    setConversationId: (_ws: string, fp: string, convId: string, agentContinuationId: string) => {
      convStore.set(fp, { convId, agentContinuationId })
    },
    deleteConversationId: (ws: string, fp: string) => {
      convStore.delete(`${ws}\0${fp}`)
    },
    getAccounts: () => [],
    upsertAccount: () => Promise.resolve(),
    deleteAccount: () => Promise.resolve(),
    batchUpsertAccounts: () => Promise.resolve()
  }
}))

mock.module('../plugin/sync/kiro-cli.js', () => ({
  syncFromKiroCli: () => Promise.resolve(),
  writeToKiroCli: () => Promise.resolve()
}))
mock.module('../kiro/auth.js', () => ({
  decodeRefreshToken: (t: string) => ({ refreshToken: t }),
  encodeRefreshToken: (p: any) => p.refreshToken,
  accessTokenExpired: () => false
}))

import {
  buildHistory,
  collapseAgenticLoops
} from '../infrastructure/transformers/history-builder.js'
import { mergeAdjacentMessages } from '../infrastructure/transformers/message-transformer.js'
import {
  convertToolsToCodeWhisperer,
  createToolNameRegistry,
  deduplicateToolCallsByContent
} from '../infrastructure/transformers/tool-transformer.js'
import { imageCache } from '../plugin/image-cache.js'
import { transformToSdkRequest } from '../plugin/request.js'
import type { KiroAuthDetails } from '../plugin/types.js'

const auth: KiroAuthDetails = {
  refresh: 'refresh',
  access: 'token',
  expires: Date.now() + 3600000,
  authMethod: 'idc',
  region: 'us-east-1',
  email: 'test@test.com',
  profileArn: 'arn:aws:codewhisperer:us-east-1:123:profile/ABC'
}

describe('createToolNameRegistry edge cases', () => {
  test('empty string name', () => {
    const registry = createToolNameRegistry([{ name: '' }])
    expect(() => registry.toOriginalMap()).not.toThrow()
  })

  test('exactly 64 chars stays unchanged', () => {
    const name = 'a'.repeat(64)
    const registry = createToolNameRegistry([{ name }])
    expect(registry.toWire(name)).toBe(name)
  })

  test('65 chars gets a wire alias <=64 chars', () => {
    const name = 'a'.repeat(65)
    const registry = createToolNameRegistry([{ name }])
    const result = registry.toWire(name)
    expect(result.length).toBeLessThanOrEqual(64)
  })

  test('200 chars gets a wire alias <=64 chars', () => {
    const name = 'a'.repeat(200)
    const registry = createToolNameRegistry([{ name }])
    const result = registry.toWire(name)
    expect(result.length).toBeLessThanOrEqual(64)
  })

  test('special chars produce a wire alias <=64 chars', () => {
    const name = '🎉'.repeat(40) + '\n\t' + 'ñ'.repeat(30)
    const registry = createToolNameRegistry([{ name }])
    const result = registry.toWire(name)
    expect(result.length).toBeLessThanOrEqual(64)
  })

  test('different long names produce different wire aliases', () => {
    const a = 'tool_a_'.repeat(20)
    const b = 'tool_b_'.repeat(20)
    const registry = createToolNameRegistry([{ name: a }, { name: b }])
    expect(registry.toWire(a)).not.toBe(registry.toWire(b))
  })

  test('same long name is deterministic', () => {
    const name = 'x'.repeat(100)
    const registry = createToolNameRegistry([{ name }])
    expect(registry.toWire(name)).toBe(registry.toWire(name))
  })

  test('toOriginalMap restores original name from wire alias', () => {
    const name = 'y'.repeat(100)
    const registry = createToolNameRegistry([{ name }])
    const wire = registry.toWire(name)
    const map = registry.toOriginalMap()
    expect(map[wire]).toBe(name)
  })
})

describe('sanitizeSchema via convertToolsToCodeWhisperer', () => {
  test('deeply nested schema strips additionalProperties', () => {
    const tools = [
      {
        name: 'deep',
        description: 'test',
        input_schema: {
          type: 'object',
          additionalProperties: false,
          required: [],
          properties: {
            nested: {
              type: 'object',
              additionalProperties: true,
              required: [],
              properties: {
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    required: [],
                    properties: {
                      value: {
                        anyOf: [
                          { type: 'string', additionalProperties: false, required: [] },
                          { type: 'number', additionalProperties: true }
                        ]
                      }
                    }
                  }
                }
              }
            }
          }
        }
      }
    ]
    const result = convertToolsToCodeWhisperer(tools)
    const json = JSON.stringify(result)
    expect(json).not.toContain('additionalProperties')
    expect(json).not.toContain('"required":[]')
  })

  test('schema with empty required at multiple levels', () => {
    const tools = [
      {
        name: 'req',
        description: 'test',
        input_schema: {
          type: 'object',
          required: [],
          properties: {
            a: { type: 'object', required: [], properties: { b: { type: 'string', required: [] } } }
          }
        }
      }
    ]
    const result = convertToolsToCodeWhisperer(tools)
    expect(JSON.stringify(result)).not.toContain('"required":[]')
  })

  test('schema with ONLY additionalProperties and required:[]', () => {
    const tools = [
      {
        name: 'minimal',
        description: 'test',
        input_schema: { additionalProperties: false, required: [] }
      }
    ]
    const result = convertToolsToCodeWhisperer(tools)
    expect(result[0].toolSpecification.inputSchema.json).toEqual({ type: 'object', properties: {} })
  })

  test('null schema', () => {
    const tools = [{ name: 'n', description: 'test', input_schema: null }]
    expect(() => convertToolsToCodeWhisperer(tools)).not.toThrow()
  })

  test('undefined schema', () => {
    const tools = [{ name: 'u', description: 'test' }]
    expect(() => convertToolsToCodeWhisperer(tools)).not.toThrow()
  })

  test('strips additionalProperties from "not" subschema', () => {
    const tools = [
      {
        name: 'n',
        description: 'test',
        input_schema: { type: 'object', not: { additionalProperties: false, required: [] } }
      }
    ]
    const result = convertToolsToCodeWhisperer(tools)
    expect(JSON.stringify(result)).not.toContain('additionalProperties')
    expect(JSON.stringify(result)).not.toContain('"required":[]')
  })

  test('strips additionalProperties from patternProperties', () => {
    const tools = [
      {
        name: 'p',
        description: 'test',
        input_schema: {
          type: 'object',
          patternProperties: { '^x': { additionalProperties: false, required: [] } }
        }
      }
    ]
    const result = convertToolsToCodeWhisperer(tools)
    expect(JSON.stringify(result)).not.toContain('additionalProperties')
  })

  test('strips additionalProperties from $defs', () => {
    const tools = [
      {
        name: 'd',
        description: 'test',
        input_schema: {
          type: 'object',
          $defs: { foo: { additionalProperties: false, required: [] } }
        }
      }
    ]
    const result = convertToolsToCodeWhisperer(tools)
    expect(JSON.stringify(result)).not.toContain('additionalProperties')
  })

  test('strips additionalProperties from prefixItems', () => {
    const tools = [
      {
        name: 'pi',
        description: 'test',
        input_schema: {
          type: 'array',
          prefixItems: [{ additionalProperties: false }, { additionalProperties: true }]
        }
      }
    ]
    const result = convertToolsToCodeWhisperer(tools)
    expect(JSON.stringify(result)).not.toContain('additionalProperties')
  })

  test('handles circular schema reference without stack overflow', () => {
    const obj: any = { type: 'object', additionalProperties: false, properties: {} }
    obj.properties.self = obj
    const tools = [{ name: 'c', description: 'test', input_schema: obj }]
    expect(() => convertToolsToCodeWhisperer(tools)).not.toThrow()
  })

  test('does not mutate input schema', () => {
    const original = {
      type: 'object',
      additionalProperties: false,
      required: [],
      properties: { x: { type: 'string', additionalProperties: false } }
    }
    const before = JSON.stringify(original)
    convertToolsToCodeWhisperer([{ name: 't', description: 't', input_schema: original }])
    expect(JSON.stringify(original)).toBe(before)
  })
})

describe('payload trim preserves valid structure', () => {
  test('oversized payload trimmed below Kiro threshold', () => {
    const messages: any[] = []
    // ~9MB of raw history so trimming must kick in (default cap is 4MB).
    for (let i = 0; i < 300; i++) {
      messages.push({ role: 'user', content: 'x'.repeat(10000) })
      messages.push({
        role: 'assistant',
        content: [
          { type: 'text', text: 'y'.repeat(5000) },
          { type: 'tool_use', id: `tool-${i}`, name: 'myTool', input: { q: 'test' } }
        ]
      })
    }
    messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'tool-299', content: 'result' }]
    })
    messages.push({ role: 'user', content: 'final question' })

    const body = {
      messages,
      tools: [{ name: 'myTool', description: 'a tool', input_schema: { type: 'object' } }]
    }
    const result = transformToSdkRequest(body, 'auto', auth)
    const payload = JSON.stringify(result.conversationState)
    expect(payload.length).toBeLessThanOrEqual(4_000_000)
  })

  test('respects a custom max_payload_bytes override', () => {
    const messages: any[] = []
    for (let i = 0; i < 80; i++) {
      messages.push({ role: 'user', content: 'x'.repeat(10000) })
      messages.push({ role: 'assistant', content: 'y'.repeat(10000) })
    }
    messages.push({ role: 'user', content: 'final question' })

    // Force a tight 500KB cap via the maxPayloadBytes argument.
    const result = transformToSdkRequest(
      { messages },
      'auto',
      auth,
      false,
      20000,
      undefined,
      '',
      true,
      undefined,
      undefined,
      500_000
    )
    const payload = JSON.stringify(result.conversationState)
    expect(payload.length).toBeLessThanOrEqual(500_000)
  })

  test('history starts with userInputMessage after trim', () => {
    const messages: any[] = []
    for (let i = 0; i < 80; i++) {
      messages.push({ role: 'user', content: 'x'.repeat(10000) })
      messages.push({ role: 'assistant', content: 'y'.repeat(10000) })
    }
    messages.push({ role: 'user', content: 'final' })

    const body = { messages }
    const result = transformToSdkRequest(body, 'auto', auth)
    const history = result.conversationState.history
    if (history && history.length > 0) {
      expect(history[0]!.userInputMessage).toBeDefined()
    }
  })

  test('toolResults have matching toolUseIds in history after trim', () => {
    const messages: any[] = []
    for (let i = 0; i < 40; i++) {
      messages.push({ role: 'user', content: 'x'.repeat(20000) })
      messages.push({
        role: 'assistant',
        content: [
          { type: 'text', text: 'y'.repeat(5000) },
          { type: 'tool_use', id: `t-${i}`, name: 'myTool', input: { q: 'test' } }
        ]
      })
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `t-${i}`, content: 'result '.repeat(1000) }]
      })
    }
    messages.push({ role: 'user', content: 'final' })

    const body = {
      messages,
      tools: [{ name: 'myTool', description: 'd', input_schema: { type: 'object' } }]
    }
    const result = transformToSdkRequest(body, 'auto', auth)
    const history = result.conversationState.history || []

    const allToolUseIds = new Set<string>()
    for (const h of history) {
      if (h.assistantResponseMessage?.toolUses) {
        for (const tu of h.assistantResponseMessage.toolUses) allToolUseIds.add(tu.toolUseId)
      }
    }
    for (const h of history) {
      if (h.userInputMessage?.userInputMessageContext?.toolResults) {
        for (const tr of h.userInputMessage.userInputMessageContext.toolResults) {
          expect(allToolUseIds.has(tr.toolUseId)).toBe(true)
        }
      }
    }
  })
})

describe('mergeAdjacentMessages edge cases', () => {
  test('empty array', () => {
    expect(mergeAdjacentMessages([])).toEqual([])
  })

  test('assistant string + assistant array with tool_use', () => {
    const msgs = [
      { role: 'assistant', content: 'hello' },
      { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: 'x', input: {} }] }
    ]
    const result = mergeAdjacentMessages(msgs)
    expect(result).toHaveLength(1)
    expect(result[0].content).toContainEqual({ type: 'tool_use', id: '1', name: 'x', input: {} })
  })

  test('assistant with tool_calls + assistant with tool_calls', () => {
    const msgs = [
      {
        role: 'assistant',
        content: 'a',
        tool_calls: [{ id: '1', function: { name: 'x', arguments: '{}' } }]
      },
      {
        role: 'assistant',
        content: 'b',
        tool_calls: [{ id: '2', function: { name: 'y', arguments: '{}' } }]
      }
    ]
    const result = mergeAdjacentMessages(msgs)
    expect(result).toHaveLength(1)
    expect(result[0].tool_calls).toHaveLength(2)
  })

  test('user string + user array', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'user', content: [{ type: 'text', text: 'world' }] }
    ]
    const result = mergeAdjacentMessages(msgs)
    expect(result).toHaveLength(1)
    expect(Array.isArray(result[0].content)).toBe(true)
  })

  test('3 consecutive same-role messages', () => {
    const msgs = [
      { role: 'assistant', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'assistant', content: 'c' }
    ]
    const result = mergeAdjacentMessages(msgs)
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe('a\nb\nc')
  })
})

describe('buildHistory with null/undefined content', () => {
  test('assistant with content: null', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: null },
      { role: 'user', content: 'bye' }
    ]
    expect(() => buildHistory(msgs, 'model')).not.toThrow()
  })

  test('assistant with content: undefined', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: undefined },
      { role: 'user', content: 'bye' }
    ]
    expect(() => buildHistory(msgs, 'model')).not.toThrow()
  })

  test('user with content: null', () => {
    const msgs = [
      { role: 'user', content: null },
      { role: 'user', content: 'bye' }
    ]
    expect(() => buildHistory(msgs, 'model')).not.toThrow()
  })

  test('assistant with empty tool_calls array', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'text', tool_calls: [] },
      { role: 'user', content: 'bye' }
    ]
    const history = buildHistory(msgs, 'model')
    const asst = history.find((h) => h.assistantResponseMessage)
    expect(asst?.assistantResponseMessage?.toolUses).toBeUndefined()
  })

  test('assistant with tool_use where name is undefined', () => {
    const msgs = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'tool_use', id: '1', name: undefined, input: {} }] },
      { role: 'user', content: 'bye' }
    ]
    expect(() => buildHistory(msgs, 'model')).not.toThrow()
  })
})

describe('collapseAgenticLoops edge cases', () => {
  test('single assistant+user pair passes through unchanged', () => {
    const history = [
      {
        assistantResponseMessage: {
          content: 'text',
          toolUses: [{ name: 'x', toolUseId: '1', input: {} }]
        }
      },
      {
        userInputMessage: {
          content: 'result',
          userInputMessageContext: {
            toolResults: [{ toolUseId: '1', content: [{ text: 'r' }], status: 'success' }]
          }
        }
      }
    ]
    const result = collapseAgenticLoops(history as any)
    expect(result).toHaveLength(2)
    expect(result[0]!.assistantResponseMessage?.content).toBe('text')
  })

  test('assistant with toolUses without following user passes through', () => {
    const history = [
      { userInputMessage: { content: 'hi' } },
      {
        assistantResponseMessage: {
          content: 'text',
          toolUses: [{ name: 'x', toolUseId: '1', input: {} }]
        }
      }
    ]
    const result = collapseAgenticLoops(history as any)
    expect(result).toHaveLength(2)
  })

  test('3 pairs collapse correctly', () => {
    const history = [
      {
        assistantResponseMessage: {
          content: 'first',
          toolUses: [{ name: 'a', toolUseId: '1', input: {} }]
        }
      },
      {
        userInputMessage: {
          content: 'r1',
          userInputMessageContext: {
            toolResults: [{ toolUseId: '1', content: [{ text: 'r' }], status: 'success' }]
          }
        }
      },
      {
        assistantResponseMessage: {
          content: 'second',
          toolUses: [{ name: 'b', toolUseId: '2', input: {} }]
        }
      },
      {
        userInputMessage: {
          content: 'r2',
          userInputMessageContext: {
            toolResults: [{ toolUseId: '2', content: [{ text: 'r' }], status: 'success' }]
          }
        }
      },
      {
        assistantResponseMessage: {
          content: 'third',
          toolUses: [{ name: 'c', toolUseId: '3', input: {} }]
        }
      },
      {
        userInputMessage: {
          content: 'r3',
          userInputMessageContext: {
            toolResults: [{ toolUseId: '3', content: [{ text: 'r' }], status: 'success' }]
          }
        }
      }
    ]
    const result = collapseAgenticLoops(history as any)
    expect(result[0]!.assistantResponseMessage?.content).toBe('first')
    expect(result[2]!.assistantResponseMessage?.content).toBe('[system: tool calling continues]')
    expect(result[4]!.assistantResponseMessage?.content).toBe('[system: tool calling continues]')
  })
})

describe('deduplicateToolCallsByContent edge cases', () => {
  test('same name different string inputs kept', () => {
    const calls = [
      { name: 'tool', input: 'input1' },
      { name: 'tool', input: 'input2' }
    ]
    expect(deduplicateToolCallsByContent(calls)).toHaveLength(2)
  })

  test('same name same string input deduplicated', () => {
    const calls = [
      { name: 'tool', input: 'same' },
      { name: 'tool', input: 'same' }
    ]
    expect(deduplicateToolCallsByContent(calls)).toHaveLength(1)
  })

  test('empty array', () => {
    expect(deduplicateToolCallsByContent([])).toEqual([])
  })

  test('separator collision: name="a-b" input="c" vs name="a" input="b-c"', () => {
    // Old impl used `${name}-${input}` so these would collapse to "a-b-c".
    const calls = [
      { name: 'a-b', input: 'c' },
      { name: 'a', input: 'b-c' }
    ]
    expect(deduplicateToolCallsByContent(calls)).toHaveLength(2)
  })

  test('object input is stringified before compare', () => {
    const calls = [
      { name: 'tool', input: { x: 1 } },
      { name: 'tool', input: { x: 1 } },
      { name: 'tool', input: { x: 2 } }
    ]
    expect(deduplicateToolCallsByContent(calls)).toHaveLength(2)
  })
})

describe('convertToolsToCodeWhisperer edge cases', () => {
  test('empty tools array', () => {
    expect(convertToolsToCodeWhisperer([])).toEqual([])
  })

  test('tool with undefined name', () => {
    const tools = [{ description: 'test', input_schema: { type: 'object' } }]
    expect(() => convertToolsToCodeWhisperer(tools)).not.toThrow()
  })

  test('tool with description >1024 chars truncated', () => {
    const tools = [
      { name: 'big', description: 'x'.repeat(10000), input_schema: { type: 'object' } }
    ]
    const result = convertToolsToCodeWhisperer(tools)
    expect(result[0].toolSpecification.description.length).toBe(1024)
  })

  test('tool with empty input_schema', () => {
    const tools = [{ name: 'empty', description: 'test', input_schema: {} }]
    const result = convertToolsToCodeWhisperer(tools)
    expect(result[0].toolSpecification.inputSchema.json).toEqual({ type: 'object', properties: {} })
  })
})

describe('createToolNameRegistry with tool lists', () => {
  test('empty tools array', () => {
    const registry = createToolNameRegistry([])
    expect(registry.toWire('anything')).toBeDefined()
  })

  test('two tools with same name', () => {
    const tools = [{ name: 'dup' }, { name: 'dup' }]
    expect(() => createToolNameRegistry(tools)).not.toThrow()
    const registry = createToolNameRegistry(tools)
    expect(registry.toWire('dup')).toBe('dup')
  })

  test('tool with undefined name skipped', () => {
    const tools = [{ name: undefined }, { name: 'valid' }]
    const registry = createToolNameRegistry(tools)
    expect(registry.toWire('valid')).toBe('valid')
  })
})

describe('history alternation after trim', () => {
  test('after splice first entry is userInputMessage', () => {
    const messages: any[] = []
    for (let i = 0; i < 100; i++) {
      messages.push({ role: 'user', content: 'u'.repeat(8000) })
      messages.push({ role: 'assistant', content: 'a'.repeat(8000) })
    }
    messages.push({ role: 'user', content: 'final' })

    const body = { messages }
    const result = transformToSdkRequest(body, 'auto', auth)
    const history = result.conversationState.history
    if (history && history.length > 0) {
      expect(history[0]!.userInputMessage).toBeDefined()
      expect(history[0]!.assistantResponseMessage).toBeUndefined()
    }
  })

  test('remaining history alternates after trim', () => {
    const messages: any[] = []
    for (let i = 0; i < 100; i++) {
      messages.push({ role: 'user', content: 'u'.repeat(8000) })
      messages.push({ role: 'assistant', content: 'a'.repeat(8000) })
    }
    messages.push({ role: 'user', content: 'final' })

    const body = { messages }
    const result = transformToSdkRequest(body, 'auto', auth)
    const history = result.conversationState.history || []
    for (let i = 0; i < history.length - 1; i++) {
      const curr = history[i]!
      const next = history[i + 1]!
      if (curr.userInputMessage) {
        expect(next.assistantResponseMessage).toBeDefined()
      }
      if (curr.assistantResponseMessage) {
        expect(next.userInputMessage).toBeDefined()
      }
    }
  })
})

describe('fingerprint stability across image-strip', () => {
  // Regression: OpenCode strips image parts from the conversation state across
  // agentic turns. If the fingerprint depended on the full content (incl.
  // base64 image bytes), the convId cache and the image-carry-forward cache
  // would both miss after the first turn — which is exactly the bug we saw.
  test('same first-user-message text produces the same fingerprint with or without image parts', () => {
    const withImages = transformToSdkRequest(
      {
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'Here is the design' },
              {
                type: 'image_url',
                image_url: {
                  url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
                }
              }
            ]
          }
        ]
      },
      'auto',
      auth,
      false,
      0,
      undefined,
      '/ws-fp-stability',
      false
    )

    const withoutImages = transformToSdkRequest(
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'text', text: 'Here is the design' }]
          }
        ]
      },
      'auto',
      auth,
      false,
      0,
      undefined,
      '/ws-fp-stability',
      false
    )

    expect(withImages.conversationKey.fingerprint).toBe(withoutImages.conversationKey.fingerprint)
  })
})

describe('image carry-forward: no images on tool-result turns', () => {
  function seedCache(workspace: string, firstUserText: string) {
    const crypto = require('crypto')
    const fingerprint = crypto
      .createHash('sha256')
      .update(workspace + '\0' + firstUserText)
      .digest('hex')
      .slice(0, 32)
    imageCache.set(workspace, fingerprint, [
      { format: 'png', source: { bytes: new Uint8Array([137, 80, 78, 71]) } }
    ])
  }

  test('images are NOT carried forward onto a tool-result turn', () => {
    const workspace = '/ws-carry-fwd-toolresult'
    seedCache(workspace, 'look at this')

    const result = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'look at this' }] },
          {
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tu_1', name: 'think', input: { thought: 'thinking' } }
            ]
          },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'done' }]
          }
        ]
      },
      'auto',
      auth,
      false,
      0,
      undefined,
      workspace,
      true
    )

    const uim = result.conversationState.currentMessage?.userInputMessage as any
    expect((uim?.userInputMessageContext?.toolResults ?? []).length).toBeGreaterThan(0)
    expect((uim?.images ?? []).length).toBe(0)
  })

  test('images ARE carried forward on a normal (non-tool-result) turn', () => {
    const workspace = '/ws-carry-fwd-normal'
    seedCache(workspace, 'look at this')

    const result = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'look at this' }] },
          { role: 'assistant', content: 'I see it.' },
          { role: 'user', content: 'What color is it?' }
        ]
      },
      'auto',
      auth,
      false,
      0,
      undefined,
      workspace,
      true
    )

    const uim = result.conversationState.currentMessage?.userInputMessage as any
    expect((uim?.images ?? []).length).toBeGreaterThan(0)
  })
})

describe('payload trim performance', () => {
  test('trims very large history in <50ms', () => {
    // 500 user/asst pairs of 10KB each = ~10MB raw — over the 4MB default cap,
    // so trimming runs and would be O(N²) without the incremental accounting.
    const messages: any[] = []
    for (let i = 0; i < 500; i++) {
      messages.push({ role: 'user', content: 'u'.repeat(10000) })
      messages.push({ role: 'assistant', content: 'a'.repeat(10000) })
    }
    messages.push({ role: 'user', content: 'final' })

    const start = performance.now()
    const result = transformToSdkRequest({ messages }, 'auto', auth)
    const elapsed = performance.now() - start

    // Result must still be under the limit.
    const size = JSON.stringify(result.conversationState).length
    expect(size).toBeLessThanOrEqual(4_000_000)
    // Allow 100ms on slow CI; fail if we regress to seconds (O(N²)).
    expect(elapsed).toBeLessThan(100)
  })
})

// ── Session ID isolation ──────────────────────────────────────────────────────

describe('parallel sessions in same workspace get distinct convIds', () => {
  test('different sessionId → different convId (cache key prefix)', () => {
    const body = {
      messages: [{ role: 'user', content: 'hello' }]
    }
    const r1 = transformToSdkRequest(
      body,
      'auto',
      auth,
      false,
      16000,
      undefined,
      '',
      true,
      'sess-A'
    )
    const r2 = transformToSdkRequest(
      body,
      'auto',
      auth,
      false,
      16000,
      undefined,
      '',
      true,
      'sess-B'
    )
    expect(r1.conversationId).not.toBe(r2.conversationId)
    expect(r1.conversationKey.workspace).toBe('sess:sess-A')
    expect(r2.conversationKey.workspace).toBe('sess:sess-B')
  })

  test('same sessionId + same prompt → same convId on second call', () => {
    const body = {
      messages: [{ role: 'user', content: 'hello' }]
    }
    const r1 = transformToSdkRequest(
      body,
      'auto',
      auth,
      false,
      16000,
      undefined,
      '',
      true,
      'sess-X'
    )
    const r2 = transformToSdkRequest(
      body,
      'auto',
      auth,
      false,
      16000,
      undefined,
      '',
      true,
      'sess-X'
    )
    expect(r1.conversationId).toBe(r2.conversationId)
  })

  test('no sessionId falls back to workspace as cache key', () => {
    const body = {
      messages: [{ role: 'user', content: 'hello' }]
    }
    const r1 = transformToSdkRequest(body, 'auto', auth, false, 16000, undefined, '/some/dir', true)
    expect(r1.conversationKey.workspace).toBe('/some/dir')
  })
})
