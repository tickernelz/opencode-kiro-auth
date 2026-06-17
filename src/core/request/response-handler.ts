import { parseEventStream } from '../../plugin/response'
import { transformKiroStream } from '../../plugin/streaming/index.js'
import { transformSdkStream } from '../../plugin/streaming/sdk-stream-transformer.js'

export class ResponseHandler {
  async handleSuccess(
    response: Response,
    model: string,
    conversationId: string,
    streaming: boolean
  ): Promise<Response> {
    if (streaming) {
      return this.handleStreaming(response, model, conversationId)
    }
    return this.handleNonStreaming(response, model, conversationId)
  }

  async handleSdkSuccess(
    sdkResponse: any,
    model: string,
    conversationId: string,
    streaming: boolean,
    toolNameMapper?: (name: string) => string,
    thinkingRequested = false
  ): Promise<Response> {
    if (streaming) {
      return this.handleSdkStreaming(
        sdkResponse,
        model,
        conversationId,
        toolNameMapper,
        thinkingRequested
      )
    }
    return this.handleSdkNonStreaming(sdkResponse, model, conversationId)
  }

  private async handleStreaming(
    response: Response,
    model: string,
    conversationId: string
  ): Promise<Response> {
    const s = transformKiroStream(response, model, conversationId)
    const enc = new TextEncoder()
    return new Response(
      new ReadableStream({
        async start(c) {
          try {
            for await (const e of s) {
              c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
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
    toolNameMapper?: (name: string) => string,
    thinkingRequested = false
  ): Promise<Response> {
    const s = transformSdkStream(
      sdkResponse,
      model,
      conversationId,
      toolNameMapper,
      thinkingRequested
    )
    const enc = new TextEncoder()
    return new Response(
      new ReadableStream({
        async start(c) {
          try {
            for await (const e of s) {
              c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`))
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
    conversationId: string
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
      usage: {
        prompt_tokens: p.inputTokens || 0,
        completion_tokens: p.outputTokens || 0,
        total_tokens: (p.inputTokens || 0) + (p.outputTokens || 0)
      }
    }

    if (p.toolCalls.length > 0) {
      oai.choices[0].message.tool_calls = p.toolCalls.map((tc) => ({
        id: tc.toolUseId,
        type: 'function',
        function: {
          name: tc.name,
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
    conversationId: string
  ): Promise<Response> {
    // For non-streaming SDK responses, collect all events
    let content = ''
    const toolCalls: any[] = []
    let inputTokens = 0
    let outputTokens = 0

    const eventStream = sdkResponse.generateAssistantResponseResponse
    if (eventStream) {
      for await (const event of eventStream) {
        if (event.assistantResponseEvent?.content) {
          content += event.assistantResponseEvent.content
        }
        if (event.toolUseEvent) {
          toolCalls.push(event.toolUseEvent)
        }
        if (event.metadataEvent?.tokenUsage) {
          inputTokens = event.metadataEvent.tokenUsage.inputTokens || 0
          outputTokens = event.metadataEvent.tokenUsage.outputTokens || 0
        }
      }
    }

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
        total_tokens: inputTokens + outputTokens
      }
    }

    if (toolCalls.length > 0) {
      oai.choices[0].message.tool_calls = toolCalls.map((tc) => ({
        id: tc.toolUseId,
        type: 'function',
        function: {
          name: tc.name,
          arguments: typeof tc.input === 'string' ? tc.input : JSON.stringify(tc.input)
        }
      }))
    }

    return new Response(JSON.stringify(oai), {
      headers: { 'Content-Type': 'application/json' }
    })
  }
}
