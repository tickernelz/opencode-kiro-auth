import { GenerateAssistantResponseCommand } from '@aws/codewhisperer-streaming-client'
import { describe, expect, test } from 'bun:test'
import { clearSdkClientCache, createSdkClient, resolveKiroEndpoint } from '../plugin/sdk-client'
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

async function captureRequest(client: ReturnType<typeof createSdkClient>) {
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
          modelId: 'claude-opus-4.7',
          origin: 'AI_EDITOR'
        }
      }
    }
  })

  await client.send(command).catch((error) => {
    if (error.message !== 'captured-request') throw error
  })

  const bodyText =
    typeof capturedRequest.body === 'string'
      ? capturedRequest.body
      : Buffer.from(capturedRequest.body).toString('utf8')

  return {
    body: JSON.parse(bodyText),
    request: { headers: capturedRequest.headers, bodyText }
  }
}

describe('SDK client', () => {
  test('uses Kiro CLI-style standard SDK retries for throttling', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1')

    expect(await client.config.maxAttempts()).toBe(3)
    const retryMode = client.config.retryMode
    expect(typeof retryMode === 'function' ? await retryMode() : retryMode).toBe('standard')

    clearSdkClientCache()
  })

  test('injects effort before content-length is computed', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1', 'max')
    const { body, request } = await captureRequest(client)

    expect(body.additionalModelRequestFields.output_config.effort).toBe('max')
    expect(Number(request.headers['content-length'])).toBe(Buffer.byteLength(request.bodyText))

    clearSdkClientCache()
  })

  test('omits additionalModelRequestFields when no effort is set', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1')
    const { body } = await captureRequest(client)

    expect(body.additionalModelRequestFields).toBeUndefined()

    clearSdkClientCache()
  })

  test('injects xhigh, the level that was previously unreachable', async () => {
    clearSdkClientCache()

    const client = createSdkClient(auth(), 'us-east-1', 'xhigh')
    const { body, request } = await captureRequest(client)

    expect(body.additionalModelRequestFields.output_config.effort).toBe('xhigh')
    expect(Number(request.headers['content-length'])).toBe(Buffer.byteLength(request.bodyText))

    clearSdkClientCache()
  })

  test('does not reuse a cached client across different effort levels', () => {
    clearSdkClientCache()

    const max = createSdkClient(auth(), 'us-east-1', 'max')
    const xhigh = createSdkClient(auth(), 'us-east-1', 'xhigh')
    const maxAgain = createSdkClient(auth(), 'us-east-1', 'max')

    expect(xhigh).not.toBe(max)
    expect(maxAgain).toBe(max)

    clearSdkClientCache()
  })
})

describe('resolveKiroEndpoint region consistency', () => {
  test('Pro account: uses profileArn region even when auth.region (IDC/SSO home region) differs', () => {
    // IAM Identity Center SSO portal region can differ from the region embedded
    // in the CodeWhisperer profile ARN. The endpoint host must follow the
    // profile ARN's region, not the SSO home region, or Kiro's backend rejects
    // the request (host/signing-region mismatch looks like a spurious 400).
    const a: KiroAuthDetails = {
      ...auth(),
      region: 'eu-west-1', // SSO/IDC home region
      profileArn: 'arn:aws:codewhisperer:eu-central-1:123456789012:profile/ABCDEF'
    }
    expect(resolveKiroEndpoint(a)).toBe(
      'https://runtime.eu-central-1.kiro.dev/generateAssistantResponse'
    )
  })

  test('Builder ID account (no profileArn): falls back to auth.region', () => {
    const a: KiroAuthDetails = { ...auth(), region: 'eu-central-1' }
    expect(resolveKiroEndpoint(a)).toBe(
      'https://q.eu-central-1.amazonaws.com/generateAssistantResponse'
    )
  })

  test('missing region and profileArn falls back to us-east-1', () => {
    const a: KiroAuthDetails = { ...auth(), region: undefined as any }
    expect(resolveKiroEndpoint(a)).toBe(
      'https://q.us-east-1.amazonaws.com/generateAssistantResponse'
    )
  })
})
