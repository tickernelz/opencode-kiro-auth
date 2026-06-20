import { z } from 'zod'

export const AccountSelectionStrategySchema = z.enum(['sticky', 'round-robin', 'lowest-usage'])
export type AccountSelectionStrategy = z.infer<typeof AccountSelectionStrategySchema>

export const RegionSchema = z.enum([
  'us-east-1',
  'us-east-2',
  'us-west-1',
  'us-west-2',
  'af-south-1',
  'ap-east-1',
  'ap-south-2',
  'ap-southeast-3',
  'ap-southeast-5',
  'ap-southeast-4',
  'ap-south-1',
  'ap-southeast-6',
  'ap-northeast-3',
  'ap-northeast-2',
  'ap-southeast-1',
  'ap-southeast-2',
  'ap-east-2',
  'ap-southeast-7',
  'ap-northeast-1',
  'ca-central-1',
  'ca-west-1',
  'eu-central-1',
  'eu-west-1',
  'eu-west-2',
  'eu-south-1',
  'eu-west-3',
  'eu-south-2',
  'eu-north-1',
  'eu-central-2',
  'il-central-1',
  'mx-central-1',
  'me-south-1',
  'me-central-1',
  'sa-east-1'
])
export type Region = z.infer<typeof RegionSchema>

// Thinking budget configuration schema for named variants
export const ThinkingBudgetConfigSchema = z.object({
  low: z.number().min(1024).max(128000).default(8192),
  medium: z.number().min(1024).max(128000).default(16384),
  high: z.number().min(1024).max(128000).default(24576),
  max: z.number().min(1024).max(128000).default(32768)
})
export type ThinkingBudgetConfig = z.infer<typeof ThinkingBudgetConfigSchema>

export const KiroConfigSchema = z.object({
  $schema: z.string().optional(),

  idc_start_url: z.string().url().optional(),
  idc_region: RegionSchema.optional(),
  idc_profile_arn: z.string().optional(),

  account_selection_strategy: AccountSelectionStrategySchema.default('lowest-usage'),

  default_region: RegionSchema.default('us-east-1'),

  rate_limit_retry_delay_ms: z.number().min(1000).max(60000).default(5000),

  rate_limit_max_retries: z.number().min(0).max(10).default(3),

  max_request_iterations: z.number().min(5).max(1000).default(20),

  request_timeout_ms: z.number().min(30000).max(600000).default(120000),

  token_expiry_buffer_ms: z.number().min(30000).max(300000).default(300000),

  usage_sync_max_retries: z.number().min(0).max(5).default(3),

  auth_server_port_start: z.number().min(1024).max(65535).default(19847),

  auth_server_port_range: z.number().min(1).max(100).default(10),

  usage_tracking_enabled: z.boolean().default(true),
  auto_sync_kiro_cli: z.boolean().default(true),
  enable_log_api_request: z.boolean().default(false),

  // Thinking budget configuration
  // Default budget used when no variant is specified or detected from providerOptions
  default_thinking_budget: z.number().min(1024).max(128000).default(20000),

  // Per-variant thinking budgets, mapped from providerOptions.reasoningEffort
  // These match OpenCode's variant names (low, medium, high, max)
  thinking_budgets: ThinkingBudgetConfigSchema.default({
    low: 8192,
    medium: 16384,
    high: 24576,
    max: 32768
  })
})

export type KiroConfig = z.infer<typeof KiroConfigSchema>

export const DEFAULT_CONFIG: KiroConfig = {
  account_selection_strategy: 'lowest-usage',
  default_region: 'us-east-1',
  rate_limit_retry_delay_ms: 5000,
  rate_limit_max_retries: 3,
  max_request_iterations: 20,
  request_timeout_ms: 120000,
  token_expiry_buffer_ms: 300000,
  usage_sync_max_retries: 3,
  auth_server_port_start: 19847,
  auth_server_port_range: 10,
  usage_tracking_enabled: true,
  auto_sync_kiro_cli: true,
  enable_log_api_request: false,
  default_thinking_budget: 20000,
  thinking_budgets: {
    low: 8192,
    medium: 16384,
    high: 24576,
    max: 32768
  }
}
