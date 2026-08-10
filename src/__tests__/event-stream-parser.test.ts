import { describe, expect, test } from 'bun:test'
import {
  parseAwsEventStreamBuffer,
  parseEventLine
} from '../infrastructure/transformers/event-stream-parser.js'

// ── parseEventLine ────────────────────────────────────────────────────────────

describe('parseEventLine', () => {
  test('parses valid JSON', () => {
    expect(parseEventLine('{"content":"hello"}')).toEqual({ content: 'hello' })
  })

  test('returns null on invalid JSON', () => {
    expect(parseEventLine('not json')).toBeNull()
    expect(parseEventLine('{')).toBeNull()
  })
})

// ── parseAwsEventStreamBuffer ─────────────────────────────────────────────────

describe('parseAwsEventStreamBuffer', () => {
  test('empty buffer returns empty array', () => {
    expect(parseAwsEventStreamBuffer('')).toEqual([])
  })

  test('parses content event', () => {
    const result = parseAwsEventStreamBuffer('{"content":"Hello"}')
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('content')
    expect(result[0]!.data).toBe('Hello')
  })

  test('skips followupPrompt as not content', () => {
    const result = parseAwsEventStreamBuffer('{"content":"x","followupPrompt":"y"}')
    expect(result).toHaveLength(0)
  })

  test('parses toolUse event', () => {
    const result = parseAwsEventStreamBuffer(
      '{"name":"bash","toolUseId":"t-1","input":"ls","stop":false}'
    )
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('toolUse')
    expect(result[0]!.data.name).toBe('bash')
    expect(result[0]!.data.toolUseId).toBe('t-1')
  })

  test('parses toolUseInput event', () => {
    const result = parseAwsEventStreamBuffer('{"input":"-la"}')
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('toolUseInput')
    expect(result[0]!.data.input).toBe('-la')
  })

  test('parses toolUseStop event', () => {
    const result = parseAwsEventStreamBuffer('{"stop":true}')
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('toolUseStop')
    expect(result[0]!.data.stop).toBe(true)
  })

  test('parses contextUsage event', () => {
    const result = parseAwsEventStreamBuffer('{"contextUsagePercentage":42}')
    expect(result).toHaveLength(1)
    expect(result[0]!.type).toBe('contextUsage')
    expect(result[0]!.data.contextUsagePercentage).toBe(42)
  })

  test('parses multiple events from a single buffer', () => {
    const buffer = '{"content":"Hello"}\n{"content":" world"}\n{"contextUsagePercentage":25}'
    const result = parseAwsEventStreamBuffer(buffer)
    expect(result).toHaveLength(3)
    expect(result[0]!.data).toBe('Hello')
    expect(result[1]!.data).toBe(' world')
    expect(result[2]!.type).toBe('contextUsage')
  })

  test('handles incomplete JSON at end (no jsonEnd)', () => {
    const result = parseAwsEventStreamBuffer('{"content":"truncated')
    expect(result).toHaveLength(0)
  })

  test('handles escaped strings inside JSON values', () => {
    const result = parseAwsEventStreamBuffer('{"content":"say \\"hello\\""}')
    expect(result).toHaveLength(1)
    expect(result[0]!.data).toBe('say "hello"')
  })
})
