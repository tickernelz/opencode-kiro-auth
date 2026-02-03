import * as crypto from 'crypto'
import * as os from 'os'
import { KIRO_CONSTANTS } from '../constants.js'
import {
  buildHistory,
  extractToolNamesFromHistory,
  historyHasToolCalling,
  truncateHistory
} from '../infrastructure/transformers/history-builder.js'
import {
  findOriginalToolCall,
  getContentText,
  mergeAdjacentMessages,
  truncate
} from '../infrastructure/transformers/message-transformer.js'
import { deduplicateToolResults } from '../infrastructure/transformers/tool-transformer.js'
import {
  convertImagesToKiroFormat,
  extractAllImages,
  extractTextFromParts
} from './image-handler.js'
import { resolveKiroModel } from './models.js'
import type { CodeWhispererRequest, KiroAuthDetails, PreparedRequest } from './types'

export function transformToCodeWhisperer(
  url: string,
  body: any,
  model: string,
  auth: KiroAuthDetails,
  think = false,
  budget = 20000,
  reductionFactor = 1.0
): PreparedRequest {
  const req = typeof body === 'string' ? JSON.parse(body) : body
  const { messages, tools, system } = req
  const convId = crypto.randomUUID()
  if (!messages || messages.length === 0) throw new Error('No messages')
  const resolved = resolveKiroModel(model)
  let sys = system || ''
  if (think) {
    const pfx = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`
    sys = sys.includes('<thinking_mode>') ? sys : sys ? `${pfx}\n${sys}` : pfx
  }
  const msgs = mergeAdjacentMessages([...messages])
  const lastMsg = msgs[msgs.length - 1]
  if (lastMsg && lastMsg.role === 'assistant' && getContentText(lastMsg) === '{') msgs.pop()
  const cwTools: any[] = []
  const toolResultLimit = Math.floor(250000 * reductionFactor)
  let history = buildHistory(msgs, resolved, sys, toolResultLimit)
  const historyLimit = Math.floor(850000 * reductionFactor)
  history = truncateHistory(history, historyLimit)
  const curMsg = msgs[msgs.length - 1]
  if (!curMsg) throw new Error('Empty')
  let curContent = ''
  const curTrs: any[] = []
  const curImgs: any[] = []

  if (curMsg.role === 'assistant') {
    const arm: any = { content: '' }
    let th = ''
    if (Array.isArray(curMsg.content)) {
      for (const p of curMsg.content) {
        if (p.type === 'text') arm.content += p.text || ''
        else if (p.type === 'thinking') th += p.thinking || p.text || ''
        else if (p.type === 'tool_use') {
          if (!arm.toolUses) arm.toolUses = []
          arm.toolUses.push({ input: p.input, name: p.name, toolUseId: p.id })
        }
      }
    } else arm.content = getContentText(curMsg)
    if ((curMsg as any).tool_calls && Array.isArray((curMsg as any).tool_calls)) {
      if (!arm.toolUses) arm.toolUses = []
      for (const tc of (curMsg as any).tool_calls) {
        arm.toolUses.push({
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

    if (arm.content || arm.toolUses) {
      history.push({ assistantResponseMessage: arm })
    }
    curContent = 'Continue'
  } else {
    const prev = history[history.length - 1]
    if (prev && !prev.assistantResponseMessage)
      history.push({ assistantResponseMessage: { content: 'Continue' } })
    if (curMsg.role === 'tool') {
      if (curMsg.tool_results) {
        for (const tr of curMsg.tool_results)
          curTrs.push({
            content: [{ text: truncate(getContentText(tr), toolResultLimit) }],
            status: 'success',
            toolUseId: tr.tool_call_id
          })
      } else {
        curTrs.push({
          content: [{ text: truncate(getContentText(curMsg), toolResultLimit) }],
          status: 'success',
          toolUseId: curMsg.tool_call_id
        })
      }
    } else if (Array.isArray(curMsg.content)) {
      curContent = extractTextFromParts(curMsg.content)

      for (const p of curMsg.content) {
        if (p.type === 'tool_result') {
          curTrs.push({
            content: [{ text: truncate(getContentText(p.content || p), toolResultLimit) }],
            status: 'success',
            toolUseId: p.tool_use_id
          })
        }
      }

      const unifiedImages = extractAllImages(curMsg.content)
      if (unifiedImages.length > 0) {
        curImgs.push(...convertImagesToKiroFormat(unifiedImages))
      }
    } else curContent = getContentText(curMsg)
    if (!curContent) curContent = curTrs.length ? 'Tool results provided.' : 'Continue'
  }
  const request: CodeWhispererRequest = {
    conversationState: {
      chatTriggerType: KIRO_CONSTANTS.CHAT_TRIGGER_TYPE_MANUAL,
      conversationId: convId,
      currentMessage: {
        userInputMessage: {
          content: curContent,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        }
      }
    }
  }
  if (auth.profileArn) {
    request.profileArn = auth.profileArn
  }
  const toolUsesInHistory = history.flatMap((h) => h.assistantResponseMessage?.toolUses || [])
  const allToolUseIdsInHistory = new Set(toolUsesInHistory.map((tu) => tu.toolUseId))
  const finalCurTrs: any[] = []
  const orphanedTrs: any[] = []
  for (const tr of curTrs) {
    if (allToolUseIdsInHistory.has(tr.toolUseId)) finalCurTrs.push(tr)
    else {
      const originalCall = findOriginalToolCall(messages, tr.toolUseId)
      if (originalCall) {
        orphanedTrs.push({
          call: {
            name: originalCall.name || originalCall.function?.name || 'tool',
            toolUseId: tr.toolUseId,
            input:
              originalCall.input ||
              (originalCall.function?.arguments ? JSON.parse(originalCall.function.arguments) : {})
          },
          result: tr
        })
      } else {
        curContent += `\n\n[Output for tool call ${tr.toolUseId}]:\n${tr.content?.[0]?.text || ''}`
      }
    }
  }
  if (orphanedTrs.length > 0) {
    const prev = history[history.length - 1]
    if (prev && !prev.userInputMessage) {
      history.push({
        userInputMessage: {
          content: 'Running tools...',
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        }
      })
    }
    history.push({
      assistantResponseMessage: {
        content: 'I will execute the following tools.',
        toolUses: orphanedTrs.map((o) => o.call)
      }
    })
    finalCurTrs.push(...orphanedTrs.map((o) => o.result))
  }
  if (history.length > 0) (request.conversationState as any).history = history
  const uim = request.conversationState.currentMessage.userInputMessage
  if (uim) {
    uim.content = curContent
    if (curImgs.length) uim.images = curImgs
    const ctx: any = {}
    if (finalCurTrs.length) ctx.toolResults = deduplicateToolResults(finalCurTrs)
    if (cwTools.length) {
      ctx.tools = cwTools
    }
    if (Object.keys(ctx).length) uim.userInputMessageContext = ctx
    const hasToolsInHistory = historyHasToolCalling(history)
    if (hasToolsInHistory) {
      const toolNamesInHistory = extractToolNamesFromHistory(history)
      if (toolNamesInHistory.size > 0) {
        const existingTools = uim.userInputMessageContext?.tools || []
        const existingToolNames = new Set(
          existingTools.map((t: any) => t.toolSpecification?.name).filter(Boolean)
        )
        const missingToolNames = Array.from(toolNamesInHistory).filter(
          (name) => !existingToolNames.has(name)
        )
        if (missingToolNames.length > 0) {
          const placeholderTools = missingToolNames.map((name) => ({
            toolSpecification: {
              name,
              description: 'Tool',
              inputSchema: { json: { type: 'object', properties: {} } }
            }
          }))
          if (!uim.userInputMessageContext) uim.userInputMessageContext = {}
          uim.userInputMessageContext.tools = [...existingTools, ...placeholderTools]
        }
      }
    }
  }
  const machineId = crypto
    .createHash('sha256')
    .update(auth.profileArn || auth.clientId || 'KIRO_DEFAULT_MACHINE')
    .digest('hex')
  const osP = os.platform(),
    osR = os.release(),
    nodeV = process.version.replace('v', ''),
    kiroV = KIRO_CONSTANTS.KIRO_VERSION
  const osN =
    osP === 'win32' ? `windows#${osR}` : osP === 'darwin' ? `macos#${osR}` : `${osP}#${osR}`
  const ua = `aws-sdk-js/1.0.0 ua/2.1 os/${osN} lang/js md/nodejs#${nodeV} api/codewhispererruntime#1.0.0 m/E KiroIDE-${kiroV}-${machineId}`
  return {
    url: KIRO_CONSTANTS.BASE_URL.replace('{{region}}', auth.region),
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${auth.access}`,
        'amz-sdk-invocation-id': crypto.randomUUID(),
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amzn-kiro-agent-mode': 'vibe',
        'x-amz-user-agent': `aws-sdk-js/1.0.0 KiroIDE-${kiroV}-${machineId}`,
        'user-agent': ua,
        Connection: 'close'
      },
      body: JSON.stringify(request)
    },
    streaming: true,
    effectiveModel: resolved,
    conversationId: convId
  }
}
