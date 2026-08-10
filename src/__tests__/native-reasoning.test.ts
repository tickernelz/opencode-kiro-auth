import { describe, expect, test } from 'bun:test'
import { transformSdkStream } from '../plugin/streaming/sdk-stream-transformer.js'

const MODEL = 'claude-opus-5'

function streamOf(events: any[]) {
  return {
    generateAssistantResponseResponse: (async function* () {
      for (const event of events) yield event
    })()
  }
}

async function collect(events: any[], model = MODEL) {
  const chunks: any[] = []
  for await (const chunk of transformSdkStream(streamOf(events), model, 'conversation-1')) {
    chunks.push(chunk)
  }

  let reasoning = ''
  let text = ''
  for (const chunk of chunks) {
    const delta = chunk.choices?.[0]?.delta
    if (delta?.reasoning_content) reasoning += delta.reasoning_content
    if (delta?.content) text += delta.content
  }

  return { reasoning, text }
}

describe('native reasoning stream', () => {
  test('surfaces reasoningContentEvent text as reasoning_content', async () => {
    const { reasoning, text } = await collect([
      { reasoningContentEvent: { text: 'weighing ' } },
      { reasoningContentEvent: { text: 'the options' } },
      { assistantResponseEvent: { content: 'Answer.' } }
    ])

    expect(reasoning).toBe('weighing the options')
    expect(text).toBe('Answer.')
  })

  test('does not scrape thinking tags once native reasoning arrived', async () => {
    // A model echoing the tag literally must not have it re-parsed as a
    // reasoning block when the API already streamed native reasoning.
    const { reasoning, text } = await collect([
      { reasoningContentEvent: { text: 'native' } },
      { assistantResponseEvent: { content: 'literal <thinking> mention stays in text' } }
    ])

    expect(reasoning).toBe('native')
    expect(text).toContain('<thinking>')
  })

  test('ignores reasoning events with no readable text', async () => {
    const { reasoning, text } = await collect([
      { reasoningContentEvent: { redactedContent: new Uint8Array([1, 2, 3]) } },
      { reasoningContentEvent: { text: '' } },
      { assistantResponseEvent: { content: 'Answer.' } }
    ])

    expect(reasoning).toBe('')
    expect(text).toBe('Answer.')
  })

  test('still scrapes thinking tags when no native reasoning is sent', async () => {
    const { reasoning, text } = await collect([
      { assistantResponseEvent: { content: '<thinking>scraped</thinking>\n\nAnswer.' } }
    ])

    expect(reasoning).toBe('scraped')
    expect(text).toBe('Answer.')
  })

  // Observed shape from a live opus-5 response: the API interleaves many small
  // reasoningContentEvents before any assistant text, and emits no <thinking>
  // tags at all. Reasoning must survive without the scraper having anything to
  // find, and without anything being requested on the way out.
  test('handles the live event shape: many reasoning events, then text, no tags', async () => {
    const events = [
      ...Array.from({ length: 17 }, (_, i) => ({
        reasoningContentEvent: { text: `step${i} ` }
      })),
      { assistantResponseEvent: { content: 'Final answer.' } },
      { contextUsageEvent: { contextUsagePercentage: 12 } },
      { meteringEvent: {} }
    ]

    const { reasoning, text } = await collect(events)

    expect(reasoning).toBe(Array.from({ length: 17 }, (_, i) => `step${i} `).join(''))
    expect(text).toBe('Final answer.')
  })

  test('uses GPT-5.6 272K context size for streamed usage accounting', async () => {
    const chunks: any[] = []
    for await (const chunk of transformSdkStream(
      streamOf([
        { assistantResponseEvent: { content: 'Answer.' } },
        { contextUsageEvent: { contextUsagePercentage: 10 } }
      ]),
      'gpt-5.6-sol',
      'conversation-1'
    )) {
      chunks.push(chunk)
    }

    const usage = chunks.find((chunk) => chunk.usage)?.usage
    expect(usage).toBeDefined()
    expect(usage.prompt_tokens + usage.completion_tokens).toBe(27200)
  })

  test('ignores event types the transformer does not consume', async () => {
    const { reasoning, text } = await collect([
      { meteringEvent: {} },
      { reasoningContentEvent: { text: 'thought' } },
      { contextUsageEvent: { contextUsagePercentage: 3 } },
      { assistantResponseEvent: { content: 'Answer.' } }
    ])

    expect(reasoning).toBe('thought')
    expect(text).toBe('Answer.')
  })
})
