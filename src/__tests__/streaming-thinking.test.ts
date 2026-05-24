import { describe, expect, test } from 'bun:test'
import { transformSdkStream } from '../plugin/streaming/sdk-stream-transformer.js'

async function* sdkContentStream(chunks: string[]) {
  for (const content of chunks) {
    yield { assistantResponseEvent: { content } }
  }
}

async function collectDeltas(chunks: string[], thinkingRequested: boolean) {
  const response = {
    generateAssistantResponseResponse: sdkContentStream(chunks)
  }
  const events: any[] = []

  for await (const event of transformSdkStream(
    response,
    thinkingRequested ? 'claude-sonnet-4-5-thinking' : 'claude-sonnet-4-5',
    'chatcmpl-test',
    thinkingRequested
  )) {
    events.push(event)
  }

  return events
    .flatMap((event) => event.choices ?? [])
    .map((choice) => choice.delta)
    .filter((delta) => delta?.content !== undefined || delta?.reasoning_content !== undefined)
}

function textFrom(deltas: any[]): string {
  return deltas.map((delta) => delta.content ?? '').join('')
}

function reasoningFrom(deltas: any[]): string {
  return deltas.map((delta) => delta.reasoning_content ?? '').join('')
}

describe('thinking stream transform', () => {
  test('emits reasoning before answer text and drops pre-thinking fragments', async () => {
    const deltas = await collectDeltas(
      ['Sure, ', '<think', 'ing>\nI should reason', '</thinking>\n\nFinal answer'],
      true
    )

    const firstContentIndex = deltas.findIndex((delta) => delta.content)
    const firstReasoningIndex = deltas.findIndex((delta) => delta.reasoning_content)

    expect(firstReasoningIndex).toBeGreaterThanOrEqual(0)
    expect(firstContentIndex).toBeGreaterThan(firstReasoningIndex)
    expect(reasoningFrom(deltas)).toBe('I should reason')
    expect(textFrom(deltas)).toBe('Final answer')
  })

  test('handles thinking tags split across SDK chunks', async () => {
    const deltas = await collectDeltas(['<thinking>\nPlan', '</think', 'ing>\n\nAnswer'], true)

    expect(reasoningFrom(deltas)).toBe('Plan')
    expect(textFrom(deltas)).toBe('Answer')
  })

  test('closes thinking before immediate answer text', async () => {
    const deltas = await collectDeltas(['<thinking>reason</thinking>Answer'], true)

    expect(reasoningFrom(deltas)).toBe('reason')
    expect(textFrom(deltas)).toBe('Answer')
  })

  test('handles split thinking end tag before immediate answer text', async () => {
    const deltas = await collectDeltas(['<thinking>Plan', '</think', 'ing>Answer'], true)

    expect(reasoningFrom(deltas)).toBe('Plan')
    expect(textFrom(deltas)).toBe('Answer')
  })

  test('strips leading CRLF after a thinking block', async () => {
    const deltas = await collectDeltas(['<thinking>Plan</thinking>\r\n\r\nAnswer'], true)

    expect(reasoningFrom(deltas)).toBe('Plan')
    expect(textFrom(deltas)).toBe('Answer')
  })

  test('keeps normal model text streaming without parsing thinking tags', async () => {
    const deltas = await collectDeltas(['pre <thinking>not reasoning</thinking> answer'], false)

    expect(reasoningFrom(deltas)).toBe('')
    expect(textFrom(deltas)).toBe('pre <thinking>not reasoning</thinking> answer')
  })

  test('does not close thinking on quoted or backticked literal end tags', async () => {
    const deltas = await collectDeltas(
      ['<thinking>quoted `</thinking>` still thinking</thinking>\n\nDone'],
      true
    )

    expect(reasoningFrom(deltas)).toBe('quoted `</thinking>` still thinking')
    expect(textFrom(deltas)).toBe('Done')
  })

  test('does not close thinking on code-fenced literal end tags', async () => {
    const deltas = await collectDeltas(
      ['<thinking>\n```text\n</thinking>\n```\nstill thinking</thinking>Done'],
      true
    )

    expect(reasoningFrom(deltas)).toBe('```text\n</thinking>\n```\nstill thinking')
    expect(textFrom(deltas)).toBe('Done')
  })

  test('flushes text if a thinking model never emits a thinking block', async () => {
    const deltas = await collectDeltas(['plain answer in thinking model'], true)

    expect(reasoningFrom(deltas)).toBe('')
    expect(textFrom(deltas)).toBe('plain answer in thinking model')
  })

  test('closes a thinking block whose end tag lands at stream end', async () => {
    const deltas = await collectDeltas(['<thinking>only thought</thinking>'], true)

    expect(reasoningFrom(deltas)).toBe('only thought')
    expect(textFrom(deltas)).toBe('')
  })
})
