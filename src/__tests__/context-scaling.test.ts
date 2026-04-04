import { describe, expect, test } from 'bun:test'
import { buildHistory, truncateHistory } from '../infrastructure/transformers/history-builder.js'

function generateConversation(pairs: number, contentSize: number): any[] {
  const msgs: any[] = []
  const filler = 'x'.repeat(contentSize)
  for (let i = 0; i < pairs; i++) {
    msgs.push({ role: 'user', content: `User message ${i}: ${filler}` })
    msgs.push({ role: 'assistant', content: `Assistant message ${i}: ${filler}` })
  }
  msgs.push({ role: 'user', content: 'Final question' })
  return msgs
}

describe('truncateHistory', () => {
  test('retains all messages when under limit', () => {
    const msgs = generateConversation(3, 100)
    const history = buildHistory(msgs, 'claude-sonnet-4.6', 1250000)
    const truncated = truncateHistory(history, 4250000)
    expect(truncated.length).toBeGreaterThanOrEqual(history.length - 1)
  })

  test('higher limit retains more messages', () => {
    const msgs = generateConversation(30, 5000)
    const history = buildHistory(msgs, 'claude-sonnet-4.6', 1250000)

    const smallTruncated = truncateHistory([...history], 100000)
    const largeTruncated = truncateHistory([...history], 500000)

    expect(largeTruncated.length).toBeGreaterThan(smallTruncated.length)
  })
})
