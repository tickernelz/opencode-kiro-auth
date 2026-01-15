import { z } from "zod";

export const AccountSelectionStrategySchema = z.enum(['sticky', 'round-robin']);
export type AccountSelectionStrategy = z.infer<typeof AccountSelectionStrategySchema>;

export const RegionSchema = z.enum(['us-east-1', 'us-west-2']);
export type Region = z.infer<typeof RegionSchema>;

export const KiroConfigSchema = z.object({
  $schema: z.string().optional(),
  
  quiet_mode: z.boolean().default(false),
  
  debug: z.boolean().default(false),
  
  session_recovery: z.boolean().default(true),
  
  auto_resume: z.boolean().default(true),
  
  max_recovery_attempts: z.number().min(1).max(10).default(3),
  
  proactive_token_refresh: z.boolean().default(true),
  
  token_refresh_interval_seconds: z.number().min(60).max(3600).default(300),
  
  token_refresh_buffer_seconds: z.number().min(60).max(1800).default(600),
  
  account_selection_strategy: AccountSelectionStrategySchema.default('sticky'),
  
  thinking_enabled: z.boolean().default(false),
  
  thinking_budget_tokens: z.number().min(1000).max(24576).default(20000),
  
  default_region: RegionSchema.default('us-east-1'),
  
  request_timeout_ms: z.number().min(10000).max(300000).default(120000),
  
  rate_limit_retry_delay_ms: z.number().min(1000).max(60000).default(5000),
  
  rate_limit_max_retries: z.number().min(0).max(10).default(3),
  
  quota_warning_threshold: z.number().min(0).max(1).default(0.8),
  
  usage_tracking_enabled: z.boolean().default(true),
  
  usage_fetch_interval_seconds: z.number().min(60).max(3600).default(300),
});

export type KiroConfig = z.infer<typeof KiroConfigSchema>;

export const DEFAULT_CONFIG: KiroConfig = {
  quiet_mode: false,
  debug: false,
  session_recovery: true,
  auto_resume: true,
  max_recovery_attempts: 3,
  proactive_token_refresh: true,
  token_refresh_interval_seconds: 300,
  token_refresh_buffer_seconds: 600,
  account_selection_strategy: 'sticky',
  thinking_enabled: false,
  thinking_budget_tokens: 20000,
  default_region: 'us-east-1',
  request_timeout_ms: 120000,
  rate_limit_retry_delay_ms: 5000,
  rate_limit_max_retries: 3,
  quota_warning_threshold: 0.8,
  usage_tracking_enabled: true,
  usage_fetch_interval_seconds: 300,
};
