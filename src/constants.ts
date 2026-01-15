import type { KiroRegion } from './plugin/types';

export const KIRO_CONSTANTS = {
  REFRESH_URL: 'https://prod.{{region}}.auth.desktop.kiro.dev/refreshToken',
  REFRESH_IDC_URL: 'https://oidc.{{region}}.amazonaws.com/token',
  BASE_URL: 'https://q.{{region}}.amazonaws.com/generateAssistantResponse',
  USAGE_LIMITS_URL: 'https://q.{{region}}.amazonaws.com/getUsageLimits',
  DEFAULT_REGION: 'us-east-1' as KiroRegion,
  ACCESS_TOKEN_EXPIRY_BUFFER_MS: 60000,
  AXIOS_TIMEOUT: 120000,
  USER_AGENT: 'KiroIDE',
  KIRO_VERSION: '0.7.5',
  CHAT_TRIGGER_TYPE_MANUAL: 'MANUAL',
  ORIGIN_AI_EDITOR: 'AI_EDITOR',
};

export const MODEL_MAPPING: Record<string, string> = {
  'claude-opus-4-5': 'claude-opus-4.5',
  'claude-opus-4-5-20251101': 'claude-opus-4.5',
  'claude-haiku-4-5': 'claude-haiku-4.5',
  'claude-sonnet-4-5': 'CLAUDE_SONNET_4_5_20250929_V1_0',
  'claude-sonnet-4-5-20250929': 'CLAUDE_SONNET_4_5_20250929_V1_0',
  'claude-sonnet-4-20250514': 'CLAUDE_SONNET_4_20250514_V1_0',
  'claude-3-7-sonnet-20250219': 'CLAUDE_3_7_SONNET_20250219_V1_0',
};

export const SUPPORTED_MODELS = Object.keys(MODEL_MAPPING);

export const KIRO_AUTH_SERVICE = {
  ENDPOINT: 'https://prod.{{region}}.auth.desktop.kiro.dev',
  SSO_OIDC_ENDPOINT: 'https://oidc.{{region}}.amazonaws.com',
  BUILDER_ID_START_URL: 'https://view.awsapps.com/start',
  SCOPES: [
    'codewhisperer:completions',
    'codewhisperer:analysis',
    'codewhisperer:conversations',
    'codewhisperer:transformations',
    'codewhisperer:taskassist'
  ],
};
