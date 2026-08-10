import { parseBracketToolCalls } from '../../infrastructure/transformers/tool-call-parser.js'
import {
  deduplicateToolCallsByContent,
  restoreToolName
} from '../../infrastructure/transformers/tool-transformer.js'
import * as logger from '../logger.js'
import { getContextWindowSize } from '../models.js'
import { estimateTokens } from '../response.js'
import type { ToolNameMap } from '../types.js'
import { convertToOpenAI } from './openai-converter.js'
import { findRealTag } from './stream-parser.js'
import { createTextDeltaEvents, createThinkingDeltaEvents, stopBlock } from './stream-state.js'
import { StreamState, THINKING_END_TAG, THINKING_START_TAG, ToolCallState } from './types.js'

export async function* transformSdkStream(
  sdkResponse: any,
  model: string,
  conversationId: string,
  toolNameMap?: ToolNameMap
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

  // Set when the API returns native reasoning via reasoningContentEvent. The
  // <thinking> tag scraper below stays as a fallback for responses that only
  // carry reasoning inline in the assistant text.
  let sawNativeReasoning = false

  let totalContent = ''
  let textOnlyContent = ''
  let outputTokens = 0
  let inputTokens = 0
  let contextUsagePercentage: number | null = null
  let realInputTokens: number | undefined
  let realOutputTokens: number | undefined
  const toolCalls: ToolCallState[] = []
  const activeToolCalls = new Map<string, ToolCallState>()
  let lastToolUseId: string | null = null

  const eventStream = sdkResponse.generateAssistantResponseResponse
  if (!eventStream) {
    throw new Error('SDK response has no event stream')
  }

  try {
    for await (const event of eventStream) {
      if (event.reasoningContentEvent) {
        // Native reasoning stream. redactedContent is encrypted by the provider
        // and has no readable form, so only text is surfaced.
        const reasoning = event.reasoningContentEvent.text
        if (typeof reasoning === 'string' && reasoning.length > 0) {
          sawNativeReasoning = true
          for (const ev of createThinkingDeltaEvents(reasoning, streamState)) {
            const chunk = convertToOpenAI(ev, conversationId, model)
            if (chunk !== null) yield chunk
          }
        }
      } else if (event.assistantResponseEvent?.content) {
        const text = event.assistantResponseEvent.content
        totalContent += text
        textOnlyContent += text

        // Native reasoning already streamed, so close that block and route the
        // remaining content straight to text instead of scraping for tags.
        if (sawNativeReasoning && !streamState.thinkingExtracted) {
          streamState.thinkingExtracted = true
          for (const ev of stopBlock(streamState.thinkingBlockIndex, streamState)) {
            const chunk = convertToOpenAI(ev, conversationId, model)
            if (chunk !== null) yield chunk
          }
        }

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
        // Only accumulate the tool *name* into totalContent — the input JSON is
        // never bracket-format and can be hundreds of KB; including it causes
        // catastrophic backtracking in parseBracketToolCalls.
        if (tc.name) totalContent += tc.name

        if (tc.toolUseId) {
          const existing = activeToolCalls.get(tc.toolUseId)
          if (existing) {
            existing.input += tc.input || ''
            if (tc.input) {
              const _c = convertToOpenAI(
                {
                  type: 'content_block_delta',
                  index: existing.blockIndex,
                  delta: { type: 'input_json_delta', partial_json: tc.input }
                },
                conversationId,
                model
              )
              if (_c !== null) yield _c
            }
          } else if (tc.name) {
            const blockIndex = streamState.nextBlockIndex++
            const newToolCall: ToolCallState = {
              toolUseId: tc.toolUseId,
              name: restoreToolName(tc.name, toolNameMap),
              input: tc.input || '',
              stopped: false,
              blockIndex
            }
            activeToolCalls.set(tc.toolUseId, newToolCall)
            lastToolUseId = tc.toolUseId
            {
              const _c = convertToOpenAI(
                {
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: {
                    type: 'tool_use',
                    id: tc.toolUseId,
                    name: newToolCall.name,
                    input: {}
                  }
                },
                conversationId,
                model
              )
              if (_c !== null) yield _c
            }
            if (tc.input) {
              const _c = convertToOpenAI(
                {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'input_json_delta', partial_json: tc.input }
                },
                conversationId,
                model
              )
              if (_c !== null) yield _c
            }
          }
        }
        if (tc.stop) {
          const stopId: string | null = tc.toolUseId ?? lastToolUseId
          const stoppingCall = stopId ? activeToolCalls.get(stopId) : null
          if (stoppingCall) {
            stoppingCall.stopped = true
            toolCalls.push(stoppingCall)
            activeToolCalls.delete(stopId as string)
            if (lastToolUseId === stopId) {
              let last: string | null = null
              for (const k of activeToolCalls.keys()) last = k
              lastToolUseId = last
            }
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

    if (activeToolCalls.size > 0) {
      // Kiro doesn't send a stop event for tool calls with no parameters
      // (e.g. time_currentTime). Those are complete despite the missing stop —
      // only calls that received partial input were actually cut off mid-stream.
      const trulyTruncated: ToolCallState[] = []
      for (const pending of activeToolCalls.values()) {
        if (pending.input.length === 0) {
          pending.stopped = true
          toolCalls.push(pending)
        } else {
          trulyTruncated.push(pending)
        }
      }
      activeToolCalls.clear()

      for (const truncated of trulyTruncated) {
        logger.debug(
          `[STREAM] Truncated tool call: name=${truncated.name} id=${truncated.toolUseId} inputLen=${truncated.input.length}`
        )
        for (const ev of createTextDeltaEvents(
          `\n\n[Kiro: "${truncated.name}" truncated mid-stream — 64K token output limit exceeded. Write in chunks of ≤500 lines.]`,
          streamState
        )) {
          const _c = convertToOpenAI(ev, conversationId, model)
          if (_c !== null) yield _c
        }
      }
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
          name: restoreToolName(btc.name, toolNameMap),
          input: typeof btc.input === 'string' ? btc.input : JSON.stringify(btc.input),
          stopped: true
          // no blockIndex — these are emitted post-stream below
        })
      }
    }

    const dedupedToolCalls = deduplicateToolCallsByContent(toolCalls)

    // SDK tool calls were already emitted inline (content_block_start/delta/stop
    // during streaming). Only bracket-format tool calls (blockIndex undefined)
    // need to be emitted here.
    const postStreamCalls = dedupedToolCalls.filter((tc) => tc.blockIndex === undefined)
    if (postStreamCalls.length > 0) {
      for (let i = 0; i < postStreamCalls.length; i++) {
        const tc = postStreamCalls[i]
        if (!tc) continue
        const blockIndex = streamState.nextBlockIndex++

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
          inputJson = JSON.stringify(JSON.parse(tc.input))
        } catch {
          inputJson = tc.input
        }

        {
          const _c = convertToOpenAI(
            {
              type: 'content_block_delta',
              index: blockIndex,
              delta: { type: 'input_json_delta', partial_json: inputJson }
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
    for (const tc of activeToolCalls.values()) {
      logger.debug(
        `[STREAM] Incomplete tool call: name=${tc.name} id=${tc.toolUseId} inputLen=${tc.input.length}`
      )
    }
    throw e
  }
}
