import { describe, expect, test } from 'bun:test'
import { transformKiroStream } from '../plugin/streaming/stream-transformer.js'

// Helper: create a Response with a ReadableStream from text chunks
function makeStreamResponse(chunks: string[]): Response {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(new TextEncoder().encode(chunk))
      }
      controller.close()
    }
  })
  return new Response(stream)
}

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const result: any[] = []
  for await (const item of gen) result.push(item)
  return result
}

const MODEL = 'CLAUDE_SONNET_4_5'
const CONV = 'conv-test'

// ── basic text content ────────────────────────────────────────────────────────

describe('transformKiroStream: text', () => {
  test('plain text content produces text delta events', async () => {
    const response = makeStreamResponse(['{"content":"Hello world"}'])
    const events = await collect(transformKiroStream(response, MODEL, CONV))
    // Should contain at least a content_block_delta and message_stop
    const deltas = events.filter(
      (e) => e.choices?.[0]?.delta?.content !== undefined || e.choices?.[0]?.delta?.type === 'text'
    )
    expect(deltas.length).toBeGreaterThan(0)
    const stop = events.find((e) => e.object === 'chat.completion.chunk')
    expect(stop).toBeDefined()
  })

  test('multiple content chunks are concatenated', async () => {
    const response = makeStreamResponse(['{"content":"Hello "}', '{"content":"world"}'])
    const events = await collect(transformKiroStream(response, MODEL, CONV))
    const allText = events
      .filter((e) => e.choices?.[0]?.delta?.content)
      .map((e) => e.choices[0].delta.content)
      .join('')
    expect(allText).toContain('Hello')
    expect(allText).toContain('world')
  })

  test('empty body throws', async () => {
    const response = new Response(null)
    await expect(collect(transformKiroStream(response, MODEL, CONV))).rejects.toThrow(
      'Response body is null'
    )
  })
})

// ── thinking tags ─────────────────────────────────────────────────────────────

describe('transformKiroStream: thinking tags', () => {
  test('thinking content produces thinking delta events', async () => {
    const response = makeStreamResponse(['{"content":"<thinking>I think...</thinking>Answer"}'])
    const events = await collect(transformKiroStream(response, MODEL, CONV))
    // Thinking events have type 'thinking' in the delta
    const thinkingEvents = events.filter(
      (e) => e.choices?.[0]?.delta?.reasoning_content !== undefined
    )
    expect(thinkingEvents.length).toBeGreaterThan(0)
  })

  test('text after thinking tags is emitted as normal text', async () => {
    const response = makeStreamResponse(['{"content":"<thinking>Think</thinking>Final answer"}'])
    const events = await collect(transformKiroStream(response, MODEL, CONV))
    const textContent = events
      .filter((e) => e.choices?.[0]?.delta?.content)
      .map((e) => e.choices[0].delta.content)
      .join('')
    expect(textContent).toContain('Final answer')
  })

  test('thinking tag inside code block is not treated as thinking', async () => {
    const response = makeStreamResponse([
      '{"content":"```\\n<thinking>not thinking</thinking>\\n```"}'
    ])
    const events = await collect(transformKiroStream(response, MODEL, CONV))
    const thinkingEvents = events.filter((e) => e.choices?.[0]?.delta?.thinking)
    expect(thinkingEvents.length).toBe(0)
  })
})

// ── tool use ──────────────────────────────────────────────────────────────────

describe('transformKiroStream: tool use', () => {
  test('toolUse events produce tool_call chunks', async () => {
    const chunks = [
      '{"name":"bash","toolUseId":"t-1","input":"","stop":false}',
      '{"input":"{\\\"command\\\":\\\"ls\\\"}"}',
      '{"stop":true}'
    ]
    const response = makeStreamResponse(chunks)
    const events = await collect(transformKiroStream(response, MODEL, CONV))
    // Should have tool_calls in at least one event
    const toolEvents = events.filter(
      (e) => e.choices?.[0]?.delta?.tool_calls || e.choices?.[0]?.delta?.type === 'tool_use'
    )
    expect(toolEvents.length).toBeGreaterThan(0)
  })
})

// ── context usage ─────────────────────────────────────────────────────────────

describe('transformKiroStream: context usage', () => {
  test('contextUsagePercentage is reflected in final usage', async () => {
    const response = makeStreamResponse(['{"content":"hi"}', '{"contextUsagePercentage":50}'])
    const events = await collect(transformKiroStream(response, MODEL, CONV))
    const delta = events.find((e) => e.choices?.[0]?.delta?.stop_reason || e.usage)
    expect(delta).toBeDefined()
  })
})

// ── TextDecoder flush ─────────────────────────────────────────────────────────

describe('transformKiroStream: TextDecoder flush', () => {
  test('multi-byte UTF-8 split across chunks is decoded correctly', async () => {
    // € = E2 82 AC (3 bytes), split: [E2 82] + [AC ...]
    const euro = new TextEncoder().encode('{"content":"€"}')
    const part1 = euro.slice(0, euro.length - 5) // cut before '€' completes
    const part2 = euro.slice(euro.length - 5)

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(part1)
        controller.enqueue(part2)
        controller.close()
      }
    })
    const response = new Response(stream)
    const events = await collect(transformKiroStream(response, MODEL, CONV))
    const allText = events
      .filter((e) => e.choices?.[0]?.delta?.content)
      .map((e) => e.choices[0].delta.content)
      .join('')
    expect(allText).toContain('€')
  })
})

// ── SDK stream: tool call chunking ───────────────────────────────────────────

import { transformSdkStream } from '../plugin/streaming/sdk-stream-transformer.js'

function makeSdkResponse(events: any[]) {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const e of events) yield e
    })()
  }
}

async function collectSdk(gen: AsyncGenerator<any>): Promise<any[]> {
  const result: any[] = []
  for await (const item of gen) result.push(item)
  return result
}

describe('transformSdkStream: tool call streaming', () => {
  test('tool call input chunks without name are concatenated', async () => {
    const events = [
      { toolUseEvent: { toolUseId: 't-1', name: 'write', input: '{"file' } },
      { toolUseEvent: { toolUseId: 't-1', input: 'Path":"/tmp/x.txt","content":"hello"}' } },
      { toolUseEvent: { toolUseId: 't-1', stop: true } }
    ]
    const sdk = makeSdkResponse(events)
    const result = await collectSdk(transformSdkStream(sdk, 'auto', 'conv-1'))

    // With inline streaming, args arrive as multiple partial_json deltas.
    // Collect all argument chunks for this tool and concatenate.
    const argChunks = result
      .filter((e) => e.choices?.[0]?.delta?.tool_calls?.[0]?.function?.arguments !== undefined)
      .map((e: any) => e.choices[0].delta.tool_calls[0].function.arguments)
      .join('')
    const args = JSON.parse(argChunks)
    expect(args.filePath).toBe('/tmp/x.txt')
    expect(args.content).toBe('hello')
  })

  test('multiple tool calls in one response are parsed correctly', async () => {
    const events = [
      { assistantResponseEvent: { content: 'I will run two tools.' } },
      { toolUseEvent: { toolUseId: 't-1', name: 'read', input: '{"path":"/a"}', stop: true } },
      { toolUseEvent: { toolUseId: 't-2', name: 'read', input: '{"path":"/b"}', stop: true } }
    ]
    const sdk = makeSdkResponse(events)
    const result = await collectSdk(transformSdkStream(sdk, 'auto', 'conv-1'))
    const toolBlocks = result.filter((e) => e.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name)
    expect(toolBlocks.length).toBe(2)
  })

  test('truncated tool call (no stop event) closes the block and emits error text', async () => {
    // Simulates Kiro cutting the stream mid-tool-call (large .frm JSON that
    // exceeds the response size limit).
    // With inline streaming: content_block_start IS emitted (tool name visible),
    // then on truncation the block is closed and an error text is appended.
    const events = [
      { assistantResponseEvent: { content: 'I will edit the file.' } },
      {
        toolUseEvent: {
          toolUseId: 't-trunc',
          name: 'replaceFileContent',
          input: '{"path":"/app.frm","content":{"forms":[{"name":"form1"'
        }
      }
      // note: no stop event — stream cut off mid-JSON
    ]
    const sdk = makeSdkResponse(events)
    const result = await collectSdk(transformSdkStream(sdk, 'auto', 'conv-1'))

    // content_block_start IS emitted (inline streaming — tool name is immediately visible)
    const toolNameBlocks = result.filter(
      (e) => e.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name
    )
    expect(toolNameBlocks.length).toBeGreaterThan(0)
    expect(toolNameBlocks[0]!.choices[0].delta.tool_calls[0].function.name).toBe(
      'replaceFileContent'
    )

    // Must emit a text delta explaining the truncation
    const allText = result
      .filter((e) => e.choices?.[0]?.delta?.content)
      .map((e: any) => e.choices[0].delta.content)
      .join('')
    expect(allText).toContain('truncated')
    expect(allText).toContain('replaceFileContent')
  })

  test('tool input is NOT accumulated into totalContent — bracket parser never sees large JSON', async () => {
    // Regression: previously `totalContent += tc.input` caused catastrophic
    // regex backtracking when the tool input was hundreds of KB of JSON.
    const largeInput = JSON.stringify(
      Array.from({ length: 100 }, (_, i) => ({ id: i, value: 'x'.repeat(500) }))
    )
    const events = [
      {
        toolUseEvent: {
          toolUseId: 't-big',
          name: 'write',
          input: largeInput.slice(0, largeInput.length / 2)
        }
      },
      { toolUseEvent: { toolUseId: 't-big', input: largeInput.slice(largeInput.length / 2) } },
      { toolUseEvent: { toolUseId: 't-big', stop: true } }
    ]
    const sdk = makeSdkResponse(events)
    const start = performance.now()
    const result = await collectSdk(transformSdkStream(sdk, 'auto', 'conv-1'))
    const elapsed = performance.now() - start

    // Must complete in well under 1s — would hang for seconds with catastrophic backtracking
    expect(elapsed).toBeLessThan(500)

    // Tool call must still be emitted correctly
    const toolBlocks = result.filter((e) => e.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name)
    expect(toolBlocks.length).toBeGreaterThan(0)
  })
})

// ── SDK stream: real token usage ─────────────────────────────────────────────

describe('transformSdkStream: token usage', () => {
  test('real tokenUsage from metadata wins over the context% estimate', async () => {
    const events = [
      { assistantResponseEvent: { content: 'hello' } },
      {
        metadataEvent: {
          contextUsagePercentage: 80,
          tokenUsage: { inputTokens: 1234, outputTokens: 56 }
        }
      }
    ]
    const result = await collectSdk(transformSdkStream(makeSdkResponse(events), 'auto', 'conv-1'))
    const usageEvent = result.find((e) => e.usage)
    expect(usageEvent.usage.prompt_tokens).toBe(1234)
    expect(usageEvent.usage.completion_tokens).toBe(56)
  })
})

// ── isNewThread after merge ──────────────────────────────────────────────────

import { buildHistory } from '../infrastructure/transformers/history-builder.js'
import { mergeAdjacentMessages } from '../infrastructure/transformers/message-transformer.js'

describe('isNewThread detection after merge', () => {
  test('consecutive user messages merge to one — treated as new thread', () => {
    const msgs = [
      { role: 'user', content: 'msg1' },
      { role: 'user', content: 'msg2' },
      { role: 'user', content: 'msg3' }
    ]
    const merged = mergeAdjacentMessages([...msgs])
    expect(merged.length).toBe(1)
    const history = buildHistory(merged, 'auto')
    expect(history.length).toBe(0)
  })

  test('user+assistant+user produces history', () => {
    const msgs = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'next' }
    ]
    const merged = mergeAdjacentMessages([...msgs])
    expect(merged.length).toBe(3)
    const history = buildHistory(merged, 'auto')
    expect(history.length).toBe(2)
  })

  test('single user message produces empty history', () => {
    const msgs = [{ role: 'user', content: 'only one' }]
    const merged = mergeAdjacentMessages([...msgs])
    expect(merged.length).toBe(1)
    const history = buildHistory(merged, 'auto')
    expect(history.length).toBe(0)
  })

  test('consecutive assistant messages are merged', () => {
    const msgs = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: 'part1' },
      { role: 'assistant', content: 'part2' },
      { role: 'user', content: 'next' }
    ]
    const merged = mergeAdjacentMessages([...msgs])
    expect(merged.length).toBe(3)
    expect(merged[1].content).toContain('part1')
    expect(merged[1].content).toContain('part2')
  })
})

// ── Tool name consistency (>64 chars must be shortened everywhere) ───────────

import { shortenToolName } from '../infrastructure/transformers/tool-transformer.js'

describe('tool name >64 chars is shortened consistently in history', () => {
  const longName =
    'a_very_long_tool_name_that_definitely_exceeds_the_sixty_four_character_limit_imposed_by_kiro'

  test('buildHistory shortens tool_use names', () => {
    const msgs = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'calling tool' },
          { type: 'tool_use', id: 'tu-1', name: longName, input: { x: 1 } }
        ]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tu-1', content: 'done' }]
      }
    ]
    const merged = mergeAdjacentMessages([...msgs])
    const history = buildHistory(merged, 'auto')
    const toolUses = history.flatMap((h) => h.assistantResponseMessage?.toolUses || [])
    expect(toolUses.length).toBeGreaterThan(0)
    for (const tu of toolUses) {
      expect(tu.name.length).toBeLessThanOrEqual(64)
      expect(tu.name).toBe(shortenToolName(longName))
    }
  })

  test('buildHistory shortens tool_calls names', () => {
    const msgs = [
      { role: 'user', content: 'do it' },
      {
        role: 'assistant',
        content: 'ok',
        tool_calls: [{ id: 'tc-1', function: { name: longName, arguments: '{"a":1}' } }]
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tc-1', content: 'result' }]
      }
    ]
    const merged = mergeAdjacentMessages([...msgs])
    const history = buildHistory(merged, 'auto')
    const toolUses = history.flatMap((h) => h.assistantResponseMessage?.toolUses || [])
    expect(toolUses.length).toBeGreaterThan(0)
    for (const tu of toolUses) {
      expect(tu.name.length).toBeLessThanOrEqual(64)
      expect(tu.name).toBe(shortenToolName(longName))
    }
  })
})
