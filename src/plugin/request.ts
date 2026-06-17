import * as crypto from 'crypto'
import * as os from 'os'
import { KIRO_CONSTANTS, buildUrl, extractRegionFromArn } from '../constants.js'
import {
  buildHistory,
  extractToolNamesFromHistory,
  historyHasToolCalling,
  injectSystemPrompt
} from '../infrastructure/transformers/history-builder.js'
import {
  findOriginalToolCall,
  getContentText,
  mergeAdjacentMessages
} from '../infrastructure/transformers/message-transformer.js'
import {
  buildToolNameMaps,
  convertToolsToCodeWhisperer,
  deduplicateToolResults,
  shortenToolName
} from '../infrastructure/transformers/tool-transformer.js'
import { imageCache } from './image-cache.js'
import {
  MAX_KIRO_IMAGES,
  convertImagesToKiroFormat,
  extractAllImages,
  extractTextFromParts,
  type KiroImage
} from './image-handler.js'
import { resolveKiroModel } from './models.js'
import { resolveKiroEndpoint } from './sdk-client.js'
import { kiroDb } from './storage/sqlite.js'
import type {
  CodeWhispererRequest,
  KiroAuthDetails,
  PreparedRequest,
  SdkPreparedRequest
} from './types'

// Stable conversationId + agentContinuationId per thread, persisted in SQLite.
function deriveConversationIds(
  workspace: string,
  firstUserContent: string,
  isNewThread: boolean
): { convId: string; agentContinuationId: string; fingerprint: string } {
  const fingerprint = crypto
    .createHash('sha256')
    .update(workspace + '\0' + (firstUserContent || '_empty_'))
    .digest('hex')
    .slice(0, 32)

  if (!isNewThread) {
    const existing = kiroDb.getConversationId(workspace, fingerprint)
    if (existing) {
      if (!existing.agentContinuationId) {
        existing.agentContinuationId = crypto.randomUUID()
        kiroDb.setConversationId(
          workspace,
          fingerprint,
          existing.convId,
          existing.agentContinuationId
        )
      }
      return { ...existing, fingerprint }
    }
  }

  const convId = crypto.randomUUID()
  const agentContinuationId = crypto.randomUUID()
  kiroDb.setConversationId(workspace, fingerprint, convId, agentContinuationId)
  return { convId, agentContinuationId, fingerprint }
}

interface TransformResult {
  request: CodeWhispererRequest
  resolved: string
  convId: string
  agentContinuationId: string
  fingerprint: string
  toolNameMapper?: (name: string) => string
}

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

function buildCodeWhispererRequest(
  body: any,
  model: string,
  auth: KiroAuthDetails,
  think = false,
  budget = 16000,
  showToast?: ToastFunction,
  workspace = '',
  carryForward = true,
  effort: 'low' | 'medium' | 'high' | 'default' = 'default'
): TransformResult {
  const req = typeof body === 'string' ? JSON.parse(body) : body
  const { messages, tools, system } = req
  if (!messages || messages.length === 0) throw new Error('No messages')

  const systemMsgs = messages.filter((m: any) => m.role === 'system')
  const otherMsgs = messages.filter((m: any) => m.role !== 'system')
  let sys = system || ''
  if (systemMsgs.length > 0) {
    const extractedSystem = systemMsgs.map((m: any) => getContentText(m)).join('\n\n')
    sys = sys ? `${sys}\n\n${extractedSystem}` : extractedSystem
  }
  if (think) {
    // Use adaptive mode with explicit effort when the user picked a level,
    // otherwise fall back to the enabled/max_thinking_length form.
    //
    // adaptive + thinking_effort: Kiro decides the thinking depth within the
    // effort band. This is the modern approach used by kiro-gateway and others.
    //
    // enabled + max_thinking_length: legacy explicit budget cap.
    let pfx: string
    if (effort !== 'default') {
      pfx = `<thinking_mode>adaptive</thinking_mode><thinking_effort>${effort}</thinking_effort>`
    } else {
      pfx = `<thinking_mode>enabled</thinking_mode><max_thinking_length>${budget}</max_thinking_length>`
    }
    sys = sys.includes('<thinking_mode>') ? sys : sys ? `${pfx}\n${sys}` : pfx
  }
  const msgs = mergeAdjacentMessages([...otherMsgs])
  const lastMsg = msgs[msgs.length - 1]
  if (lastMsg && lastMsg.role === 'assistant' && getContentText(lastMsg) === '{') msgs.pop()

  // isNewThread after merge — consecutive same-role messages collapse into one
  const isNewThread = msgs.length <= 1
  const firstUserMsg = msgs.find((m: any) => m.role === 'user')
  // Fingerprint must be stable across image-stripping by OpenCode on subsequent
  // turns — using JSON.stringify(content) here would mix in base64 image bytes
  // and produce a different fingerprint once those parts are gone, breaking
  // both convId stability and the image-carry-forward cache.
  const firstUserContent = firstUserMsg
    ? typeof firstUserMsg.content === 'string'
      ? firstUserMsg.content
      : extractTextFromParts(firstUserMsg.content)
    : ''
  const { convId, agentContinuationId, fingerprint } = deriveConversationIds(
    workspace,
    firstUserContent,
    isNewThread
  )
  const resolved = resolveKiroModel(model)
  const toolMaps = tools ? buildToolNameMaps(tools) : undefined
  const cwTools = tools ? convertToolsToCodeWhisperer(tools) : []
  let history = buildHistory(msgs, resolved)

  const curMsg = msgs[msgs.length - 1]
  if (!curMsg) throw new Error('Empty')

  const isRealUserMsg =
    curMsg.role === 'user' &&
    !(Array.isArray(curMsg.content) && curMsg.content.some((p: any) => p.type === 'tool_result'))

  if (isRealUserMsg && msgs.length >= 2) {
    const prevMsg = msgs[msgs.length - 2]
    if (prevMsg?.role === 'assistant') {
      const lastHistEntry = history[history.length - 1]
      const historyEndsWithUser = lastHistEntry?.userInputMessage
      if (historyEndsWithUser) {
        let prevText = ''
        if (Array.isArray(prevMsg.content)) {
          for (const p of prevMsg.content) {
            if (p.type === 'text') prevText += p.text || ''
          }
        } else prevText = getContentText(prevMsg)
        if (prevText) {
          history.push({ assistantResponseMessage: { content: prevText } })
        }
      }
    }
  }

  history = injectSystemPrompt(history, sys, resolved)
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
          arm.toolUses.push({ input: p.input, name: shortenToolName(p.name), toolUseId: p.id })
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
          name: shortenToolName(tc.function?.name),
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
    curContent = '[system: conversation continues]'
  } else {
    const prev = history[history.length - 1]
    if (prev && !prev.assistantResponseMessage)
      history.push({ assistantResponseMessage: { content: '[system: conversation continues]' } })
    if (curMsg.role === 'tool') {
      if (curMsg.tool_results) {
        for (const tr of curMsg.tool_results)
          curTrs.push({
            content: [{ text: getContentText(tr) }],
            status: 'success',
            toolUseId: tr.tool_call_id
          })
      } else {
        curTrs.push({
          content: [{ text: getContentText(curMsg) }],
          status: 'success',
          toolUseId: curMsg.tool_call_id
        })
      }
    } else if (Array.isArray(curMsg.content)) {
      curContent = extractTextFromParts(curMsg.content)

      for (const p of curMsg.content) {
        if (p.type === 'tool_result') {
          curTrs.push({
            content: [{ text: getContentText(p.content || p) }],
            status: 'success',
            toolUseId: p.tool_use_id
          })
        }
      }

      const unifiedImages = extractAllImages(curMsg.content)
      if (unifiedImages.length > 0) {
        const { images, omitted } = convertImagesToKiroFormat(unifiedImages)
        curImgs.push(...images)
        if (omitted > 0) {
          curContent += `\n\n[${omitted} image(s) omitted due to API limits]`
        }
      }
    } else curContent = getContentText(curMsg)
    if (!curContent)
      curContent = curTrs.length ? 'Tool results provided.' : '[system: conversation continues]'
  }
  const request: CodeWhispererRequest = {
    conversationState: {
      agentContinuationId,
      agentTaskType: 'vibe',
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
  if (auth.profileArn) request.profileArn = auth.profileArn
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
            name: shortenToolName(originalCall.name || originalCall.function?.name || 'tool'),
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
    if (!prev || prev.assistantResponseMessage) {
      history.push({
        userInputMessage: {
          content: 'Running tools...',
          modelId: resolved,
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

  // Strip empty toolUses arrays from history (Kiro quirk)
  for (const h of history) {
    if (h.assistantResponseMessage?.toolUses && h.assistantResponseMessage.toolUses.length === 0) {
      delete h.assistantResponseMessage.toolUses
    }
  }

  // Trim history if payload exceeds Kiro's ~615KB limit.
  // Compute per-entry sizes once and shrink incrementally to avoid O(N²)
  // re-stringifying the full request on every iteration.
  const MAX_PAYLOAD_BYTES = 600_000
  if (history.length > 2) {
    const sizes = history.map((h) => JSON.stringify(h).length + 1)
    const baseRequest: any = { ...request, conversationState: { ...request.conversationState } }
    delete baseRequest.conversationState.history
    let totalSize = JSON.stringify(baseRequest).length + 2 // for `"history":[]`
    for (const s of sizes) totalSize += s

    while (history.length > 2 && totalSize > MAX_PAYLOAD_BYTES) {
      // Drop the two oldest entries (typically user + assistant pair).
      totalSize -= (sizes.shift() || 0) + (sizes.shift() || 0)
      history.splice(0, 2)

      // Strip leading orphans: assistantResponseMessage can't start the history.
      while (history.length > 0 && history[0]?.assistantResponseMessage) {
        totalSize -= sizes.shift() || 0
        history.shift()
      }

      // Strip leading toolResult-only userInputMessages whose toolUseIds are gone.
      const toolUseIds = new Set<string>(
        history.flatMap(
          (h) => h.assistantResponseMessage?.toolUses?.map((tu: any) => tu.toolUseId) ?? []
        )
      )
      while (history.length > 0) {
        const trs = history[0]?.userInputMessage?.userInputMessageContext?.toolResults
        if (!trs) break
        const allMatched = trs.every((tr: any) => toolUseIds.has(tr.toolUseId))
        if (allMatched) break
        totalSize -= sizes.shift() || 0
        history.shift()
      }
    }
  }

  // Image carry-forward (runs AFTER trim, on the actual wire state).
  // Cache whatever images survive the trim; if nothing survives, restore the
  // most recent set from cache onto currentMessage so the model keeps seeing
  // them across agentic turns where OpenCode has stripped them upstream.
  if (carryForward && uim) {
    const wireImages: KiroImage[] = []
    if (uim.images && uim.images.length > 0) wireImages.push(...(uim.images as KiroImage[]))
    for (const h of history) {
      const imgs = h.userInputMessage?.images as KiroImage[] | undefined
      if (imgs && imgs.length > 0) wireImages.push(...imgs)
    }

    if (wireImages.length > 0) {
      imageCache.upsert(workspace, fingerprint, wireImages)
    } else {
      const cached = imageCache.get(workspace, fingerprint)
      if (cached && cached.length > 0) {
        uim.images = cached.slice(0, MAX_KIRO_IMAGES)
      }
    }
  }

  return {
    request,
    resolved,
    convId,
    agentContinuationId,
    fingerprint,
    toolNameMapper: toolMaps?.fromKiroName
  }
}

export function transformToCodeWhisperer(
  url: string,
  body: any,
  model: string,
  auth: KiroAuthDetails,
  think = false,
  budget = 16000,
  workspace = '',
  carryForward = true,
  effort: 'low' | 'medium' | 'high' | 'default' = 'default'
): PreparedRequest {
  const { request, resolved, convId } = buildCodeWhispererRequest(
    body,
    model,
    auth,
    think,
    budget,
    undefined,
    workspace,
    carryForward,
    effort
  )
  const osP = os.platform(),
    osR = os.release(),
    nodeV = process.version.replace('v', '')
  const osN =
    osP === 'win32' ? `windows#${osR}` : osP === 'darwin' ? `macos#${osR}` : `${osP}#${osR}`
  const ua = `aws-sdk-js/3.738.0 ua/2.1 os/${osN} lang/js md/nodejs#${nodeV} api/codewhisperer#3.738.0 m/E KiroIDE`
  return {
    url: buildUrl(KIRO_CONSTANTS.BASE_URL, extractRegionFromArn(auth.profileArn) ?? auth.region),
    init: {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${auth.access}`,
        'amz-sdk-invocation-id': crypto.randomUUID(),
        'amz-sdk-request': 'attempt=1; max=1',
        'x-amzn-kiro-agent-mode': 'vibe',
        'x-amz-user-agent': 'aws-sdk-js/3.738.0 KiroIDE',
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

export function transformToSdkRequest(
  body: any,
  model: string,
  auth: KiroAuthDetails,
  think = false,
  budget = 16000,
  showToast?: ToastFunction,
  workspace = '',
  carryForward = true,
  effort: 'low' | 'medium' | 'high' | 'default' = 'default'
): SdkPreparedRequest {
  const { request, resolved, convId, fingerprint, toolNameMapper } = buildCodeWhispererRequest(
    body,
    model,
    auth,
    think,
    budget,
    showToast,
    workspace,
    carryForward,
    effort
  )
  const region = extractRegionFromArn(auth.profileArn) ?? auth.region
  // resolveKiroEndpoint returns the full URL including /generateAssistantResponse.
  // Strip the path so the endpoint field holds only the base (what the SDK uses).
  const endpointFull = resolveKiroEndpoint(auth)
  const endpoint = endpointFull.replace(/\/generateAssistantResponse$/, '')
  return {
    conversationState: request.conversationState,
    profileArn: request.profileArn,
    streaming: true,
    effectiveModel: resolved,
    conversationId: convId,
    conversationKey: { workspace, fingerprint },
    region,
    endpoint,
    toolNameMapper
  }
}
