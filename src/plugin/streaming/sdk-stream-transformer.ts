import { parseBracketToolCalls } from '../../infrastructure/transformers/tool-call-parser.js'
import { restoreToolName } from '../../infrastructure/transformers/tool-transformer.js'
import { getContextWindowSize } from '../models.js'
import { estimateTokens } from '../response.js'
import type { ToolNameMap } from '../types.js'
import { convertToOpenAI } from './openai-converter.js'
import { findRealTag } from './stream-parser.js'
import { createTextDeltaEvents, createThinkingDeltaEvents, stopBlock } from './stream-state.js'
import { StreamState, THINKING_END_TAG, THINKING_START_TAG, ToolCallState } from './types.js'

interface PendingToolCall {
  toolUseId: string
  name?: string
  input: string
}

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
  let cacheReadInputTokens = 0
  let cacheWriteInputTokens = 0
  const toolCallFragments = new Map<string, PendingToolCall>()
  const toolCallOrder: string[] = []

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
        if (tc.name) totalContent += tc.name
        if (tc.input) totalContent += tc.input

        const toolUseId = tc.toolUseId
        if (typeof toolUseId === 'string' && toolUseId.length > 0) {
          let accumulated = toolCallFragments.get(toolUseId)
          if (!accumulated) {
            accumulated = { toolUseId, input: '' }
            toolCallFragments.set(toolUseId, accumulated)
            toolCallOrder.push(toolUseId)
          }
          if (typeof tc.name === 'string' && tc.name.length > 0) {
            accumulated.name = restoreToolName(tc.name, toolNameMap)
          }
          if (tc.input !== undefined) {
            accumulated.input +=
              typeof tc.input === 'string' ? tc.input : (JSON.stringify(tc.input) ?? '')
          }
        }
      } else if (event.metadataEvent) {
        if (event.metadataEvent.contextUsagePercentage) {
          contextUsagePercentage = event.metadataEvent.contextUsagePercentage
        }
        const tu = event.metadataEvent.tokenUsage
        if (tu) {
          if (typeof tu.cacheReadInputTokens === 'number') {
            cacheReadInputTokens = tu.cacheReadInputTokens
          }
          if (typeof tu.cacheWriteInputTokens === 'number') {
            cacheWriteInputTokens = tu.cacheWriteInputTokens
          }
        }
      } else if ((event as any).contextUsageEvent) {
        const cue = (event as any).contextUsageEvent
        if (cue.contextUsagePercentage) {
          contextUsagePercentage = cue.contextUsagePercentage
        }
      }
    }

    const toolCalls = toolCallOrder
      .map((toolUseId) => toolCallFragments.get(toolUseId))
      .filter((toolCall): toolCall is ToolCallState => typeof toolCall?.name === 'string')

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
          name: restoreToolName(btc.name, toolNameMap),
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
            cache_creation_input_tokens: cacheWriteInputTokens,
            cache_read_input_tokens: cacheReadInputTokens
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
    throw e
  }
}
