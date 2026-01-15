export type KiroAuthMethod = 'social' | 'idc';

export type KiroRegion = 'us-east-1' | 'us-west-2';

export interface KiroAuthDetails {
  refresh: string;
  access: string;
  expires: number;
  authMethod: KiroAuthMethod;
  region: KiroRegion;
  profileArn?: string;
  clientId?: string;
  clientSecret?: string;
  email?: string;
}

export interface RefreshParts {
  refreshToken: string;
  profileArn?: string;
  clientId?: string;
  clientSecret?: string;
  authMethod?: KiroAuthMethod;
}

export interface ManagedAccount {
  id: string;
  email: string;
  authMethod: KiroAuthMethod;
  region: KiroRegion;
  profileArn?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  rateLimitResetTime: number;
  isHealthy: boolean;
  unhealthyReason?: string;
  recoveryTime?: number;
  usedCount?: number;
  limitCount?: number;
  lastUsed?: number;
}

export interface AccountMetadata {
  id: string;
  email: string;
  authMethod: KiroAuthMethod;
  region: KiroRegion;
  profileArn?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken: string;
  accessToken: string;
  expiresAt: number;
  rateLimitResetTime: number;
  isHealthy: boolean;
  unhealthyReason?: string;
  recoveryTime?: number;
  usedCount?: number;
  limitCount?: number;
}

export interface AccountStorage {
  version: 1;
  accounts: AccountMetadata[];
  activeIndex: number;
}

export interface CodeWhispererMessage {
  userInputMessage?: {
    content: string;
    modelId: string;
    origin: string;
    images?: Array<{ format: string; source: { bytes: string } }>;
    userInputMessageContext?: {
      toolResults?: Array<{
        toolUseId: string;
        content: Array<{ text?: string; image?: { format: string; source: { bytes: string } } }>;
        status?: string;
      }>;
      tools?: Array<{
        toolSpecification: {
          name: string;
          description: string;
          inputSchema: { json: Record<string, unknown> };
        };
      }>;
    };
  };
  assistantResponseMessage?: {
    content: string;
  };
}

export interface CodeWhispererRequest {
  conversationState: {
    chatTriggerType: string;
    conversationId: string;
    history: CodeWhispererMessage[];
    currentMessage: CodeWhispererMessage;
  };
  profileArn?: string;
}

export interface ToolCall {
  toolUseId: string;
  name: string;
  input: string | Record<string, unknown>;
}

export interface ParsedResponse {
  content: string;
  toolCalls: ToolCall[];
  stopReason?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface UsageLimits {
  usedCount: number;
  limitCount: number;
  contextUsagePercentage?: number;
}

export interface PreparedRequest {
  url: string;
  init: RequestInit;
  streaming: boolean;
  effectiveModel: string;
  conversationId: string;
}

export type AccountSelectionStrategy = 'sticky' | 'round-robin';

export interface StreamEvent {
  type: string;
  message?: any;
  content_block?: any;
  delta?: any;
  index?: number;
  usage?: any;
}
