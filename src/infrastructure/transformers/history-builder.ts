import { KIRO_CONSTANTS } from '../../constants.js'
import {
  convertImagesToKiroFormat,
  extractAllImages,
  extractTextFromParts
} from '../../plugin/image-handler.js'
import type { CodeWhispererMessage } from '../../plugin/types'
import { getContentText, sanitizeHistory, truncate } from './message-transformer.js'
import { deduplicateToolResults } from './tool-transformer.js'

export function buildHistory(
  msgs: any[],
  resolved: string,
  system: string | undefined,
  toolResultLimit: number
): CodeWhispererMessage[] {
  let history: CodeWhispererMessage[] = []
  let firstUserIndex = -1
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'user') {
      firstUserIndex = i
      break
    }
  }
  if (system) {
    if (firstUserIndex !== -1) {
      const m = msgs[firstUserIndex]
      const oldContent = getContentText(m)
      if (Array.isArray(m.content)) {
        m.content = [
          { type: 'text', text: `${system}\n\n${oldContent}` },
          ...m.content.filter((p: any) => p.type !== 'text')
        ]
      } else m.content = `${system}\n\n${oldContent}`
    } else {
      history.push({
        userInputMessage: {
          content: system,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        }
      })
    }
  }
  for (let i = 0; i < msgs.length - 1; i++) {
    const m = msgs[i]
    if (!m) continue
    if (m.role === 'user') {
      const uim: any = { content: '', origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR }
      const trs: any[] = []

      if (Array.isArray(m.content)) {
        uim.content = extractTextFromParts(m.content)

        for (const p of m.content) {
          if (p.type === 'tool_result') {
            trs.push({
              content: [{ text: truncate(getContentText(p.content || p), toolResultLimit) }],
              status: 'success',
              toolUseId: p.tool_use_id
            })
          }
        }

        const unifiedImages = extractAllImages(m.content)
        if (unifiedImages.length > 0) {
          uim.images = convertImagesToKiroFormat(unifiedImages)
        }
      } else {
        uim.content = getContentText(m)
      }

      if (trs.length) uim.userInputMessageContext = { toolResults: deduplicateToolResults(trs) }
      const prev = history[history.length - 1]
      if (prev && prev.userInputMessage)
        history.push({ assistantResponseMessage: { content: 'Continue' } })
      history.push({ userInputMessage: uim })
    } else if (m.role === 'tool') {
      const trs: any[] = []
      if (m.tool_results) {
        for (const tr of m.tool_results)
          trs.push({
            content: [{ text: truncate(getContentText(tr), toolResultLimit) }],
            status: 'success',
            toolUseId: tr.tool_call_id
          })
      } else {
        trs.push({
          content: [{ text: truncate(getContentText(m), toolResultLimit) }],
          status: 'success',
          toolUseId: m.tool_call_id
        })
      }
      const prev = history[history.length - 1]
      if (prev && prev.userInputMessage)
        history.push({ assistantResponseMessage: { content: 'Continue' } })
      history.push({
        userInputMessage: {
          content: 'Tool results provided.',
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR,
          userInputMessageContext: { toolResults: deduplicateToolResults(trs) }
        }
      })
    } else if (m.role === 'assistant') {
      const arm: any = { content: '' }
      const tus: any[] = []
      let th = ''
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === 'text') arm.content += p.text || ''
          else if (p.type === 'thinking') th += p.thinking || p.text || ''
          else if (p.type === 'tool_use')
            tus.push({ input: p.input, name: p.name, toolUseId: p.id })
        }
      } else arm.content = getContentText(m)
      if (m.tool_calls && Array.isArray(m.tool_calls)) {
        for (const tc of m.tool_calls) {
          tus.push({
            input:
              typeof tc.function?.arguments === 'string'
                ? JSON.parse(tc.function.arguments)
                : tc.function?.arguments,
            name: tc.function?.name,
            toolUseId: tc.id
          })
        }
      }
      if (th)
        arm.content = arm.content
          ? `<thinking>${th}</thinking>\n\n${arm.content}`
          : `<thinking>${th}</thinking>`
      if (tus.length) arm.toolUses = tus

      if (!arm.content && !arm.toolUses) {
        continue
      }

      history.push({ assistantResponseMessage: arm })
    }
  }
  return history
}

export function truncateHistory(
  history: CodeWhispererMessage[],
  historyLimit: number
): CodeWhispererMessage[] {
  let sanitized = sanitizeHistory(history)
  let historySize = JSON.stringify(sanitized).length
  while (historySize > historyLimit && sanitized.length > 2) {
    sanitized.shift()
    while (sanitized.length > 0) {
      const first = sanitized[0]
      if (first && first.userInputMessage) break
      sanitized.shift()
    }
    sanitized = sanitizeHistory(sanitized)
    historySize = JSON.stringify(sanitized).length
  }
  return sanitized
}

export function historyHasToolCalling(history: CodeWhispererMessage[]): boolean {
  return history.some(
    (h) =>
      h.assistantResponseMessage?.toolUses ||
      h.userInputMessage?.userInputMessageContext?.toolResults
  )
}

export function extractToolNamesFromHistory(history: CodeWhispererMessage[]): Set<string> {
  const toolNames = new Set<string>()
  for (const h of history) {
    if (h.assistantResponseMessage?.toolUses) {
      for (const tu of h.assistantResponseMessage.toolUses) {
        if (tu.name) toolNames.add(tu.name)
      }
    }
  }
  return toolNames
}
