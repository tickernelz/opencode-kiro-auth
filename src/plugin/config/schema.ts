import { z } from 'zod'

export const AccountSelectionStrategySchema = z.enum(['sticky', 'round-robin', 'lowest-usage'])
export type AccountSelectionStrategy = z.infer<typeof AccountSelectionStrategySchema>

export const RegionSchema = z.enum(['us-east-1', 'us-west-2'])
export type Region = z.infer<typeof RegionSchema>

export const KiroConfigSchema = z.object({
  $schema: z.string().optional(),

  session_recovery: z.boolean().default(true),

  auto_resume: z.boolean().default(true),

  proactive_token_refresh: z.boolean().default(true),

  token_refresh_interval_seconds: z.number().min(60).max(3600).default(300),

  token_refresh_buffer_seconds: z.number().min(60).max(1800).default(600),

  account_selection_strategy: AccountSelectionStrategySchema.default('lowest-usage'),

  default_region: RegionSchema.default('us-east-1'),

  rate_limit_retry_delay_ms: z.number().min(1000).max(60000).default(5000),

  rate_limit_max_retries: z.number().min(0).max(10).default(3),

  usage_tracking_enabled: z.boolean().default(true),

  enable_log_api_request: z.boolean().default(false)
})

export type KiroConfig = z.infer<typeof KiroConfigSchema>

export const DEFAULT_CONFIG: KiroConfig = {
  session_recovery: true,
  auto_resume: true,
  proactive_token_refresh: true,
  token_refresh_interval_seconds: 300,
  token_refresh_buffer_seconds: 600,
  account_selection_strategy: 'lowest-usage',
  default_region: 'us-east-1',
  rate_limit_retry_delay_ms: 5000,
  rate_limit_max_retries: 3,
  usage_tracking_enabled: true,
  enable_log_api_request: false
}
