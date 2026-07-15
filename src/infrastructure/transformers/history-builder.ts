import { KIRO_CONSTANTS } from '../../constants.js'
import {
  convertImagesToKiroFormat,
  extractAllImages,
  extractTextFromParts
} from '../../plugin/image-handler.js'
import type { CodeWhispererMessage } from '../../plugin/types'
import { SYNTHETIC_TURN_CONTENT, getContentText } from './message-transformer.js'
import { deduplicateToolResults } from './tool-transformer.js'

/**
 * Collapse agentic loop sequences in the built history.
 *
 * Each agentic iteration gets a fresh conversationId, so the model re-derives its preamble
 * (intent detection, greeting) every iteration. When replayed for the next user turn, the
 * model sees duplicate preambles and gets confused.
 *
 * Strips text from intermediate ASST(toolUses)→USER(toolResults) pairs, keeping only the
 * first assistant text and all tool_use/tool_result pairs.
 */
export function collapseAgenticLoops(history: CodeWhispererMessage[]): CodeWhispererMessage[] {
  if (history.length < 4) return history

  const result: CodeWhispererMessage[] = []
  let i = 0

  while (i < history.length) {
    const entry = history[i]

    if (
      entry?.assistantResponseMessage?.toolUses &&
      i + 1 < history.length &&
      history[i + 1]?.userInputMessage?.userInputMessageContext?.toolResults
    ) {
      const seqStart = i

      let j = i
      while (j < history.length) {
        const asst = history[j]
        if (!asst?.assistantResponseMessage?.toolUses) break
        const nextUser = j + 1 < history.length ? history[j + 1] : null
        if (!nextUser?.userInputMessage?.userInputMessageContext?.toolResults) break
        j += 2
      }

      const seqEnd = j
      const pairCount = (seqEnd - seqStart) / 2

      if (pairCount > 1) {
        for (let k = seqStart; k < seqEnd; k += 2) {
          const asst = history[k]
          const user = history[k + 1]

          if (k === seqStart) {
            result.push(asst!)
          } else {
            result.push({
              assistantResponseMessage: {
                content: SYNTHETIC_TURN_CONTENT,
                toolUses: asst!.assistantResponseMessage!.toolUses
              }
            })
          }
          result.push(user!)
        }
      } else {
        for (let k = seqStart; k < seqEnd; k++) {
          result.push(history[k]!)
        }
      }

      i = seqEnd
    } else {
      result.push(entry!)
      i++
    }
  }

  return result
}

export function buildHistory(msgs: any[], resolved: string): CodeWhispererMessage[] {
  let history: CodeWhispererMessage[] = []
  for (let i = 0; i < msgs.length - 1; i++) {
    const m = msgs[i]
    if (!m) continue
    if (m.role === 'user') {
      const uim: any = { content: '', modelId: resolved, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR }
      const trs: any[] = []

      if (Array.isArray(m.content)) {
        uim.content = extractTextFromParts(m.content)

        for (const p of m.content) {
          if (p.type === 'tool_result') {
            trs.push({
              content: [{ text: getContentText(p.content || p) }],
              status: 'success',
              toolUseId: p.tool_use_id
            })
          }
        }

        const unifiedImages = extractAllImages(m.content)
        if (unifiedImages.length > 0) {
          const { images, omitted } = convertImagesToKiroFormat(unifiedImages)
          uim.images = images
          if (omitted > 0) {
            uim.content += `\n\n[${omitted} image(s) omitted due to API limits]`
          }
        }
      } else {
        uim.content = getContentText(m)
      }

      if (trs.length) uim.userInputMessageContext = { toolResults: deduplicateToolResults(trs) }
      const prev = history[history.length - 1]
      if (prev && prev.userInputMessage)
        history.push({ assistantResponseMessage: { content: SYNTHETIC_TURN_CONTENT } })
      history.push({ userInputMessage: uim })
    } else if (m.role === 'tool') {
      const trs: any[] = []
      if (m.tool_results) {
        for (const tr of m.tool_results)
          trs.push({
            content: [{ text: getContentText(tr) }],
            status: 'success',
            toolUseId: tr.tool_call_id
          })
      } else {
        trs.push({
          content: [{ text: getContentText(m) }],
          status: 'success',
          toolUseId: m.tool_call_id
        })
      }
      const prev = history[history.length - 1]
      if (prev && prev.userInputMessage)
        history.push({ assistantResponseMessage: { content: SYNTHETIC_TURN_CONTENT } })
      history.push({
        userInputMessage: {
          content: 'Tool results provided.',
          modelId: resolved,
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

      const prevMsg = history[history.length - 1]
      if (prevMsg && prevMsg.assistantResponseMessage) {
        // Merge consecutive assistant messages instead of injecting synthetic user turn
        const prev = prevMsg.assistantResponseMessage
        if (arm.content) {
          prev.content = prev.content ? `${prev.content}\n\n${arm.content}` : arm.content
        }
        if (arm.toolUses) {
          prev.toolUses = [...(prev.toolUses || []), ...arm.toolUses]
        }
      } else {
        history.push({ assistantResponseMessage: arm })
      }
    }
  }
  return collapseAgenticLoops(history)
}

export function injectSystemPrompt(
  history: CodeWhispererMessage[],
  system: string | undefined,
  resolved: string
): CodeWhispererMessage[] {
  if (!system) return history
  const firstUserMsg = history.find((h) => !!h.userInputMessage)
  if (firstUserMsg && firstUserMsg.userInputMessage) {
    const oldContent = firstUserMsg.userInputMessage.content || ''
    firstUserMsg.userInputMessage.content = `${system}\n\n${oldContent}`
  } else {
    history.unshift({
      userInputMessage: {
        content: system,
        modelId: resolved,
        origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
      }
    })
  }
  return history
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
