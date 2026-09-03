import { describe, expect, test } from 'bun:test'
import { ResponseHandler } from '../core/request/response-handler'
import { transformSdkStream } from '../plugin/streaming/sdk-stream-transformer.js'
import { transformKiroStream } from '../plugin/streaming/stream-transformer.js'

const MODEL = 'claude-opus-5'

function sdkStreamOf(events: any[]) {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
    })()
  }
}

async function lastUsageChunk(events: any[]): Promise<any> {
  const chunks: any[] = []
  for await (const chunk of transformSdkStream(sdkStreamOf(events), MODEL, 'conversation-1')) {
    chunks.push(chunk)
  }
  for (let i = chunks.length - 1; i >= 0; i--) {
    if (chunks[i]?.usage) return chunks[i].usage
  }
  return null
}

describe('cache token usage — SDK streaming', () => {
  test('emits non-zero cache_creation_input_tokens from metadataEvent.tokenUsage', async () => {
    const usage = await lastUsageChunk([
      { assistantResponseEvent: { content: 'Answer.' } },
      {
        metadataEvent: {
          tokenUsage: {
            inputTokens: 100,
            outputTokens: 25,
            cacheReadInputTokens: 800,
            cacheWriteInputTokens: 1200
          }
        }
      }
    ])

    expect(usage).not.toBeNull()
    expect(usage.cache_read_input_tokens).toBe(800)
    expect(usage.cache_creation_input_tokens).toBe(1200)
  })

  test('emits zeros when metadataEvent has no tokenUsage at all', async () => {
    const usage = await lastUsageChunk([
      { assistantResponseEvent: { content: 'Answer.' } },
      { metadataEvent: {} }
    ])

    expect(usage).not.toBeNull()
    expect(usage.cache_read_input_tokens).toBe(0)
    expect(usage.cache_creation_input_tokens).toBe(0)
  })

  test('emits zeros when tokenUsage omits cache fields (SDK type defines them as optional)', async () => {
    const usage = await lastUsageChunk([
      { assistantResponseEvent: { content: 'Answer.' } },
      {
        metadataEvent: {
          tokenUsage: {
            inputTokens: 50,
            outputTokens: 10
            // cacheReadInputTokens / cacheWriteInputTokens intentionally absent
          }
        }
      }
    ])

    expect(usage).not.toBeNull()
    expect(usage.cache_read_input_tokens).toBe(0)
    expect(usage.cache_creation_input_tokens).toBe(0)
  })

  test('does not crash when no metadataEvent ever arrives', async () => {
    const usage = await lastUsageChunk([{ assistantResponseEvent: { content: 'Answer.' } }])

    expect(usage).not.toBeNull()
    expect(usage.cache_read_input_tokens).toBe(0)
    expect(usage.cache_creation_input_tokens).toBe(0)
  })
})

describe('cache token usage — SDK non-streaming', () => {
  const handler = new ResponseHandler()

  async function readJsonUsage(sdkResponse: any): Promise<any> {
    const response = await handler.handleSdkSuccess(sdkResponse, MODEL, 'conversation-1', false)
    const body = await response.json()
    return body.usage
  }

  test('emits non-zero cache fields when metadataEvent carries them', async () => {
    const usage = await readJsonUsage(
      sdkStreamOf([
        { assistantResponseEvent: { content: 'Answer.' } },
        {
          metadataEvent: {
            tokenUsage: {
              inputTokens: 200,
              outputTokens: 40,
              cacheReadInputTokens: 1600,
              cacheWriteInputTokens: 400
            }
          }
        }
      ])
    )

    expect(usage.prompt_tokens).toBe(200)
    expect(usage.completion_tokens).toBe(40)
    expect(usage.cache_read_input_tokens).toBe(1600)
    expect(usage.cache_creation_input_tokens).toBe(400)
    expect(usage.total_tokens).toBe(240)
  })

  test('emits zeros when metadataEvent.tokenUsage omits cache fields', async () => {
    const usage = await readJsonUsage(
      sdkStreamOf([
        { assistantResponseEvent: { content: 'Answer.' } },
        {
          metadataEvent: {
            tokenUsage: { inputTokens: 30, outputTokens: 5 }
          }
        }
      ])
    )

    expect(usage.prompt_tokens).toBe(30)
    expect(usage.completion_tokens).toBe(5)
    expect(usage.cache_read_input_tokens).toBe(0)
    expect(usage.cache_creation_input_tokens).toBe(0)
  })

  test('emits zeros when metadataEvent has no tokenUsage', async () => {
    const usage = await readJsonUsage(
      sdkStreamOf([{ assistantResponseEvent: { content: 'Answer.' } }, { metadataEvent: {} }])
    )

    expect(usage.cache_read_input_tokens).toBe(0)
    expect(usage.cache_creation_input_tokens).toBe(0)
  })
})

describe('cache token usage — raw HTTP streaming (non-SDK)', () => {
  // The non-SDK path's event shape only carries contextUsagePercentage —
  // these tests pin that behavior so future contributors do not silently
  // rewrite the hardcoded zeros.
  function makeReadableStreamFromEvents(events: any[]) {
    const encoder = new TextEncoder()
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const event of events) {
            controller.enqueue(encoder.encode(JSON.stringify(event) + '\n'))
          }
          controller.close()
        }
      })
    )
  }

  async function lastUsageChunk(events: any[]): Promise<any> {
    const response = makeReadableStreamFromEvents(events)
    const chunks: any[] = []
    for await (const chunk of transformKiroStream(response, MODEL, 'conversation-1')) {
      chunks.push(chunk)
    }
    for (let i = chunks.length - 1; i >= 0; i--) {
      if (chunks[i]?.usage) return chunks[i].usage
    }
    return null
  }

  test('emits zeros — raw event stream does not carry cache token fields', async () => {
    const usage = await lastUsageChunk([{ content: 'Answer.' }, { contextUsagePercentage: 5 }])

    expect(usage).not.toBeNull()
    expect(usage.cache_read_input_tokens).toBe(0)
    expect(usage.cache_creation_input_tokens).toBe(0)
  })
})
