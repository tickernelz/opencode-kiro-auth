import { z } from 'zod'

export const AccountSelectionStrategySchema = z.enum(['sticky', 'round-robin', 'lowest-usage'])
export type AccountSelectionStrategy = z.infer<typeof AccountSelectionStrategySchema>

/**
 * Kiro effort levels control thinking/reasoning depth.
 * - low: minimal reasoning
 * - medium: balanced (default when thinking enabled)
 * - high: deeper reasoning
 * - xhigh: extended reasoning (xhigh-capable models only, see effort.ts)
 * - max: maximum reasoning depth (up to 128k thinking tokens on opus-4.8/opus-5)
 */
export const EffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type Effort = z.infer<typeof EffortSchema>

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

  /**
   * Default effort level for thinking models. Controls reasoning depth.
   * When set, this overrides the automatic budget-based mapping.
   * Values: 'low', 'medium', 'high', 'xhigh' (see XHIGH_CAPABLE_MODELS), 'max'
   */
  effort: EffortSchema.optional(),

  /**
   * Enable automatic effort mapping from OpenCode's thinking budget.
   * When true (default), maps budget ranges to effort levels.
   * When false, only uses explicit effort config or falls back to 'medium'.
   */
  auto_effort_mapping: z.boolean().default(true),

  // Expose Kiro's server-side web search as a `kiro_web_search` tool. Kiro runs
  // the search on its own infrastructure (billed as Kiro credits) and returns
  // structured results. Requires a Pro account (profileArn); on free Builder ID
  // accounts the tool is not registered. Disable to avoid overlap with other
  // search tools/MCP servers.
  web_search_enabled: z.boolean().default(true),

  // OpenCode strips image parts from conversation state across agentic turns.
  // When true, the plugin caches converted images per conversation and re-attaches
  // them to currentMessage on later turns so the model keeps "seeing" them.
  // Kiro bills per session (request), not per token, so re-sending the same
  // images each turn has no billing impact. Only disable if you hit the
  // per-request 3.75MB image-payload cap on conversations with many heavy images.
  image_carry_forward: z.boolean().default(true),

  // Maximum conversation-state payload size (bytes) before the plugin trims the
  // oldest history entries. Kiro's runtime endpoint rejects oversized payloads
  // with CONTENT_LENGTH_EXCEEDS_THRESHOLD. The hard limit is structure-dependent
  // (verified against the live API): a single message is accepted up to ~7.6MB,
  // but conversations with many history entries are rejected as low as ~5.9MB.
  // The 4MB default stays safely below the lowest observed failure regardless of
  // structure, while allowing far more context than a conservative cap. Raising
  // it risks 400s on long many-turn sessions; lowering it trims context sooner.
  max_payload_bytes: z.number().min(100_000).max(5_500_000).default(4_000_000)
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
  auto_effort_mapping: true,
  web_search_enabled: true,
  image_carry_forward: true,
  max_payload_bytes: 4_000_000
}
