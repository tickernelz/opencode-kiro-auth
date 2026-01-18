import { ToolCall, ParsedResponse } from './types'

interface ParsedEvent {
  type: string
  data: any
}

export function parseEventStream(rawResponse: string): ParsedResponse {
  const parsedFromEvents = parseEventStreamChunk(rawResponse)
  let fullResponseText = parsedFromEvents.content
  let allToolCalls = [...parsedFromEvents.toolCalls]

  const rawBracketToolCalls = parseBracketToolCalls(rawResponse)
  if (rawBracketToolCalls.length > 0) {
    allToolCalls.push(...rawBracketToolCalls)
  }

  const uniqueToolCalls = deduplicateToolCalls(allToolCalls)

  if (uniqueToolCalls.length > 0) {
    fullResponseText = cleanToolCallsFromText(fullResponseText, uniqueToolCalls)
  }

  return {
    content: fullResponseText,
    toolCalls: uniqueToolCalls,
    stopReason: parsedFromEvents.stopReason,
    inputTokens: parsedFromEvents.inputTokens,
    outputTokens: parsedFromEvents.outputTokens
  }
}

function parseEventStreamChunk(rawText: string): ParsedResponse {
  const events = parseAwsEventStreamBuffer(rawText)

  let content = ''
  const toolCallsMap = new Map<string, ToolCall>()
  let stopReason: string | undefined
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  let contextUsagePercentage: number | undefined

  for (const event of events) {
    if (event.type === 'content' && event.data) {
      content += event.data
    } else if (event.type === 'toolUse') {
      const { name, toolUseId, input } = event.data
      if (name && toolUseId) {
        if (toolCallsMap.has(toolUseId)) {
          const existing = toolCallsMap.get(toolUseId)!
          existing.input = (existing.input as string) + (input || '')
        } else {
          toolCallsMap.set(toolUseId, {
            toolUseId,
            name,
            input: input || ''
          })
        }
      }
    } else if (event.type === 'toolUseInput') {
      const lastToolCall = Array.from(toolCallsMap.values()).pop()
      if (lastToolCall) {
        lastToolCall.input = (lastToolCall.input as string) + (event.data.input || '')
      }
    } else if (event.type === 'toolUseStop') {
      stopReason = 'tool_use'
    } else if (event.type === 'contextUsage') {
      contextUsagePercentage = event.data.contextUsagePercentage
    }
  }

  const toolCalls: ToolCall[] = Array.from(toolCallsMap.values()).map((tc) => {
    let parsedInput: Record<string, unknown> | string = tc.input
    if (typeof tc.input === 'string' && tc.input.trim()) {
      try {
        parsedInput = JSON.parse(tc.input)
      } catch (e) {
        parsedInput = tc.input
      }
    }
    return {
      toolUseId: tc.toolUseId,
      name: tc.name,
      input: parsedInput
    }
  })

  if (contextUsagePercentage !== undefined) {
    const totalTokens = Math.round((200000 * contextUsagePercentage) / 100)
    outputTokens = estimateTokens(content)
    inputTokens = Math.max(0, totalTokens - outputTokens)
  }

  return {
    content,
    toolCalls,
    stopReason: stopReason || (toolCalls.length > 0 ? 'tool_use' : 'end_turn'),
    inputTokens,
    outputTokens
  }
}

function parseAwsEventStreamBuffer(buffer: string): ParsedEvent[] {
  const events: ParsedEvent[] = []
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
      break
    }
  }

  return events
}

export function parseEventLine(line: string): any | null {
  try {
    return JSON.parse(line)
  } catch (e) {
    return null
  }
}

export function parseBracketToolCalls(text: string): ToolCall[] {
  const toolCalls: ToolCall[] = []
  const pattern = /\[Called\s+(\w+)\s+with\s+args:\s*(\{[^}]*(?:\{[^}]*\}[^}]*)*\})\]/gs

  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const funcName = match[1]
    const argsStr = match[2]

    if (!funcName || !argsStr) continue

    try {
      const args = JSON.parse(argsStr)
      toolCalls.push({
        toolUseId: `tool_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`,
        name: funcName,
        input: args
      })
    } catch (e) {
      continue
    }
  }

  return toolCalls
}

export function deduplicateToolCalls(toolCalls: ToolCall[]): ToolCall[] {
  const seen = new Set<string>()
  const unique: ToolCall[] = []

  for (const tc of toolCalls) {
    if (!seen.has(tc.toolUseId)) {
      seen.add(tc.toolUseId)
      unique.push(tc)
    }
  }

  return unique
}

export function cleanToolCallsFromText(text: string, toolCalls: ToolCall[]): string {
  let cleaned = text

  for (const tc of toolCalls) {
    const funcName = tc.name
    const escapedName = funcName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const pattern = new RegExp(
      `\\[Called\\s+${escapedName}\\s+with\\s+args:\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\]`,
      'gs'
    )
    cleaned = cleaned.replace(pattern, '')
  }

  cleaned = cleaned.replace(/\s+/g, ' ').trim()
  return cleaned
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}
