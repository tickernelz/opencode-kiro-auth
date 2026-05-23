import { parseBracketToolCalls } from '../../infrastructure/transformers/tool-call-parser.js'
import { getContextWindowSize } from '../models.js'
import { estimateTokens } from '../response.js'
import { convertToOpenAI } from './openai-converter.js'
import { parseStreamBuffer } from './stream-parser.js'
import { createStreamState, stopBlock } from './stream-state.js'
import { createContentDeltaEvents, flushContentDeltaEvents } from './thinking-parser.js'
import { ToolCallState } from './types.js'

export async function* transformKiroStream(
  response: Response,
  model: string,
  conversationId: string,
  thinkingRequested = model.endsWith('-thinking')
): AsyncGenerator<any> {
  const streamState = createStreamState(thinkingRequested)

  if (!response.body) {
    throw new Error('Response body is null')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()

  let rawBuffer = ''
  let totalContent = ''
  let textOnlyContent = ''
  let outputTokens = 0
  let inputTokens = 0
  let contextUsagePercentage: number | null = null
  const toolCalls: ToolCallState[] = []
  let currentToolCall: ToolCallState | null = null

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      const chunk = decoder.decode(value, { stream: true })
      rawBuffer += chunk

      const events = parseStreamBuffer(rawBuffer)
      rawBuffer = events.remaining

      for (const event of events.events) {
        if (event.type === 'contextUsage' && event.data.contextUsagePercentage) {
          contextUsagePercentage = event.data.contextUsagePercentage
        } else if (event.type === 'content' && event.data) {
          totalContent += event.data
          textOnlyContent += event.data

          for (const ev of createContentDeltaEvents(event.data, streamState)) {
            yield convertToOpenAI(ev, conversationId, model)
          }
        } else if (event.type === 'toolUse') {
          const tc = event.data
          if (tc.name) {
            totalContent += tc.name
          }
          if (tc.input) {
            totalContent += tc.input
          }

          if (tc.name && tc.toolUseId) {
            if (currentToolCall && currentToolCall.toolUseId === tc.toolUseId) {
              currentToolCall.input += tc.input || ''
            } else {
              if (currentToolCall) {
                toolCalls.push(currentToolCall)
              }
              currentToolCall = {
                toolUseId: tc.toolUseId,
                name: tc.name,
                input: tc.input || ''
              }
            }

            if (tc.stop && currentToolCall) {
              toolCalls.push(currentToolCall)
              currentToolCall = null
            }
          }
        } else if (event.type === 'toolUseInput') {
          if (event.data.input) {
            totalContent += event.data.input
          }
          if (currentToolCall) {
            currentToolCall.input += event.data.input || ''
          }
        } else if (event.type === 'toolUseStop') {
          if (currentToolCall && event.data.stop) {
            toolCalls.push(currentToolCall)
            currentToolCall = null
          }
        }
      }
    }

    if (currentToolCall) {
      toolCalls.push(currentToolCall)
      currentToolCall = null
    }

    for (const ev of flushContentDeltaEvents(streamState)) {
      yield convertToOpenAI(ev, conversationId, model)
    }

    for (const ev of stopBlock(streamState.textBlockIndex, streamState))
      yield convertToOpenAI(ev, conversationId, model)

    const bracketToolCalls = parseBracketToolCalls(totalContent)
    if (bracketToolCalls.length > 0) {
      for (const btc of bracketToolCalls) {
        toolCalls.push({
          toolUseId: btc.toolUseId,
          name: btc.name,
          input: typeof btc.input === 'string' ? btc.input : JSON.stringify(btc.input)
        })
      }
    }

    if (toolCalls.length > 0) {
      const baseIndex = streamState.nextBlockIndex
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        if (!tc) continue

        const blockIndex = baseIndex + i

        yield convertToOpenAI(
          {
            type: 'content_block_start',
            index: blockIndex,
            content_block: {
              type: 'tool_use',
              id: tc.toolUseId,
              name: tc.name,
              input: {}
            }
          },
          conversationId,
          model
        )

        let inputJson: string
        try {
          const parsed = JSON.parse(tc.input)
          inputJson = JSON.stringify(parsed)
        } catch (e) {
          inputJson = tc.input
        }

        yield convertToOpenAI(
          {
            type: 'content_block_delta',
            index: blockIndex,
            delta: {
              type: 'input_json_delta',
              partial_json: inputJson
            }
          },
          conversationId,
          model
        )

        yield convertToOpenAI(
          { type: 'content_block_stop', index: blockIndex },
          conversationId,
          model
        )
      }
    }

    outputTokens = estimateTokens(textOnlyContent)

    if (contextUsagePercentage !== null && contextUsagePercentage > 0) {
      const contextWindow = getContextWindowSize(model)
      const totalTokens = Math.round((contextWindow * contextUsagePercentage) / 100)
      inputTokens = Math.max(0, totalTokens - outputTokens)
    }

    yield convertToOpenAI(
      {
        type: 'message_delta',
        delta: { stop_reason: toolCalls.length > 0 ? 'tool_use' : 'end_turn' },
        usage: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0
        }
      },
      conversationId,
      model
    )

    yield convertToOpenAI({ type: 'message_stop' }, conversationId, model)
  } finally {
    reader.releaseLock()
  }
}
