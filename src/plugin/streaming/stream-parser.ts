import { parseEventLine } from '../../infrastructure/transformers/event-stream-parser.js'

export function parseStreamBuffer(buffer: string): { events: any[]; remaining: string } {
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

function isQuoteCharAt(text: string, index: number): boolean {
  if (index < 0 || index >= text.length) return false
  const ch = text[index]
  return ch === '"' || ch === "'" || ch === '`'
}

function isInsideCodeFence(text: string, index: number): boolean {
  let fenceCount = 0
  let pos = 0

  while ((pos = text.indexOf('```', pos)) !== -1 && pos < index) {
    fenceCount++
    pos += 3
  }

  return fenceCount % 2 === 1
}

export function findRealTag(buffer: string, tag: string, startIndex = 0): number {
  let pos = Math.max(0, startIndex)

  while ((pos = buffer.indexOf(tag, pos)) !== -1) {
    const hasQuoteBefore = isQuoteCharAt(buffer, pos - 1)
    const hasQuoteAfter = isQuoteCharAt(buffer, pos + tag.length)

    if (!hasQuoteBefore && !hasQuoteAfter && !isInsideCodeFence(buffer, pos)) {
      return pos
    }

    pos += 1
  }

  return -1
}

export function findRealThinkingEndTag(
  buffer: string,
  tag: string,
  _allowBufferEnd = false
): number {
  return findRealTag(buffer, tag)
}
