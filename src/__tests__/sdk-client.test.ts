import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import { describe, expect, test } from 'bun:test'
import { clearSdkClientCache, createSdkClient, getSdkEndpoint } from '../plugin/sdk-client'
import type { KiroAuthDetails } from '../plugin/types'

function auth(): KiroAuthDetails {
  return {
    refresh: 'refresh-token',
    access: 'access-token',
    expires: Date.now() + 3600000,
    authMethod: 'idc',
    region: 'us-east-1',
    email: 'user@example.com'
  }
}

describe('SDK client', () => {
  async function captureEffortRequest(modelId: string, additionalModelRequestFields?: object) {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1', 'kiro-runtime', 'max')
    let capturedRequest: any

    client.middlewareStack.add(
      () => async (args: any) => {
        capturedRequest = args.request
        throw new Error('captured-request')
      },
      { step: 'finalizeRequest', name: 'captureRequest', priority: 'high' }
    )

    const command = new GenerateAssistantResponseCommand({
      conversationState: {
        chatTriggerType: 'MANUAL',
        conversationId: 'test-conversation',
        currentMessage: {
          userInputMessage: {
            content: 'hello',
            modelId,
            origin: 'AI_EDITOR'
          }
        }
      },
      additionalModelRequestFields: additionalModelRequestFields as any
    })

    await client.send(command).catch((error) => {
      if (error.message !== 'captured-request') throw error
    })

    const bodyText =
      typeof capturedRequest.body === 'string'
        ? capturedRequest.body
        : Buffer.from(capturedRequest.body).toString('utf8')

    clearSdkClientCache()
    return { body: JSON.parse(bodyText), bodyText, capturedRequest }
  }

  test('uses documented FIPS endpoints for public GovCloud traffic', () => {
    expect(getSdkEndpoint('us-gov-west-1', 'kiro-runtime')).toBe(
      'https://q-fips.us-gov-west-1.amazonaws.com'
    )
    expect(getSdkEndpoint('us-gov-east-1', 'legacy-q')).toBe(
      'https://q-fips.us-gov-east-1.amazonaws.com'
    )
  })

  test('uses Kiro CLI-style standard SDK retries for throttling', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1')

    expect(await client.config.maxAttempts()).toBe(3)
    const retryMode = client.config.retryMode
    expect(typeof retryMode === 'function' ? await retryMode() : retryMode).toBe('standard')

    clearSdkClientCache()
  })

  test('injects output-config effort before content-length is computed', async () => {
    const { body, bodyText, capturedRequest } = await captureEffortRequest('claude-opus-4.7', {
      existing: true,
      output_config: { existingOutput: true }
    })

    expect(body.additionalModelRequestFields).toEqual({
      existing: true,
      thinking: { type: 'adaptive', display: 'summarized' },
      output_config: { existingOutput: true, effort: 'max' }
    })
    expect(Number(capturedRequest.headers['content-length'])).toBe(Buffer.byteLength(bodyText))
  })

  test('injects reasoning effort for GPT-5.6 without Claude-only fields', async () => {
    const { body, bodyText, capturedRequest } = await captureEffortRequest('gpt-5.6-sol', {
      existing: true,
      reasoning: { existingReasoning: true }
    })

    expect(body.additionalModelRequestFields).toEqual({
      existing: true,
      reasoning: { existingReasoning: true, effort: 'max' }
    })
    expect(Number(capturedRequest.headers['content-length'])).toBe(Buffer.byteLength(bodyText))
  })
})
