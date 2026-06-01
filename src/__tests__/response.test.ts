import { describe, expect, test } from 'bun:test'
import { estimateTokens, parseEventStream } from '../plugin/response.js'

// ── estimateTokens ────────────────────────────────────────────────────────────

describe('estimateTokens', () => {
  test('empty string returns 0', () => {
    expect(estimateTokens('')).toBe(0)
  })

  test('4-char string returns 1 token', () => {
    expect(estimateTokens('abcd')).toBe(1)
  })

  test('5-char string returns 2 tokens (ceil)', () => {
    expect(estimateTokens('abcde')).toBe(2)
  })

  test('100-char string returns 25 tokens', () => {
    expect(estimateTokens('a'.repeat(100))).toBe(25)
  })
})

// ── parseEventStream ──────────────────────────────────────────────────────────

describe('parseEventStream', () => {
  test('parses plain text content', () => {
    const result = parseEventStream('{"content":"Hello world"}')
    expect(result.content).toBe('Hello world')
    expect(result.toolCalls).toHaveLength(0)
    expect(result.stopReason).toBe('end_turn')
  })

  test('parses multiple content chunks', () => {
    const result = parseEventStream('{"content":"Hello "}{"content":"world"}')
    expect(result.content).toBe('Hello world')
  })

  test('parses tool use', () => {
    const raw = [
      '{"name":"bash","toolUseId":"t-1","input":"","stop":false}',
      '{"input":"{\\\"command\\\":\\\"ls\\\"}"}',
      '{"stop":true}'
    ].join('\n')
    const result = parseEventStream(raw)
    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]!.name).toBe('bash')
    expect(result.stopReason).toBe('tool_use')
  })

  test('parses context usage into token counts', () => {
    const raw = '{"content":"hi"}{"contextUsagePercentage":50}'
    const result = parseEventStream(raw, 'CLAUDE_SONNET_4_5')
    // With a known context window, inputTokens should be set
    expect(result.outputTokens).toBeDefined()
    expect(result.inputTokens).toBeDefined()
  })

  test('returns end_turn when no tool calls', () => {
    const result = parseEventStream('{"content":"answer"}')
    expect(result.stopReason).toBe('end_turn')
  })

  test('empty input returns empty content', () => {
    const result = parseEventStream('')
    expect(result.content).toBe('')
    expect(result.toolCalls).toHaveLength(0)
  })
})
