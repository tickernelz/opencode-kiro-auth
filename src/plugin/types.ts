export type KiroAuthMethod = 'idc' | 'desktop'
export type KiroRegion = string

export interface KiroAuthDetails {
  refresh: string
  access: string
  expires: number
  authMethod: KiroAuthMethod
  region: KiroRegion
  clientId?: string
  clientSecret?: string
  email?: string
  profileArn?: string
}

export interface RefreshParts {
  refreshToken: string
  clientId?: string
  clientSecret?: string
  profileArn?: string
  authMethod?: KiroAuthMethod
}

export interface ManagedAccount {
  id: string
  email: string
  authMethod: KiroAuthMethod
  region: KiroRegion
  clientId?: string
  clientSecret?: string
  profileArn?: string
  refreshToken: string
  accessToken: string
  expiresAt: number
  rateLimitResetTime: number
  isHealthy: boolean
  unhealthyReason?: string
  recoveryTime?: number
  failCount: number
  usedCount?: number
  limitCount?: number
  lastSync?: number
  lastUsed?: number
}

export interface CodeWhispererMessage {
  userInputMessage?: {
    content: string
    modelId: string
    origin: string
    images?: Array<{ format: string; source: { bytes: string } }>
    userInputMessageContext?: {
      toolResults?: Array<{
        toolUseId: string
        content: Array<{ text?: string }>
        status?: string
      }>
      tools?: Array<{
        toolSpecification: {
          name: string
          description: string
          inputSchema: { json: Record<string, unknown> }
        }
      }>
    }
  }
  assistantResponseMessage?: {
    content: string
    toolUses?: Array<{
      input: any
      name: string
      toolUseId: string
    }>
  }
}

export interface CodeWhispererRequest {
  conversationState: {
    chatTriggerType: string
    conversationId: string
    history?: CodeWhispererMessage[]
    currentMessage: CodeWhispererMessage
  }
  profileArn?: string
}

export interface ToolCall {
  toolUseId: string
  name: string
  input: string | Record<string, unknown>
}

export interface ParsedResponse {
  content: string
  toolCalls: ToolCall[]
  stopReason?: string
  inputTokens?: number
  outputTokens?: number
}

export interface PreparedRequest {
  url: string
  init: RequestInit
  streaming: boolean
  effectiveModel: string
  conversationId: string
}

export type AccountSelectionStrategy = 'sticky' | 'round-robin' | 'lowest-usage'
