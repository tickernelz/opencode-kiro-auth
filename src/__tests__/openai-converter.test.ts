import { describe, expect, test } from 'bun:test'
import { convertToOpenAI } from '../plugin/streaming/openai-converter.js'

describe('convertToOpenAI', () => {
  test('skips Anthropic-only events instead of emitting empty choices', () => {
    expect(
      convertToOpenAI({ type: 'content_block_stop', index: 0 }, 'chatcmpl-test', 'auto')
    ).toBeNull()
    expect(convertToOpenAI({ type: 'message_stop' }, 'chatcmpl-test', 'auto')).toBeNull()
  })

  test('skips empty reasoning deltas instead of emitting empty choices', () => {
    const chunk = convertToOpenAI(
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'thinking_delta', thinking: '' }
      },
      'chatcmpl-test',
      'auto'
    )

    expect(chunk).toBeNull()
  })
})
