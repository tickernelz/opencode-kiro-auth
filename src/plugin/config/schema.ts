import { z } from 'zod'

export const AccountSelectionStrategySchema = z.enum(['sticky', 'round-robin', 'lowest-usage'])
export type AccountSelectionStrategy = z.infer<typeof AccountSelectionStrategySchema>

export const SdkEndpointModeSchema = z.enum(['auto', 'kiro-runtime', 'legacy-q'])
export type SdkEndpointMode = z.infer<typeof SdkEndpointModeSchema>

const RegionStringSchema = z
  .string()
  .trim()
  .regex(
    /^(us|us-gov|af|ap|ca|cn|eu|il|me|mx|sa)-[a-z0-9-]+-\d+$/,
    'Please enter a valid AWS region'
  )

export const RegionSchema = RegionStringSchema
export type Region = z.infer<typeof RegionSchema>

const OptionalTrimmedUrlSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
  z.string().url().optional()
)

const OptionalTrimmedStringSchema = z.preprocess(
  (value) => (typeof value === 'string' && value.trim() ? value.trim() : undefined),
  z.string().optional()
)

export const KiroConfigSchema = z.object({
  $schema: z.string().optional(),

  idc_start_url: OptionalTrimmedUrlSchema,
  idc_region: RegionSchema.optional(),
  idc_profile_arn: OptionalTrimmedStringSchema,

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
  sdk_endpoint_mode: SdkEndpointModeSchema.default('auto'),
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
  token_expiry_buffer_ms: 300000,
  usage_sync_max_retries: 3,
  auth_server_port_start: 19847,
  auth_server_port_range: 10,
  usage_tracking_enabled: true,
  auto_sync_kiro_cli: true,
  sdk_endpoint_mode: 'auto',
  enable_log_api_request: false
}
