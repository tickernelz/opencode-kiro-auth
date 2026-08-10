import { describe, expect, test } from 'bun:test'
import {
  cleanToolCallsFromText,
  deduplicateToolCalls,
  parseBracketToolCalls
} from '../infrastructure/transformers/tool-call-parser.js'

describe('parseBracketToolCalls', () => {
  test('returns empty array for plain text', () => {
    expect(parseBracketToolCalls('Hello world')).toHaveLength(0)
  })

  test('parses single bracket tool call', () => {
    const text = '[Called bash with args: {"command":"ls"}]'
    const result = parseBracketToolCalls(text)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('bash')
    expect(result[0]!.input).toEqual({ command: 'ls' })
  })

  test('parses multiple bracket tool calls', () => {
    const text =
      '[Called bash with args: {"command":"ls"}] [Called read with args: {"path":"/tmp"}]'
    const result = parseBracketToolCalls(text)
    expect(result).toHaveLength(2)
    expect(result[0]!.name).toBe('bash')
    expect(result[1]!.name).toBe('read')
  })

  test('skips malformed JSON args', () => {
    const text = '[Called bash with args: {not valid json}]'
    const result = parseBracketToolCalls(text)
    expect(result).toHaveLength(0)
  })

  test('assigns unique toolUseIds', () => {
    const text =
      '[Called bash with args: {"command":"ls"}][Called bash with args: {"command":"pwd"}]'
    const result = parseBracketToolCalls(text)
    expect(result[0]!.toolUseId).not.toBe(result[1]!.toolUseId)
  })
})

describe('deduplicateToolCalls', () => {
  test('returns empty array for empty input', () => {
    expect(deduplicateToolCalls([])).toHaveLength(0)
  })

  test('keeps all unique tool calls', () => {
    const calls = [
      { toolUseId: 'a', name: 'bash', input: {} },
      { toolUseId: 'b', name: 'read', input: {} }
    ]
    expect(deduplicateToolCalls(calls)).toHaveLength(2)
  })

  test('removes duplicates by toolUseId', () => {
    const calls = [
      { toolUseId: 'a', name: 'bash', input: {} },
      { toolUseId: 'a', name: 'bash', input: { x: 1 } }
    ]
    const result = deduplicateToolCalls(calls)
    expect(result).toHaveLength(1)
    expect(result[0]!.input).toEqual({}) // first one kept
  })
})

describe('parseBracketToolCalls: large JSON content (catastrophic backtracking guard)', () => {
  test('returns empty array fast when "[Called " is absent — even with huge JSON', () => {
    // A 500 KB JSON array with many nested braces — previously caused catastrophic
    // backtracking in the regex. The short-circuit guard must make this instant.
    const largeJson = JSON.stringify(
      Array.from({ length: 200 }, (_, i) => ({
        id: i,
        data: 'x'.repeat(1000),
        nested: { a: 1, b: [1, 2, 3] }
      }))
    )
    const start = performance.now()
    const result = parseBracketToolCalls(largeJson)
    const elapsed = performance.now() - start
    expect(result).toHaveLength(0)
    expect(elapsed).toBeLessThan(50) // must be near-instant, not seconds
  })

  test('still finds bracket tool calls when "[Called " is present in large text', () => {
    const prefix = 'x'.repeat(10000)
    const text = `${prefix}[Called bash with args: {"command":"ls"}]${prefix}`
    const result = parseBracketToolCalls(text)
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('bash')
  })
})

describe('cleanToolCallsFromText', () => {
  test('removes bracket tool call from text', () => {
    const text = 'Here is the result [Called bash with args: {"command":"ls"}] done.'
    const toolCalls = [{ toolUseId: 'x', name: 'bash', input: {} }]
    const result = cleanToolCallsFromText(text, toolCalls)
    expect(result).not.toContain('[Called bash')
    expect(result).toContain('done.')
  })

  test('leaves text unchanged when no tool calls match', () => {
    const text = 'Hello world'
    const result = cleanToolCallsFromText(text, [])
    expect(result).toBe('Hello world')
  })

  test('trims and collapses whitespace', () => {
    const text = '  hello    world  '
    const result = cleanToolCallsFromText(text, [])
    expect(result).toBe('hello world')
  })
})
