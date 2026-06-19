import { parseBracketToolCalls } from '../../infrastructure/transformers/tool-call-parser.js'
import { getContextWindowSize } from '../models.js'
import { estimateTokens } from '../response.js'
import { convertToOpenAI } from './openai-converter.js'
import { findRealTag, parseStreamBuffer } from './stream-parser.js'
import { createTextDeltaEvents, createThinkingDeltaEvents, stopBlock } from './stream-state.js'
import { StreamState, THINKING_END_TAG, THINKING_START_TAG, ToolCallState } from './types.js'

export async function* transformKiroStream(
  response: Response,
  model: string,
  conversationId: string
): AsyncGenerator<any> {
  const thinkingRequested = true

  const streamState: StreamState = {
    thinkingRequested,
    buffer: '',
    inThinking: false,
    thinkingExtracted: false,
    thinkingBlockIndex: null,
    textBlockIndex: null,
    nextBlockIndex: 0,
    stoppedBlocks: new Set()
  }

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
      if (done) {
        // Flush remaining multi-byte UTF-8 from TextDecoder
        const tail = decoder.decode()
        if (tail) rawBuffer += tail
        break
      }

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

          if (!thinkingRequested) {
            for (const ev of createTextDeltaEvents(event.data, streamState)) {
              {
                const _c = convertToOpenAI(ev, conversationId, model)
                if (_c !== null) yield _c
              }
            }
            continue
          }

          streamState.buffer += event.data
          const deltaEvents: any[] = []

          while (streamState.buffer.length > 0) {
            if (!streamState.inThinking && !streamState.thinkingExtracted) {
              const startPos = findRealTag(streamState.buffer, THINKING_START_TAG)
              if (startPos !== -1) {
                const before = streamState.buffer.slice(0, startPos)
                if (before) {
                  deltaEvents.push(...createTextDeltaEvents(before, streamState))
                }

                streamState.buffer = streamState.buffer.slice(startPos + THINKING_START_TAG.length)
                streamState.inThinking = true
                continue
              }

              const safeLen = Math.max(0, streamState.buffer.length - THINKING_START_TAG.length)
              if (safeLen > 0) {
                const safeText = streamState.buffer.slice(0, safeLen)
                if (safeText) {
                  deltaEvents.push(...createTextDeltaEvents(safeText, streamState))
                }
                streamState.buffer = streamState.buffer.slice(safeLen)
              }
              break
            }

            if (streamState.inThinking) {
              const endPos = findRealTag(streamState.buffer, THINKING_END_TAG)
              if (endPos !== -1) {
                const thinkingPart = streamState.buffer.slice(0, endPos)
                if (thinkingPart) {
                  deltaEvents.push(...createThinkingDeltaEvents(thinkingPart, streamState))
                }

                streamState.buffer = streamState.buffer.slice(endPos + THINKING_END_TAG.length)
                streamState.inThinking = false
                streamState.thinkingExtracted = true

                deltaEvents.push(...createThinkingDeltaEvents('', streamState))
                deltaEvents.push(...stopBlock(streamState.thinkingBlockIndex, streamState))

                if (streamState.buffer.startsWith('\n\n')) {
                  streamState.buffer = streamState.buffer.slice(2)
                }
                continue
              }

              const safeLen = Math.max(0, streamState.buffer.length - THINKING_END_TAG.length)
              if (safeLen > 0) {
                const safeThinking = streamState.buffer.slice(0, safeLen)
                if (safeThinking) {
                  deltaEvents.push(...createThinkingDeltaEvents(safeThinking, streamState))
                }
                streamState.buffer = streamState.buffer.slice(safeLen)
              }
              break
            }

            if (streamState.thinkingExtracted) {
              const rest = streamState.buffer
              streamState.buffer = ''
              if (rest) {
                deltaEvents.push(...createTextDeltaEvents(rest, streamState))
              }
              break
            }
          }

          for (const ev of deltaEvents) {
            {
              const _c = convertToOpenAI(ev, conversationId, model)
              if (_c !== null) yield _c
            }
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
                input: tc.input || '',
                stopped: false
              }
            }

            if (tc.stop && currentToolCall) {
              currentToolCall.stopped = true
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

    if (thinkingRequested && streamState.buffer) {
      if (streamState.inThinking) {
        for (const ev of createThinkingDeltaEvents(streamState.buffer, streamState)) {
          const _c = convertToOpenAI(ev, conversationId, model)
          if (_c !== null) yield _c
        }
        streamState.buffer = ''
        for (const ev of createThinkingDeltaEvents('', streamState)) {
          const _c = convertToOpenAI(ev, conversationId, model)
          if (_c !== null) yield _c
        }
        for (const ev of stopBlock(streamState.thinkingBlockIndex, streamState)) {
          const _c = convertToOpenAI(ev, conversationId, model)
          if (_c !== null) yield _c
        }
      } else {
        for (const ev of createTextDeltaEvents(streamState.buffer, streamState)) {
          const _c = convertToOpenAI(ev, conversationId, model)
          if (_c !== null) yield _c
        }
        streamState.buffer = ''
      }
    }

    for (const ev of stopBlock(streamState.textBlockIndex, streamState)) {
      const _c = convertToOpenAI(ev, conversationId, model)
      if (_c !== null) yield _c
    }

    const bracketToolCalls = totalContent.includes('[Called ')
      ? parseBracketToolCalls(totalContent)
      : []
    if (bracketToolCalls.length > 0) {
      for (const btc of bracketToolCalls) {
        toolCalls.push({
          toolUseId: btc.toolUseId,
          name: btc.name,
          input: typeof btc.input === 'string' ? btc.input : JSON.stringify(btc.input),
          stopped: true
        })
      }
    }

    if (toolCalls.length > 0) {
      const baseIndex = streamState.nextBlockIndex
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]
        if (!tc) continue

        const blockIndex = baseIndex + i

        {
          const _c = convertToOpenAI(
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
          if (_c !== null) yield _c
        }

        let inputJson: string
        try {
          const parsed = JSON.parse(tc.input)
          inputJson = JSON.stringify(parsed)
        } catch (e) {
          inputJson = tc.input
        }

        {
          const _c = convertToOpenAI(
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
          if (_c !== null) yield _c
        }

        {
          const _c = convertToOpenAI(
            { type: 'content_block_stop', index: blockIndex },
            conversationId,
            model
          )
          if (_c !== null) yield _c
        }
      }
    }

    outputTokens = estimateTokens(textOnlyContent)

    if (contextUsagePercentage !== null && contextUsagePercentage > 0) {
      const contextWindow = getContextWindowSize(model)
      const totalTokens = Math.round((contextWindow * contextUsagePercentage) / 100)
      inputTokens = Math.max(0, totalTokens - outputTokens)
    }

    {
      const _c = convertToOpenAI(
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
      if (_c !== null) yield _c
    }

    {
      const _c = convertToOpenAI({ type: 'message_stop' }, conversationId, model)
      if (_c !== null) yield _c
    }
  } finally {
    reader.releaseLock()
  }
}
