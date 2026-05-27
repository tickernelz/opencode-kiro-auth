import { parseBracketToolCalls } from '../../infrastructure/transformers/tool-call-parser.js'
import { deduplicateToolCallsByContent } from '../../infrastructure/transformers/tool-transformer.js'
import * as logger from '../logger.js'
import { getContextWindowSize } from '../models.js'
import { estimateTokens } from '../response.js'
import { convertToOpenAI } from './openai-converter.js'
import { findRealTag } from './stream-parser.js'
import { createTextDeltaEvents, createThinkingDeltaEvents, stopBlock } from './stream-state.js'
import { StreamState, THINKING_END_TAG, THINKING_START_TAG, ToolCallState } from './types.js'

export async function* transformSdkStream(
  sdkResponse: any,
  model: string,
  conversationId: string,
  toolNameMapper?: (name: string) => string
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

  let totalContent = ''
  let textOnlyContent = ''
  let outputTokens = 0
  let inputTokens = 0
  let contextUsagePercentage: number | null = null
  let realInputTokens: number | undefined
  let realOutputTokens: number | undefined
  const toolCalls: ToolCallState[] = []
  let currentToolCall: ToolCallState | null = null

  const eventStream = sdkResponse.generateAssistantResponseResponse
  if (!eventStream) {
    throw new Error('SDK response has no event stream')
  }

  try {
    for await (const event of eventStream) {
      if (event.assistantResponseEvent?.content) {
        const text = event.assistantResponseEvent.content
        totalContent += text
        textOnlyContent += text

        if (!thinkingRequested) {
          for (const ev of createTextDeltaEvents(text, streamState)) {
            {
              const _c = convertToOpenAI(ev, conversationId, model)
              if (_c !== null) yield _c
            }
          }
          continue
        }

        streamState.buffer += text
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
          const chunk = convertToOpenAI(ev, conversationId, model)
          if (chunk !== null) yield chunk
        }
      } else if (event.toolUseEvent) {
        const tc = event.toolUseEvent
        if (tc.name) totalContent += tc.name
        if (tc.input) totalContent += tc.input

        if (tc.toolUseId) {
          if (currentToolCall && currentToolCall.toolUseId === tc.toolUseId) {
            currentToolCall.input += tc.input || ''
          } else if (tc.name) {
            if (currentToolCall) toolCalls.push(currentToolCall)
            currentToolCall = {
              toolUseId: tc.toolUseId,
              name: toolNameMapper ? toolNameMapper(tc.name) : tc.name,
              input: tc.input || ''
            }
          }
          if (tc.stop && currentToolCall) {
            toolCalls.push(currentToolCall)
            currentToolCall = null
          }
        }
      } else if (event.metadataEvent) {
        if (event.metadataEvent.contextUsagePercentage) {
          contextUsagePercentage = event.metadataEvent.contextUsagePercentage
        }
        if (event.metadataEvent.tokenUsage) {
          const tu = event.metadataEvent.tokenUsage
          if (typeof tu.inputTokens === 'number') realInputTokens = tu.inputTokens
          if (typeof tu.outputTokens === 'number') realOutputTokens = tu.outputTokens
        }
      } else if ((event as any).contextUsageEvent) {
        const cue = (event as any).contextUsageEvent
        if (cue.contextUsagePercentage) {
          contextUsagePercentage = cue.contextUsagePercentage
        }
      } else if ((event as any).meteringEvent) {
        const me = (event as any).meteringEvent
        logger.debug(
          `[CREDITS] usage=${me.usage} ${me.unit || 'credit'}${me.usage !== 1 ? 's' : ''}`
        )
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

    const dedupedToolCalls = deduplicateToolCallsByContent(toolCalls)

    if (dedupedToolCalls.length > 0) {
      const baseIndex = streamState.nextBlockIndex
      for (let i = 0; i < dedupedToolCalls.length; i++) {
        const tc = dedupedToolCalls[i]
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
          logger.debug(
            `[TOOL_CALL] Invalid JSON for tool "${tc.name}" (id=${tc.toolUseId}): ${tc.input.slice(0, 500)}`
          )
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

    // Real token counts from Kiro's metadata win over the context-% estimate.
    if (realInputTokens !== undefined) inputTokens = realInputTokens
    if (realOutputTokens !== undefined) outputTokens = realOutputTokens

    {
      const _c = convertToOpenAI(
        {
          type: 'message_delta',
          delta: { stop_reason: dedupedToolCalls.length > 0 ? 'tool_use' : 'end_turn' },
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
  } catch (e) {
    logger.debug(
      `[STREAM] Error in transformSdkStream: ${e instanceof Error ? e.message : String(e)}`
    )
    if (currentToolCall) {
      logger.debug(
        `[STREAM] Incomplete tool call: name=${currentToolCall.name} id=${currentToolCall.toolUseId} inputLen=${currentToolCall.input.length}`
      )
    }
    throw e
  }
}
