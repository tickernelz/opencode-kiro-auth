import { restoreToolName } from '../../infrastructure/transformers/tool-transformer.js'
import { parseEventStream } from '../../plugin/response'
import { transformKiroStream } from '../../plugin/streaming/index.js'
import { transformSdkStream } from '../../plugin/streaming/sdk-stream-transformer.js'
import type { ToolNameMap } from '../../plugin/types.js'

interface AccumulatedToolCall {
  toolUseId: string
  name?: string
  input: string
}

export class ResponseHandler {
  async handleSuccess(
    response: Response,
    model: string,
    conversationId: string,
    streaming: boolean,
    toolNameMap?: ToolNameMap
  ): Promise<Response> {
    if (streaming) {
      return this.handleStreaming(response, model, conversationId, toolNameMap)
    }
    return this.handleNonStreaming(response, model, conversationId, toolNameMap)
  }

  async handleSdkSuccess(
    sdkResponse: any,
    model: string,
    conversationId: string,
    streaming: boolean,
    toolNameMap?: ToolNameMap
  ): Promise<Response> {
    if (streaming) {
      return this.handleSdkStreaming(sdkResponse, model, conversationId, toolNameMap)
    }
    return this.handleSdkNonStreaming(sdkResponse, model, conversationId, toolNameMap)
  }

  private async handleStreaming(
    response: Response,
    model: string,
    conversationId: string,
    toolNameMap?: ToolNameMap
  ): Promise<Response> {
    const s = transformKiroStream(response, model, conversationId, toolNameMap)
    return new Response(
      new ReadableStream({
        async start(c) {
          try {
            for await (const e of s) {
              c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`))
            }
            c.close()
          } catch (err) {
            c.error(err)
          }
        }
      }),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  }

  private async handleSdkStreaming(
    sdkResponse: any,
    model: string,
    conversationId: string,
    toolNameMap?: ToolNameMap
  ): Promise<Response> {
    const s = transformSdkStream(sdkResponse, model, conversationId, toolNameMap)
    return new Response(
      new ReadableStream({
        async start(c) {
          try {
            for await (const e of s) {
              c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(e)}\n\n`))
            }
            c.close()
          } catch (err) {
            c.error(err)
          }
        }
      }),
      { headers: { 'Content-Type': 'text/event-stream' } }
    )
  }

  private async handleNonStreaming(
    response: Response,
    model: string,
    conversationId: string,
    toolNameMap?: ToolNameMap
  ): Promise<Response> {
    const text = await response.text()
    const p = parseEventStream(text, model)
    const oai: any = {
      id: conversationId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: p.content },
          finish_reason: p.stopReason === 'tool_use' ? 'tool_calls' : 'stop'
        }
      ],
      // parseEventStream only surfaces `contextUsagePercentage` from the raw
      // HTTP event stream — per-request cache read/write token counts are not
      // available on this path. Only the SDK non-streaming path below can
      // report them via MetadataEvent.tokenUsage.
      usage: {
        prompt_tokens: p.inputTokens || 0,
        completion_tokens: p.outputTokens || 0,
        total_tokens: (p.inputTokens || 0) + (p.outputTokens || 0),
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0
      }
    }

    if (p.toolCalls.length > 0) {
      oai.choices[0].message.tool_calls = p.toolCalls.map((tc) => ({
        id: tc.toolUseId,
        type: 'function',
        function: {
          name: restoreToolName(tc.name, toolNameMap),
          arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)
        }
      }))
    }

    return new Response(JSON.stringify(oai), {
      headers: { 'Content-Type': 'application/json' }
    })
  }

  private async handleSdkNonStreaming(
    sdkResponse: any,
    model: string,
    conversationId: string,
    toolNameMap?: ToolNameMap
  ): Promise<Response> {
    // For non-streaming SDK responses, collect all events
    let content = ''
    const toolCallFragments = new Map<string, AccumulatedToolCall>()
    const toolCallOrder: string[] = []
    let inputTokens = 0
    let outputTokens = 0
    let cacheReadInputTokens = 0
    let cacheWriteInputTokens = 0

    const eventStream = sdkResponse.generateAssistantResponseResponse
    if (eventStream) {
      for await (const event of eventStream) {
        if (event.assistantResponseEvent?.content) {
          content += event.assistantResponseEvent.content
        }
        if (event.toolUseEvent) {
          const fragment = event.toolUseEvent
          const toolUseId = fragment.toolUseId
          if (typeof toolUseId === 'string' && toolUseId.length > 0) {
            let accumulated = toolCallFragments.get(toolUseId)
            if (!accumulated) {
              accumulated = { toolUseId, input: '' }
              toolCallFragments.set(toolUseId, accumulated)
              toolCallOrder.push(toolUseId)
            }
            if (typeof fragment.name === 'string' && fragment.name.length > 0) {
              accumulated.name = fragment.name
            }
            if (fragment.input !== undefined) {
              accumulated.input +=
                typeof fragment.input === 'string'
                  ? fragment.input
                  : (JSON.stringify(fragment.input) ?? '')
            }
          }
        }
        if (event.metadataEvent?.tokenUsage) {
          const tu = event.metadataEvent.tokenUsage
          inputTokens = tu.inputTokens || 0
          outputTokens = tu.outputTokens || 0
          if (typeof tu.cacheReadInputTokens === 'number') {
            cacheReadInputTokens = tu.cacheReadInputTokens
          }
          if (typeof tu.cacheWriteInputTokens === 'number') {
            cacheWriteInputTokens = tu.cacheWriteInputTokens
          }
        }
      }
    }

    const toolCalls = toolCallOrder
      .map((toolUseId) => toolCallFragments.get(toolUseId))
      .filter(
        (toolCall): toolCall is AccumulatedToolCall & { name: string } =>
          typeof toolCall?.name === 'string'
      )

    const oai: any = {
      id: conversationId,
      object: 'chat.completion',
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: toolCalls.length > 0 ? 'tool_calls' : 'stop'
        }
      ],
      usage: {
        prompt_tokens: inputTokens,
        completion_tokens: outputTokens,
        total_tokens: inputTokens + outputTokens,
        cache_creation_input_tokens: cacheWriteInputTokens,
        cache_read_input_tokens: cacheReadInputTokens
      }
    }

    if (toolCalls.length > 0) {
      oai.choices[0].message.tool_calls = toolCalls.map((tc) => ({
        id: tc.toolUseId,
        type: 'function',
        function: {
          name: restoreToolName(tc.name, toolNameMap),
          arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)
        }
      }))
    }

    return new Response(JSON.stringify(oai), {
      headers: { 'Content-Type': 'application/json' }
    })
  }
}
