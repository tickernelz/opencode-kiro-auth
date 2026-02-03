import { z } from 'zod'

export const AccountSelectionStrategySchema = z.enum(['sticky', 'round-robin', 'lowest-usage'])
export type AccountSelectionStrategy = z.infer<typeof AccountSelectionStrategySchema>

const REGION_REGEX = /^[a-z]{2}-[a-z-]+-\d+$/
export const RegionSchema = z.string().regex(REGION_REGEX)
export type Region = z.infer<typeof RegionSchema>

export const KiroConfigSchema = z.object({
  $schema: z.string().optional(),

  account_selection_strategy: AccountSelectionStrategySchema.default('lowest-usage'),

  default_region: RegionSchema.default('us-east-1'),

  rate_limit_retry_delay_ms: z.number().min(1000).max(60000).default(5000),

  rate_limit_max_retries: z.number().min(0).max(10).default(3),

  max_request_iterations: z.number().min(5).max(1000).default(20),

  request_timeout_ms: z.number().min(30000).max(600000).default(120000),

  token_expiry_buffer_ms: z.number().min(30000).max(300000).default(120000),

  usage_sync_max_retries: z.number().min(0).max(5).default(3),

  auth_server_port_start: z.number().min(1024).max(65535).default(19847),

  auth_server_port_range: z.number().min(1).max(100).default(10),

  builder_id_start_url: z.string().url().default('https://view.awsapps.com/start'),

  usage_tracking_enabled: z.boolean().default(true),
  usage_toast_enabled: z.boolean().default(false),
  auto_sync_kiro_cli: z.boolean().default(true),
  enable_log_api_request: z.boolean().default(false)
})

export type KiroConfig = z.infer<typeof KiroConfigSchema>

export const DEFAULT_CONFIG: KiroConfig = {
  account_selection_strategy: 'lowest-usage',
  default_region: 'us-east-1',
  rate_limit_retry_delay_ms: 5000,
  rate_limit_max_retries: 3,
  max_request_iterations: 20,
  request_timeout_ms: 120000,
  token_expiry_buffer_ms: 120000,
  usage_sync_max_retries: 3,
  auth_server_port_start: 19847,
  auth_server_port_range: 10,
  builder_id_start_url: 'https://view.awsapps.com/start',
  usage_tracking_enabled: true,
  usage_toast_enabled: false,
  auto_sync_kiro_cli: true,
  enable_log_api_request: false
}
