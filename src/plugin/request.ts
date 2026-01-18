import * as crypto from 'crypto'
import * as os from 'os'
import type {
  KiroAuthDetails,
  PreparedRequest,
  CodeWhispererMessage,
  CodeWhispererRequest
} from './types'
import { KIRO_CONSTANTS } from '../constants.js'
import { resolveKiroModel } from './models.js'
import * as logger from './logger.js'

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  const half = Math.floor(max / 2)
  return s.substring(0, half) + '\n... [TRUNCATED] ...\n' + s.substring(s.length - half)
}

function sanitizeHistory(history: CodeWhispererMessage[]): CodeWhispererMessage[] {
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
  return result
}

export function transformToCodeWhisperer(
  url: string,
  body: any,
  model: string,
  auth: KiroAuthDetails,
  think = false,
  budget = 20000
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
  const cwTools = tools ? convertToolsToCodeWhisperer(tools) : []
  let history: CodeWhispererMessage[] = []
  let firstUserIndex = -1
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === 'user') {
      firstUserIndex = i
      break
    }
  }
  if (sys) {
    if (firstUserIndex !== -1) {
      const m = msgs[firstUserIndex]
      const oldContent = getContentText(m)
      if (Array.isArray(m.content)) {
        m.content = [
          { type: 'text', text: `${sys}\n\n${oldContent}` },
          ...m.content.filter((p: any) => p.type !== 'text')
        ]
      } else m.content = `${sys}\n\n${oldContent}`
    } else {
      history.push({
        userInputMessage: {
          content: sys,
          modelId: resolved,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        }
      })
    }
  }
  for (let i = 0; i < msgs.length - 1; i++) {
    const m = msgs[i]
    if (!m) continue
    if (m.role === 'user') {
      const uim: any = { content: '', modelId: resolved, origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR }
      const trs: any[] = [],
        imgs: any[] = []
      if (Array.isArray(m.content)) {
        for (const p of m.content) {
          if (p.type === 'text') uim.content += p.text || ''
          else if (p.type === 'tool_result')
            trs.push({
              content: [{ text: truncate(getContentText(p.content || p), 250000) }],
              status: 'success',
              toolUseId: p.tool_use_id
            })
          else if (p.type === 'image' && p.source)
            imgs.push({
              format: p.source.media_type?.split('/')[1] || 'png',
              source: { bytes: p.source.data }
            })
        }
      } else uim.content = getContentText(m)
      if (imgs.length) uim.images = imgs
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
            content: [{ text: truncate(getContentText(tr), 250000) }],
            status: 'success',
            toolUseId: tr.tool_call_id
          })
      } else {
        trs.push({
          content: [{ text: truncate(getContentText(m), 250000) }],
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
      history.push({ assistantResponseMessage: arm })
    }
  }
  history = sanitizeHistory(history)
  let historySize = JSON.stringify(history).length
  while (historySize > 850000 && history.length > 2) {
    history.shift()
    while (history.length > 0) {
      const first = history[0]
      if (first && first.userInputMessage) break
      history.shift()
    }
    history = sanitizeHistory(history)
    historySize = JSON.stringify(history).length
  }
  const curMsg = msgs[msgs.length - 1]
  if (!curMsg) throw new Error('Empty')
  let curContent = ''
  const curTrs: any[] = [],
    curImgs: any[] = []
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
    history.push({ assistantResponseMessage: arm })
    curContent = 'Continue'
  } else {
    const prev = history[history.length - 1]
    if (prev && !prev.assistantResponseMessage)
      history.push({ assistantResponseMessage: { content: 'Continue' } })
    if (curMsg.role === 'tool') {
      if (curMsg.tool_results) {
        for (const tr of curMsg.tool_results)
          curTrs.push({
            content: [{ text: truncate(getContentText(tr), 250000) }],
            status: 'success',
            toolUseId: tr.tool_call_id
          })
      } else {
        curTrs.push({
          content: [{ text: truncate(getContentText(curMsg), 250000) }],
          status: 'success',
          toolUseId: curMsg.tool_call_id
        })
      }
    } else if (Array.isArray(curMsg.content)) {
      for (const p of curMsg.content) {
        if (p.type === 'text') curContent += p.text || ''
        else if (p.type === 'tool_result')
          curTrs.push({
            content: [{ text: truncate(getContentText(p.content || p), 250000) }],
            status: 'success',
            toolUseId: p.tool_use_id
          })
        else if (p.type === 'image' && p.source)
          curImgs.push({
            format: p.source.media_type?.split('/')[1] || 'png',
            source: { bytes: p.source.data }
          })
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
          modelId: resolved,
          origin: KIRO_CONSTANTS.ORIGIN_AI_EDITOR
        }
      }
    }
  }
  if (history.length > 0) (request.conversationState as any).history = history
  const uim = request.conversationState.currentMessage.userInputMessage
  if (uim) {
    if (curImgs.length) uim.images = curImgs
    const ctx: any = {}
    if (curTrs.length) ctx.toolResults = deduplicateToolResults(curTrs)
    if (cwTools.length) ctx.tools = cwTools
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

export function convertToolsToCodeWhisperer(tools: any[]): any[] {
  return tools.map((t) => ({
    toolSpecification: {
      name: t.name || t.function?.name,
      description: (t.description || t.function?.description || '').substring(0, 9216),
      inputSchema: { json: t.input_schema || t.function?.parameters || {} }
    }
  }))
}

function getContentText(m: any): string {
  if (!m) return ''
  if (typeof m === 'string') return m
  if (typeof m.content === 'string') return m.content
  if (Array.isArray(m.content))
    return m.content
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text || '')
      .join('')
  return m.text || ''
}

function deduplicateToolResults(trs: any[]): any[] {
  const u: any[] = [],
    s = new Set()
  for (const t of trs) {
    if (!s.has(t.toolUseId)) {
      s.add(t.toolUseId)
      u.push(t)
    }
  }
  return u
}

function historyHasToolCalling(history: CodeWhispererMessage[]): boolean {
  return history.some(
    (h) =>
      h.assistantResponseMessage?.toolUses ||
      h.userInputMessage?.userInputMessageContext?.toolResults
  )
}

function extractToolNamesFromHistory(history: CodeWhispererMessage[]): Set<string> {
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
