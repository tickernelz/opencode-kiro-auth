export type KiroAuthMethod = 'idc' | 'sso'
export type KiroRegion = 'us-east-1' | 'us-west-2'

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
  ssoStartUrl?: string
}

export interface RefreshParts {
  refreshToken: string
  clientId?: string
  clientSecret?: string
  profileArn?: string
  authMethod?: KiroAuthMethod
  ssoStartUrl?: string
}

export interface ManagedAccount {
  id: string
  email: string
  realEmail?: string
  authMethod: KiroAuthMethod
  region: KiroRegion
  clientId?: string
  clientSecret?: string
  profileArn?: string
  ssoStartUrl?: string
  refreshToken: string
  accessToken: string
  expiresAt: number
  rateLimitResetTime: number
  isHealthy: boolean
  unhealthyReason?: string
  recoveryTime?: number
  usedCount?: number
  limitCount?: number
  lastUsed?: number
}

export interface AccountMetadata {
  id: string
  email: string
  realEmail?: string
  authMethod: KiroAuthMethod
  region: KiroRegion
  clientId?: string
  clientSecret?: string
  profileArn?: string
  ssoStartUrl?: string
  refreshToken: string
  accessToken: string
  expiresAt: number
  rateLimitResetTime: number
  isHealthy: boolean
  unhealthyReason?: string
  recoveryTime?: number
}

export interface AccountStorage {
  version: 1
  accounts: AccountMetadata[]
  activeIndex: number
}

export interface UsageMetadata {
  usedCount: number
  limitCount: number
  realEmail?: string
  lastSync: number
}

export interface UsageStorage {
  version: 1
  usage: Record<string, UsageMetadata>
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

export interface StreamEvent {
  type: string
  message?: any
  content_block?: any
  delta?: any
  index?: number
  usage?: any
}
