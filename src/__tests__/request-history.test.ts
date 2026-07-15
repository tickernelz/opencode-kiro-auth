import { describe, expect, test } from 'bun:test'
import { SYNTHETIC_TURN_CONTENT } from '../infrastructure/transformers/message-transformer.js'
import { transformToSdkRequest } from '../plugin/request.js'
import type { KiroAuthDetails } from '../plugin/types.js'

const auth: KiroAuthDetails = {
  refresh: 'refresh-token',
  access: 'access-token',
  expires: Date.now() + 60_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

function transform(messages: any[]) {
  return transformToSdkRequest({ messages }, 'gpt-5.6-sol', auth).conversationState
}

describe('request history', () => {
  test('uses invisible content when collapsing repeated tool-call preambles', () => {
    const state = transform([
      { role: 'user', content: 'Inspect the project.' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect it.' },
          { type: 'tool_use', id: 'tool-1', name: 'read', input: { path: 'one' } }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: [{ type: 'text', text: 'first result' }]
          }
        ]
      },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will inspect another file.' },
          { type: 'tool_use', id: 'tool-2', name: 'read', input: { path: 'two' } }
        ]
      },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tool-2',
            content: [{ type: 'text', text: 'second result' }]
          }
        ]
      },
      { role: 'assistant', content: 'Inspection complete.' },
      { role: 'user', content: 'What did you find?' }
    ])

    expect(state.history?.[3]?.assistantResponseMessage?.content).toBe(SYNTHETIC_TURN_CONTENT)
    expect(JSON.stringify(state)).not.toContain('[system:')
  })

  test('uses invisible content for missing and current synthetic turns', () => {
    const state = transform([
      { role: 'user', content: 'First question.' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Second question.' },
      { role: 'assistant', content: '' },
      { role: 'user', content: 'Third question.' }
    ])

    expect(state.history).toEqual([
      expect.objectContaining({ userInputMessage: expect.any(Object) }),
      { assistantResponseMessage: { content: SYNTHETIC_TURN_CONTENT } },
      expect.objectContaining({ userInputMessage: expect.any(Object) }),
      { assistantResponseMessage: { content: SYNTHETIC_TURN_CONTENT } }
    ])
    expect(JSON.stringify(state)).not.toContain('[system:')

    const assistantState = transform([
      { role: 'user', content: 'Run a tool.' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'read', input: {} }]
      }
    ])
    expect(assistantState.currentMessage.userInputMessage?.content).toBe(SYNTHETIC_TURN_CONTENT)

    const emptyState = transform([{ role: 'user', content: '' }])
    expect(emptyState.currentMessage.userInputMessage?.content).toBe(SYNTHETIC_TURN_CONTENT)
  })
})
