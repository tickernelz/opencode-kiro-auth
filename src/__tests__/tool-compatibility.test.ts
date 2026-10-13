import { describe, expect, test } from 'bun:test'
import { ResponseHandler } from '../core/request/response-handler.js'
import {
  convertToolsToCodeWhisperer,
  restoreToolName
} from '../infrastructure/transformers/tool-transformer.js'
import { transformToSdkRequest } from '../plugin/request.js'
import { transformSdkStream } from '../plugin/streaming/sdk-stream-transformer.js'

const MODEL = 'claude-sonnet-4-6'
const LONG_TOOL_NAME = `datadog_${'security_findings_'.repeat(4)}ticket_suggestions`

const auth: any = {
  access: 'access-token',
  refresh: 'refresh-token',
  expires: Date.now() + 60_000,
  authMethod: 'idc',
  region: 'us-east-1'
}

function sdkResponse(name: string) {
  return {
    generateAssistantResponseResponse: (async function* () {
      yield {
        toolUseEvent: {
          name,
          toolUseId: 'tool-use-1',
          input: '{"query":"status"}',
          stop: true
        }
      }
    })()
  }
}

function toolSpec(output: any[], index = 0) {
  return output[index]?.toolSpecification
}

describe('CodeWhisperer tool compatibility', () => {
  test('recursively sanitizes JSON Schema without mutating the source', () => {
    const source = {
      $schema: 'https://json-schema.org/draft/2020-12/schema',
      $defs: {
        identifier: { type: 'integer', minimum: 0 },
        baseConfig: {
          type: 'object',
          properties: { base: { type: 'string' } },
          required: ['base']
        }
      },
      type: 'object',
      additionalProperties: false,
      properties: {
        count: {
          type: 'integer',
          minimum: 1,
          maximum: 10,
          default: 2,
          description: 'Count'
        },
        choice: {
          description: 'Choice',
          anyOf: [{ type: 'string', enum: ['a', 'b', null], maxLength: 10 }, { type: 'null' }]
        },
        trueUnion: {
          description: 'String or number',
          oneOf: [{ type: 'string' }, { type: 'number' }]
        },
        equivalentUnion: {
          oneOf: [
            {
              type: 'object',
              properties: { a: { type: 'string' }, b: { type: 'number' } },
              required: ['a']
            },
            {
              type: 'object',
              properties: { b: { type: 'number' }, a: { type: 'string' } },
              required: ['a']
            }
          ]
        },
        viaRef: {
          $ref: '#/$defs/identifier',
          description: 'Identifier'
        },
        malformed: {
          type: 'string',
          properties: { nested: { type: 'boolean' } }
        },
        extended: {
          $ref: '#/$defs/baseConfig',
          allOf: [
            {
              type: 'object',
              properties: { extra: { type: 'boolean' } },
              required: ['extra']
            }
          ]
        },
        config: {
          allOf: [
            {
              type: 'object',
              properties: { left: { type: 'boolean', const: true } },
              required: ['left']
            },
            {
              type: 'object',
              properties: { right: { type: 'integer', example: 1 } },
              required: ['right']
            }
          ]
        }
      },
      required: ['count', 'viaRef', 'missing', 'count']
    }
    const snapshot = structuredClone(source)

    const converted = convertToolsToCodeWhisperer([
      { name: 'schema_test', description: 'schema test', input_schema: source }
    ])

    expect(toolSpec(converted).inputSchema.json).toEqual({
      type: 'object',
      properties: {
        count: { type: 'number', description: 'Count' },
        choice: { type: 'string', description: 'Choice', enum: ['a', 'b'] },
        trueUnion: { description: 'String or number' },
        equivalentUnion: {
          type: 'object',
          properties: {
            a: { type: 'string' },
            b: { type: 'number' }
          },
          required: ['a']
        },
        viaRef: { type: 'number', description: 'Identifier' },
        malformed: {
          type: 'object',
          properties: { nested: { type: 'boolean' } }
        },
        extended: {
          type: 'object',
          properties: {
            base: { type: 'string' },
            extra: { type: 'boolean' }
          },
          required: ['base', 'extra']
        },
        config: {
          type: 'object',
          properties: {
            left: { type: 'boolean' },
            right: { type: 'number' }
          },
          required: ['left', 'right']
        }
      },
      required: ['count', 'viaRef']
    })
    expect(source).toEqual(snapshot)
  })

  test('bounds recursive schemas instead of overflowing or retaining cycles', () => {
    const cyclic: any = { type: 'object', properties: {} }
    cyclic.properties.self = cyclic

    const converted = convertToolsToCodeWhisperer([
      { name: 'cyclic_schema', description: 'cycle', input_schema: cyclic }
    ])
    const schema = toolSpec(converted).inputSchema.json

    expect(schema.type).toBe('object')
    expect(schema.properties.self).toEqual({})
    expect(schema.properties.self).not.toBe(schema)
  })

  test('creates deterministic valid aliases, caps descriptions, and drops unusable duplicates', () => {
    const secondLongName = `${LONG_TOOL_NAME}_different`
    const longDescription = `${'😀'.repeat(1023)}abcdefghij`
    const input = [
      { name: 'search_docs', description: 'valid', input_schema: { type: 'object' } },
      { name: LONG_TOOL_NAME, description: longDescription, input_schema: { type: 'object' } },
      { name: secondLongName, description: 'second', input_schema: { type: 'object' } },
      { name: '9bad-tool/name', description: 'invalid', input_schema: { type: 'object' } },
      { name: LONG_TOOL_NAME, description: 'duplicate', input_schema: { type: 'object' } },
      { description: 'missing name', input_schema: { type: 'object' } }
    ]

    const converted = convertToolsToCodeWhisperer(input)
    const names = converted.map((tool) => tool.toolSpecification.name)

    expect(converted).toHaveLength(4)
    expect(names[0]).toBe('search_docs')
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      expect(name.length).toBeLessThanOrEqual(64)
      expect(name).toMatch(/^[A-Za-z][A-Za-z0-9_]*$/)
    }
    expect(names[1]).not.toBe(LONG_TOOL_NAME)
    expect(names[2]).not.toBe(secondLongName)
    expect(names[1]).not.toBe(names[2])
    expect([...toolSpec(converted, 1).description]).toHaveLength(1024)

    const reordered = convertToolsToCodeWhisperer([input[2], input[1]])
    expect(toolSpec(reordered, 0).name).toBe(names[2])
    expect(toolSpec(reordered, 1).name).toBe(names[1])
  })

  test('never lets a generated alias shadow an existing valid tool name', () => {
    const firstGeneratedAlias = toolSpec(
      convertToolsToCodeWhisperer([
        { name: LONG_TOOL_NAME, description: 'long', input_schema: { type: 'object' } }
      ])
    ).name
    const tools = [
      { name: firstGeneratedAlias, description: 'reserved', input_schema: { type: 'object' } },
      { name: LONG_TOOL_NAME, description: 'long', input_schema: { type: 'object' } }
    ]

    const converted = convertToolsToCodeWhisperer(tools)
    const reversed = convertToolsToCodeWhisperer([...tools].reverse())

    expect(toolSpec(converted, 0).name).toBe(firstGeneratedAlias)
    expect(toolSpec(converted, 1).name).not.toBe(firstGeneratedAlias)
    expect(toolSpec(reversed, 0).name).toBe(toolSpec(converted, 1).name)
    expect(toolSpec(reversed, 1).name).toBe(firstGeneratedAlias)
  })

  test('never resolves aliases through Object prototype properties', () => {
    expect(restoreToolName('constructor', {})).toBe('constructor')
    expect(restoreToolName('toString', {})).toBe('toString')
  })

  test('normalizes malformed non-array tools instead of throwing an internal map error', () => {
    for (const tools of [{}, 'oops', 42, null]) {
      const prepared: any = transformToSdkRequest(
        { messages: [{ role: 'user', content: 'Hello' }], tools },
        MODEL,
        auth
      )
      expect(
        prepared.conversationState.currentMessage.userInputMessage.userInputMessageContext?.tools
      ).toBeUndefined()
    }
  })

  test('uses the same wire alias in tool specifications and replayed history', () => {
    const prepared: any = transformToSdkRequest(
      {
        messages: [
          { role: 'user', content: 'Run the tool' },
          {
            role: 'assistant',
            content: '',
            tool_calls: [
              {
                id: 'tool-use-1',
                type: 'function',
                function: { name: LONG_TOOL_NAME, arguments: '{"query":"status"}' }
              }
            ]
          },
          { role: 'tool', tool_call_id: 'tool-use-1', content: 'ok' },
          { role: 'user', content: 'Continue' }
        ],
        tools: [
          {
            type: 'function',
            function: {
              name: LONG_TOOL_NAME,
              description: 'Look up status',
              parameters: { type: 'object', properties: { query: { type: 'string' } } }
            }
          }
        ]
      },
      MODEL,
      auth
    )

    const wireName =
      prepared.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0]
        .toolSpecification.name
    const historyName = prepared.conversationState.history
      .flatMap((entry: any) => entry.assistantResponseMessage?.toolUses || [])
      .find((toolUse: any) => toolUse.toolUseId === 'tool-use-1').name

    expect(wireName).not.toBe(LONG_TOOL_NAME)
    expect(historyName).toBe(wireName)
    expect(prepared.toolNameMap[wireName]).toBe(LONG_TOOL_NAME)
  })

  test('aliases history-only tool names when current tool declarations are absent', () => {
    const prepared: any = transformToSdkRequest(
      {
        messages: [
          {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: LONG_TOOL_NAME, arguments: '{"query":"security"}' }
              }
            ]
          }
        ]
      },
      MODEL,
      auth
    )

    const history = prepared.conversationState.history
    const wireName = history.find((entry: any) => entry.assistantResponseMessage?.toolUses)
      .assistantResponseMessage.toolUses[0].name
    const placeholderName =
      prepared.conversationState.currentMessage.userInputMessage.userInputMessageContext.tools[0]
        .toolSpecification.name

    expect(wireName).not.toBe(LONG_TOOL_NAME)
    expect(wireName).toMatch(/^[A-Za-z][A-Za-z0-9_]{0,63}$/)
    expect(placeholderName).toBe(wireName)
    expect(prepared.toolNameMap[wireName]).toBe(LONG_TOOL_NAME)
  })

  test('restores original tool names in streaming responses', async () => {
    const wireName = 'datadog_security_findings_0123456789abcdef0123456789abcdef'
    const events: any[] = []

    for await (const event of (transformSdkStream as any)(
      sdkResponse(wireName),
      MODEL,
      'conversation-1',
      { [wireName]: LONG_TOOL_NAME }
    )) {
      events.push(event)
    }

    const start = events.find((event) => event.choices?.[0]?.delta?.tool_calls?.[0]?.function?.name)
    expect(start.choices[0].delta.tool_calls[0].function.name).toBe(LONG_TOOL_NAME)
  })

  test('reassembles interleaved streaming tool events by tool-use id', async () => {
    const wireName = 'datadog_security_findings_0123456789abcdef0123456789abcdef'
    const fragmentedResponse = {
      generateAssistantResponseResponse: (async function* () {
        yield {
          toolUseEvent: {
            name: wireName,
            toolUseId: 'tool-use-1',
            input: '{"query":'
          }
        }
        yield {
          toolUseEvent: {
            name: 'search_docs',
            toolUseId: 'tool-use-2',
            input: '{"path":'
          }
        }
        yield { toolUseEvent: { toolUseId: 'tool-use-1', input: '"status"}', stop: true } }
        yield {
          toolUseEvent: { toolUseId: 'tool-use-2', input: '"README.md"}', stop: true }
        }
      })()
    }
    const events: any[] = []

    for await (const event of transformSdkStream(fragmentedResponse, MODEL, 'conversation-1', {
      [wireName]: LONG_TOOL_NAME
    })) {
      events.push(event)
    }

    const calls = new Map<number, { id?: string; name?: string; arguments: string }>()
    for (const event of events) {
      for (const fragment of event.choices?.[0]?.delta?.tool_calls || []) {
        const accumulated = calls.get(fragment.index) || { arguments: '' }
        if (fragment.id) accumulated.id = fragment.id
        if (fragment.function?.name) accumulated.name = fragment.function.name
        accumulated.arguments += fragment.function?.arguments || ''
        calls.set(fragment.index, accumulated)
      }
    }

    expect(Array.from(calls.values())).toEqual([
      {
        id: 'tool-use-1',
        name: LONG_TOOL_NAME,
        arguments: '{"query":"status"}'
      },
      {
        id: 'tool-use-2',
        name: 'search_docs',
        arguments: '{"path":"README.md"}'
      }
    ])
  })

  test('restores original tool names in non-streaming responses', async () => {
    const wireName = 'datadog_security_findings_0123456789abcdef0123456789abcdef'
    const response = await (new ResponseHandler().handleSdkSuccess as any)(
      sdkResponse(wireName),
      MODEL,
      'conversation-1',
      false,
      { [wireName]: LONG_TOOL_NAME }
    )
    const body = await response.json()

    expect(body.choices[0].message.tool_calls[0].function.name).toBe(LONG_TOOL_NAME)
  })

  test('reassembles interleaved non-streaming tool events by tool-use id', async () => {
    const wireName = 'datadog_security_findings_0123456789abcdef0123456789abcdef'
    const fragmentedResponse = {
      generateAssistantResponseResponse: (async function* () {
        yield {
          toolUseEvent: {
            name: wireName,
            toolUseId: 'tool-use-1',
            input: '{"query":'
          }
        }
        yield {
          toolUseEvent: {
            name: 'search_docs',
            toolUseId: 'tool-use-2',
            input: '{"path":'
          }
        }
        yield {
          toolUseEvent: {
            toolUseId: 'tool-use-1',
            input: '"status"}',
            stop: true
          }
        }
        yield {
          toolUseEvent: {
            toolUseId: 'tool-use-2',
            input: '"README.md"}',
            stop: true
          }
        }
      })()
    }

    const response = await new ResponseHandler().handleSdkSuccess(
      fragmentedResponse,
      MODEL,
      'conversation-1',
      false,
      { [wireName]: LONG_TOOL_NAME }
    )
    const body = await response.json()

    expect(body.choices[0].message.tool_calls).toHaveLength(2)
    expect(body.choices[0].message.tool_calls[0]).toEqual({
      id: 'tool-use-1',
      type: 'function',
      function: {
        name: LONG_TOOL_NAME,
        arguments: '{"query":"status"}'
      }
    })
    expect(body.choices[0].message.tool_calls[1]).toEqual({
      id: 'tool-use-2',
      type: 'function',
      function: {
        name: 'search_docs',
        arguments: '{"path":"README.md"}'
      }
    })
  })
})
