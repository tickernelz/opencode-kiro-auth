import type { CodeWhispererMessage } from '../../plugin/types'

// Kiro requires synthetic turns in a few alternation gaps. Keep them nonempty but invisible
// because visible filler can be learned and echoed as an assistant response.
export const SYNTHETIC_TURN_CONTENT = '\u2063'

export function getToolResultText(value: any): string {
  return unwrapSystemReminders(getContentText(value))
}

function unwrapSystemReminders(text: string): string {
  return text.replace(/<system-reminder>\s*([\s\S]*?)\s*<\/system-reminder>/g, '$1')
}

export function sanitizeHistory(history: CodeWhispererMessage[]): CodeWhispererMessage[] {
  const result: CodeWhispererMessage[] = []
  for (let i = 0; i < history.length; i++) {
    const m = history[i]
    if (!m) continue
    if (m.assistantResponseMessage?.toolUses) {
      const next = history[i + 1]
      if (next?.userInputMessage?.userInputMessageContext?.toolResults) {
        result.push(m)
      }
    } else if (m.userInputMessage?.userInputMessageContext?.toolResults) {
      const prev = result[result.length - 1]
      if (prev?.assistantResponseMessage?.toolUses) {
        result.push(m)
      }
    } else {
      result.push(m)
    }
  }

  while (result.length > 0) {
    const first = result[0]
    if (first?.userInputMessage && !first.userInputMessage.userInputMessageContext?.toolResults)
      break
    result.shift()
  }
  if (result.length === 0) return []

  while (result.length > 0 && result[result.length - 1]?.assistantResponseMessage) {
    result.pop()
  }

  return result
}

export function findOriginalToolCall(msgs: any[], toolUseId: string): any | null {
  for (const m of msgs) {
    if (m.role === 'assistant') {
      if (m.tool_calls) {
        for (const tc of m.tool_calls) if (tc.id === toolUseId) return tc
      }
      if (Array.isArray(m.content)) {
        for (const p of m.content) if (p.type === 'tool_use' && p.id === toolUseId) return p
      }
    }
  }
  return null
}

export function mergeAdjacentMessages(msgs: any[]): any[] {
  const merged: any[] = []
  for (const m of msgs) {
    if (!merged.length) merged.push({ ...m })
    else {
      const last = merged[merged.length - 1]
      if (last && m.role === last.role) {
        if (Array.isArray(last.content) && Array.isArray(m.content)) last.content.push(...m.content)
        else if (typeof last.content === 'string' && typeof m.content === 'string')
          last.content += '\n' + m.content
        else if (Array.isArray(last.content) && typeof m.content === 'string')
          last.content.push({ type: 'text', text: m.content })
        else if (typeof last.content === 'string' && Array.isArray(m.content))
          last.content = [{ type: 'text', text: last.content }, ...m.content]
        if (m.tool_calls) {
          if (!last.tool_calls) last.tool_calls = []
          last.tool_calls.push(...m.tool_calls)
        }
        if (m.role === 'tool') {
          if (!last.tool_results)
            last.tool_results = [{ content: last.content, tool_call_id: last.tool_call_id }]
          last.tool_results.push({ content: m.content, tool_call_id: m.tool_call_id })
        }
      } else merged.push({ ...m })
    }
  }
  return merged
}

export function getContentText(m: any): string {
  if (!m) return ''
  if (typeof m === 'string') return m
  if (Array.isArray(m)) {
    return m
      .filter((part: any) => part?.type === 'text' || typeof part?.text === 'string')
      .map((part: any) => part.text || '')
      .join('')
  }
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content))
    return m.content
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text || '')
      .join('')
  return m.text || ''
}
