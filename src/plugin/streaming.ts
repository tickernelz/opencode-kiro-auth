import { parseBracketToolCalls, parseEventLine } from './response'

interface StreamEvent {
  type: string
  message?: any
  content_block?: any
  delta?: any
  index?: number
  usage?: any
}

interface StreamState {
  thinkingRequested: boolean
  buffer: string
  inThinking: boolean
  thinkingExtracted: boolean
  thinkingBlockIndex: number | null
  textBlockIndex: number | null
  nextBlockIndex: number
  stoppedBlocks: Set<number>
}

interface ToolCallState {
  toolUseId: string
  name: string
  input: string
}

const THINKING_START_TAG = '<thinking>'
const THINKING_END_TAG = '</thinking>'

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

          if (!thinkingRequested) {
            for (const ev of createTextDeltaEvents(event.data, streamState)) {
              yield convertToOpenAI(ev, conversationId, model)
            }
            continue
          }

          streamState.buffer += event.data
          const deltaEvents: StreamEvent[] = []

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

    if (thinkingRequested && streamState.buffer) {
      if (streamState.inThinking) {
        for (const ev of createThinkingDeltaEvents(streamState.buffer, streamState))
          yield convertToOpenAI(ev, conversationId, model)
        streamState.buffer = ''
        for (const ev of createThinkingDeltaEvents('', streamState))
          yield convertToOpenAI(ev, conversationId, model)
        for (const ev of stopBlock(streamState.thinkingBlockIndex, streamState))
          yield convertToOpenAI(ev, conversationId, model)
      } else {
        for (const ev of createTextDeltaEvents(streamState.buffer, streamState))
          yield convertToOpenAI(ev, conversationId, model)
        streamState.buffer = ''
      }
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

    outputTokens = estimateTokens(totalContent)

    if (contextUsagePercentage !== null && contextUsagePercentage > 0) {
      const totalTokens = Math.round((200000 * contextUsagePercentage) / 100)
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

function convertToOpenAI(event: StreamEvent, id: string, model: string): any {
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
      base.choices.push({
        index: 0,
        delta: { reasoning_content: event.delta.thinking },
        finish_reason: null
      })
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
  }

  return base
}

function parseStreamBuffer(buffer: string): { events: any[]; remaining: string } {
  const events: any[] = []
  let remaining = buffer
  let searchStart = 0

  while (true) {
    const contentStart = remaining.indexOf('{"content":', searchStart)
    const nameStart = remaining.indexOf('{"name":', searchStart)
    const followupStart = remaining.indexOf('{"followupPrompt":', searchStart)
    const inputStart = remaining.indexOf('{"input":', searchStart)
    const stopStart = remaining.indexOf('{"stop":', searchStart)
    const contextUsageStart = remaining.indexOf('{"contextUsagePercentage":', searchStart)

    const candidates = [
      contentStart,
      nameStart,
      followupStart,
      inputStart,
      stopStart,
      contextUsageStart
    ].filter((pos) => pos >= 0)
    if (candidates.length === 0) break

    const jsonStart = Math.min(...candidates)
    if (jsonStart < 0) break

    let braceCount = 0
    let jsonEnd = -1
    let inString = false
    let escapeNext = false

    for (let i = jsonStart; i < remaining.length; i++) {
      const char = remaining[i]

      if (escapeNext) {
        escapeNext = false
        continue
      }

      if (char === '\\') {
        escapeNext = true
        continue
      }

      if (char === '"') {
        inString = !inString
        continue
      }

      if (!inString) {
        if (char === '{') {
          braceCount++
        } else if (char === '}') {
          braceCount--
          if (braceCount === 0) {
            jsonEnd = i
            break
          }
        }
      }
    }

    if (jsonEnd < 0) {
      remaining = remaining.substring(jsonStart)
      break
    }

    const jsonStr = remaining.substring(jsonStart, jsonEnd + 1)
    const parsed = parseEventLine(jsonStr)

    if (parsed) {
      if (parsed.content !== undefined && !parsed.followupPrompt) {
        events.push({ type: 'content', data: parsed.content })
      } else if (parsed.name && parsed.toolUseId) {
        events.push({
          type: 'toolUse',
          data: {
            name: parsed.name,
            toolUseId: parsed.toolUseId,
            input: parsed.input || '',
            stop: parsed.stop || false
          }
        })
      } else if (parsed.input !== undefined && !parsed.name) {
        events.push({
          type: 'toolUseInput',
          data: {
            input: parsed.input
          }
        })
      } else if (parsed.stop !== undefined && parsed.contextUsagePercentage === undefined) {
        events.push({
          type: 'toolUseStop',
          data: {
            stop: parsed.stop
          }
        })
      } else if (parsed.contextUsagePercentage !== undefined) {
        events.push({
          type: 'contextUsage',
          data: {
            contextUsagePercentage: parsed.contextUsagePercentage
          }
        })
      }
    }

    searchStart = jsonEnd + 1
    if (searchStart >= remaining.length) {
      remaining = ''
      break
    }
  }

  if (searchStart > 0 && remaining.length > 0) {
    remaining = remaining.substring(searchStart)
  }

  return { events, remaining }
}

function ensureBlockStart(blockType: 'thinking' | 'text', streamState: StreamState): StreamEvent[] {
  if (blockType === 'thinking') {
    if (streamState.thinkingBlockIndex != null) return []
    const idx = streamState.nextBlockIndex++
    streamState.thinkingBlockIndex = idx
    return [
      {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'thinking', thinking: '' }
      }
    ]
  }
  if (blockType === 'text') {
    if (streamState.textBlockIndex != null) return []
    const idx = streamState.nextBlockIndex++
    streamState.textBlockIndex = idx
    return [
      {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'text', text: '' }
      }
    ]
  }
  return []
}

function stopBlock(index: number | null, streamState: StreamState): StreamEvent[] {
  if (index == null) return []
  if (streamState.stoppedBlocks.has(index)) return []
  streamState.stoppedBlocks.add(index)
  return [{ type: 'content_block_stop', index }]
}

function createTextDeltaEvents(text: string, streamState: StreamState): StreamEvent[] {
  if (!text) return []
  const events: StreamEvent[] = []
  events.push(...ensureBlockStart('text', streamState))
  events.push({
    type: 'content_block_delta',
    index: streamState.textBlockIndex!,
    delta: { type: 'text_delta', text }
  })
  return events
}

function createThinkingDeltaEvents(thinking: string, streamState: StreamState): StreamEvent[] {
  const events: StreamEvent[] = []
  events.push(...ensureBlockStart('thinking', streamState))
  events.push({
    type: 'content_block_delta',
    index: streamState.thinkingBlockIndex!,
    delta: { type: 'thinking_delta', thinking }
  })
  return events
}

export function findRealTag(buffer: string, tag: string): number {
  const codeBlockPattern = /```[\s\S]*?```/g
  const codeBlocks: Array<[number, number]> = []

  let match: RegExpExecArray | null
  while ((match = codeBlockPattern.exec(buffer)) !== null) {
    codeBlocks.push([match.index, match.index + match[0].length])
  }

  let pos = 0
  while ((pos = buffer.indexOf(tag, pos)) !== -1) {
    let inCodeBlock = false
    for (const [start, end] of codeBlocks) {
      if (pos >= start && pos < end) {
        inCodeBlock = true
        break
      }
    }
    if (!inCodeBlock) {
      return pos
    }
    pos += tag.length
  }

  return -1
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
