import { StreamEvent } from './types.js'

export function convertToOpenAI(event: StreamEvent, id: string, model: string): any {
  const base = {
    id,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [] as any[]
  }

  if (event.type === 'content_block_delta') {
    if (event.delta.type === 'text_delta') {
      base.choices.push({
        index: 0,
        delta: { content: event.delta.text },
        finish_reason: null
      })
    } else if (event.delta.type === 'thinking_delta') {
      // reasoning_content is supported by some OpenAI-compatible clients;
      // emit it but also skip if empty to avoid noise.
      if (event.delta.thinking) {
        base.choices.push({
          index: 0,
          delta: { reasoning_content: event.delta.thinking },
          finish_reason: null
        })
      }
    } else if (event.delta.type === 'input_json_delta') {
      base.choices.push({
        index: 0,
        delta: {
          tool_calls: [
            {
              index: event.index,
              function: { arguments: event.delta.partial_json }
            }
          ]
        },
        finish_reason: null
      })
    }
  } else if (event.type === 'content_block_start' && event.content_block?.type === 'tool_use') {
    base.choices.push({
      index: 0,
      delta: {
        tool_calls: [
          {
            index: event.index,
            id: event.content_block.id,
            type: 'function',
            function: { name: event.content_block.name, arguments: '' }
          }
        ]
      },
      finish_reason: null
    })
  } else if (event.type === 'message_delta') {
    base.choices.push({
      index: 0,
      delta: {},
      finish_reason: event.delta.stop_reason === 'tool_use' ? 'tool_calls' : 'stop'
    })
    ;(base as any).usage = {
      prompt_tokens: event.usage?.input_tokens || 0,
      completion_tokens: event.usage?.output_tokens || 0,
      total_tokens: (event.usage?.input_tokens || 0) + (event.usage?.output_tokens || 0)
    }
  } else {
    // Skip Anthropic-specific events that @ai-sdk/openai-compatible doesn't understand
    // (content_block_start for text/thinking, content_block_stop, message_stop, etc.)
    // Returning null signals the caller to skip this event.
    return null
  }

  // Don't emit chunks with empty choices — the SDK may mishandle them.
  if (base.choices.length === 0) return null

  return base
}
