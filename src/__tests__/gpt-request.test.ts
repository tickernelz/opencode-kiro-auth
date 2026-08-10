import { describe, expect, test } from 'bun:test'
import { transformToSdkRequest } from '../plugin/request.js'

const auth: any = {
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 60_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

const body = {
  messages: [
    { role: 'system', content: 'Follow the instructions.' },
    { role: 'user', content: 'Solve this.' }
  ]
}

describe('GPT request preparation', () => {
  test('uses reasoning.effort semantics without Claude thinking tags', () => {
    const prepared = transformToSdkRequest(body, 'gpt-5.6-sol', auth, true, 128000)

    expect(prepared.effectiveModel).toBe('gpt-5.6-sol')
    expect(prepared.effort).toBe('xhigh')
    expect(prepared.effortSchemaPath).toBe('reasoning')
    expect(JSON.stringify(prepared.conversationState)).not.toContain('<thinking_mode>')
    expect(JSON.stringify(prepared.conversationState)).not.toContain('<max_thinking_length>')
  })

  test('does not replay assistant reasoning as Claude thinking tags', () => {
    const priorAssistant = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'First question' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hidden prior reasoning' },
              { type: 'text', text: 'Prior answer' }
            ]
          },
          { role: 'user', content: 'Follow up' }
        ]
      },
      'gpt-5.6-sol',
      auth,
      true,
      65536
    )
    const trailingAssistant = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'First question' },
          {
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'hidden current reasoning' },
              { type: 'text', text: 'Current answer' }
            ]
          }
        ]
      },
      'gpt-5.6-sol',
      auth,
      true,
      65536
    )

    const priorSerialized = JSON.stringify(priorAssistant.conversationState)
    const trailingSerialized = JSON.stringify(trailingAssistant.conversationState)
    expect(priorSerialized).not.toContain('<thinking>')
    expect(priorSerialized).not.toContain('hidden prior reasoning')
    expect(priorSerialized).toContain('Prior answer')
    expect(trailingSerialized).not.toContain('<thinking>')
    expect(trailingSerialized).not.toContain('hidden current reasoning')
    expect(trailingSerialized).toContain('Current answer')
  })

  test('preserves Claude output_config effort and compatibility tags', () => {
    const prepared = transformToSdkRequest(body, 'claude-opus-5-thinking', auth, true, 98304)
    const serialized = JSON.stringify(prepared.conversationState)

    expect(prepared.effectiveModel).toBe('claude-opus-5')
    expect(prepared.effort).toBe('xhigh')
    expect(prepared.effortSchemaPath).toBe('output_config')
    expect(serialized).toContain('<thinking_mode>enabled</thinking_mode>')
    expect(serialized).toContain('<max_thinking_length>98304</max_thinking_length>')
  })
})
