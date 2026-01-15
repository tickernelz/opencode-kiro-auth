import { KiroAuthDetails, UsageLimits, ParsedResponse } from './types';

const USAGE_LIMITS_ENDPOINT = 'https://q.{{region}}.amazonaws.com/getUsageLimits';
const RESOURCE_TYPE = 'AGENTIC_REQUEST';
const ORIGIN = 'AI_EDITOR';

interface UsageLimitsResponse {
  usedCount?: number;
  limitCount?: number;
  contextUsagePercentage?: number;
  email?: string;
}

export async function fetchUsageLimits(auth: KiroAuthDetails): Promise<UsageLimits> {
  const url = buildUsageLimitsUrl(auth);
  const headers = buildRequestHeaders(auth);

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
    });

    if (!response.ok) {
      throw new Error(`Usage limits request failed: ${response.status} ${response.statusText}`);
    }

    const data: UsageLimitsResponse = await response.json();
    return parseUsageLimitsResponse(data);
  } catch (error) {
    if (error instanceof Error) {
      throw new Error(`Failed to fetch usage limits: ${error.message}`);
    }
    throw new Error('Failed to fetch usage limits: Unknown error');
  }
}

function buildUsageLimitsUrl(auth: KiroAuthDetails): string {
  const baseUrl = USAGE_LIMITS_ENDPOINT.replace('{{region}}', auth.region);
  const params = new URLSearchParams({
    isEmailRequired: 'true',
    origin: ORIGIN,
    resourceType: RESOURCE_TYPE,
  });

  if (auth.authMethod === 'social' && auth.profileArn) {
    params.append('profileArn', auth.profileArn);
  }

  return `${baseUrl}?${params.toString()}`;
}

function buildRequestHeaders(auth: KiroAuthDetails): Record<string, string> {
  return {
    'Authorization': `Bearer ${auth.access}`,
    'Content-Type': 'application/json',
    'x-amzn-kiro-agent-mode': 'vibe',
    'amz-sdk-request': 'attempt=1; max=1',
  };
}

function parseUsageLimitsResponse(data: UsageLimitsResponse): UsageLimits {
  const usedCount = typeof data.usedCount === 'number' ? data.usedCount : 0;
  const limitCount = typeof data.limitCount === 'number' ? data.limitCount : 0;
  const contextUsagePercentage = typeof data.contextUsagePercentage === 'number' 
    ? data.contextUsagePercentage 
    : undefined;

  return {
    usedCount,
    limitCount,
    contextUsagePercentage,
  };
}

export function calculateRecoveryTime(): number {
  const now = new Date();
  const nextMonth = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth() + 1,
    1,
    0,
    0,
    0,
    0
  ));
  return nextMonth.getTime();
}

export function isQuotaExhausted(usage: UsageLimits): boolean {
  return usage.usedCount >= usage.limitCount;
}

export function formatUsageDisplay(usage: UsageLimits): string {
  const percentage = usage.limitCount > 0
    ? Math.round((usage.usedCount / usage.limitCount) * 100)
    : 0;
  return `${usage.usedCount}/${usage.limitCount} (${percentage}%)`;
}

export function calculateUsagePercentage(usage: UsageLimits): number {
  if (usage.limitCount <= 0) {
    return 0;
  }
  return Math.round((usage.usedCount / usage.limitCount) * 100);
}

export function getRemainingCount(usage: UsageLimits): number {
  const remaining = usage.limitCount - usage.usedCount;
  return Math.max(0, remaining);
}

export function extractUsageFromResponse(response: ParsedResponse): { inputTokens: number; outputTokens: number } | null {
  const inputTokens = response.inputTokens;
  const outputTokens = response.outputTokens;

  if (typeof inputTokens === 'number' && typeof outputTokens === 'number') {
    return {
      inputTokens,
      outputTokens,
    };
  }

  return null;
}

export function shouldRefreshUsage(lastFetchTime: number | undefined, intervalMs: number = 300000): boolean {
  if (!lastFetchTime) {
    return true;
  }
  return Date.now() - lastFetchTime >= intervalMs;
}

export function isUsageWarningThreshold(usage: UsageLimits, thresholdPercent: number = 80): boolean {
  const percentage = calculateUsagePercentage(usage);
  return percentage >= thresholdPercent && percentage < 100;
}

export function getUsageStatus(usage: UsageLimits): 'healthy' | 'warning' | 'exhausted' {
  if (isQuotaExhausted(usage)) {
    return 'exhausted';
  }
  if (isUsageWarningThreshold(usage)) {
    return 'warning';
  }
  return 'healthy';
}

export function formatRecoveryTime(recoveryTimeMs: number): string {
  const date = new Date(recoveryTimeMs);
  return date.toISOString();
}

export function getTimeUntilRecovery(recoveryTimeMs: number): number {
  const now = Date.now();
  const timeUntil = recoveryTimeMs - now;
  return Math.max(0, timeUntil);
}

export function formatTimeUntilRecovery(recoveryTimeMs: number): string {
  const ms = getTimeUntilRecovery(recoveryTimeMs);
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) {
    return `${days}d ${hours % 24}h`;
  }
  if (hours > 0) {
    return `${hours}h ${minutes % 60}m`;
  }
  if (minutes > 0) {
    return `${minutes}m`;
  }
  return `${seconds}s`;
}

export interface UsageMetrics {
  usage: UsageLimits;
  status: 'healthy' | 'warning' | 'exhausted';
  percentage: number;
  remaining: number;
  recoveryTime?: number;
  timeUntilRecovery?: number;
  formattedDisplay: string;
}

export function buildUsageMetrics(usage: UsageLimits, recoveryTime?: number): UsageMetrics {
  const status = getUsageStatus(usage);
  const percentage = calculateUsagePercentage(usage);
  const remaining = getRemainingCount(usage);
  const formattedDisplay = formatUsageDisplay(usage);

  const metrics: UsageMetrics = {
    usage,
    status,
    percentage,
    remaining,
    formattedDisplay,
  };

  if (recoveryTime) {
    metrics.recoveryTime = recoveryTime;
    metrics.timeUntilRecovery = getTimeUntilRecovery(recoveryTime);
  }

  return metrics;
}

export async function fetchAndBuildUsageMetrics(auth: KiroAuthDetails): Promise<UsageMetrics> {
  const usage = await fetchUsageLimits(auth);
  const recoveryTime = isQuotaExhausted(usage) ? calculateRecoveryTime() : undefined;
  return buildUsageMetrics(usage, recoveryTime);
}
