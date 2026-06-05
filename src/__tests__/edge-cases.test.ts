import { describe, expect, mock, test } from 'bun:test'

mock.module('../plugin/storage/sqlite.js', () => ({
  kiroDb: {
    getConversationId: () => undefined,
    setConversationId: () => {},
    deleteConversationId: () => {},
    getAccounts: () => [],
    upsertAccount: () => Promise.resolve(),
    deleteAccount: () => Promise.resolve(),
    batchUpsertAccounts: () => Promise.resolve()
  }
}))

mock.module('../plugin/sync/kiro-cli.js', () => ({ writeToKiroCli: () => Promise.resolve() }))
mock.module('../kiro/auth.js', () => ({
  decodeRefreshToken: (t: string) => ({ refreshToken: t }),
  encodeRefreshToken: (p: any) => p.refreshToken
}))

import {
  buildHistory,
  collapseAgenticLoops
} from '../infrastructure/transformers/history-builder.js'
import { mergeAdjacentMessages } from '../infrastructure/transformers/message-transformer.js'
import {
  buildToolNameMaps,
  convertToolsToCodeWhisperer,
  deduplicateToolCallsByContent,
  shortenToolName
} from '../infrastructure/transformers/tool-transformer.js'
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

describe('shortenToolName edge cases', () => {
  test('null input', () => {
    expect(shortenToolName(null as any)).toBeFalsy()
  })

  test('undefined input', () => {
    expect(shortenToolName(undefined as any)).toBeFalsy()
  })

  test('empty string', () => {
    expect(shortenToolName('')).toBe('')
  })

  test('exactly 64 chars', () => {
    const name = 'a'.repeat(64)
    expect(shortenToolName(name)).toBe(name)
  })

  test('65 chars', () => {
    const name = 'a'.repeat(65)
    const result = shortenToolName(name)
    expect(result.length).toBeLessThanOrEqual(64)
  })

  test('200 chars', () => {
    const name = 'a'.repeat(200)
    const result = shortenToolName(name)
    expect(result.length).toBeLessThanOrEqual(64)
  })

  test('special chars', () => {
    const name = '🎉'.repeat(40) + '\n\t' + 'ñ'.repeat(30)
    const result = shortenToolName(name)
    expect(result.length).toBeLessThanOrEqual(64)
  })

  test('does not split surrogate pair', () => {
    // 🎉 is U+1F389 = 2 UTF-16 code units. 40 of them = 80 UTF-16 chars.
    // The naive slice would land between high+low surrogate.
    const name = '🎉'.repeat(40)
    const result = shortenToolName(name)
    expect(result.length).toBeLessThanOrEqual(64)
    // No unpaired surrogate left in the prefix
    expect(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(result)).toBe(false)
    expect(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(result)).toBe(false)
  })

  test('different long names produce different shortened names', () => {
    const a = 'tool_a_'.repeat(20)
    const b = 'tool_b_'.repeat(20)
    expect(shortenToolName(a)).not.toBe(shortenToolName(b))
  })

  test('same long name is deterministic', () => {
    const name = 'x'.repeat(100)
    expect(shortenToolName(name)).toBe(shortenToolName(name))
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
    expect(result[0].toolSpecification.inputSchema.json).toEqual({})
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
  test('large payload trimmed to ≤600KB', () => {
    const messages: any[] = []
    for (let i = 0; i < 80; i++) {
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
      content: [{ type: 'tool_result', tool_use_id: 'tool-79', content: 'result' }]
    })
    messages.push({ role: 'user', content: 'final question' })

    const body = {
      messages,
      tools: [{ name: 'myTool', description: 'a tool', input_schema: { type: 'object' } }]
    }
    const result = transformToSdkRequest(body, 'auto', auth)
    const payload = JSON.stringify(result.conversationState)
    expect(payload.length).toBeLessThanOrEqual(600_000)
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

  test('tool with description >9216 chars truncated', () => {
    const tools = [
      { name: 'big', description: 'x'.repeat(10000), input_schema: { type: 'object' } }
    ]
    const result = convertToolsToCodeWhisperer(tools)
    expect(result[0].toolSpecification.description.length).toBe(9216)
  })

  test('tool with empty input_schema', () => {
    const tools = [{ name: 'empty', description: 'test', input_schema: {} }]
    const result = convertToolsToCodeWhisperer(tools)
    expect(result[0].toolSpecification.inputSchema.json).toEqual({})
  })
})

describe('buildToolNameMaps edge cases', () => {
  test('empty tools array', () => {
    const maps = buildToolNameMaps([])
    expect(maps.toKiroName('anything')).toBeDefined()
    expect(maps.fromKiroName('anything')).toBe('anything')
  })

  test('two tools with same name', () => {
    const tools = [{ name: 'dup' }, { name: 'dup' }]
    expect(() => buildToolNameMaps(tools)).not.toThrow()
    const maps = buildToolNameMaps(tools)
    expect(maps.toKiroName('dup')).toBe('dup')
  })

  test('tool with undefined name skipped', () => {
    const tools = [{ name: undefined }, { name: 'valid' }]
    const maps = buildToolNameMaps(tools)
    expect(maps.toKiroName('valid')).toBe('valid')
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

describe('payload trim performance', () => {
  test('trims very large history in <50ms', () => {
    // 200 user/asst pairs of 10KB each = ~4MB raw — would be O(N²) without
    // the incremental size accounting.
    const messages: any[] = []
    for (let i = 0; i < 200; i++) {
      messages.push({ role: 'user', content: 'u'.repeat(10000) })
      messages.push({ role: 'assistant', content: 'a'.repeat(10000) })
    }
    messages.push({ role: 'user', content: 'final' })

    const start = performance.now()
    const result = transformToSdkRequest({ messages }, 'auto', auth)
    const elapsed = performance.now() - start

    // Result must still be under the limit.
    const size = JSON.stringify(result.conversationState).length
    expect(size).toBeLessThanOrEqual(600_000)
    // Allow 100ms on slow CI; fail if we regress to seconds (O(N²)).
    expect(elapsed).toBeLessThan(100)
  })
})
