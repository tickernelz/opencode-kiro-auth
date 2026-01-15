import { ManagedAccount, UsageLimits } from './types';
import { calculateUsagePercentage, isQuotaExhausted, getRemainingCount } from './usage';

export type QuotaStatus = 'healthy' | 'warning' | 'exhausted';

export interface QuotaInfo {
  status: QuotaStatus;
  used: number;
  limit: number;
  remaining: number;
  percentage: number;
  recoveryTime?: number;
}

const WARNING_THRESHOLD_PERCENT = 80;

export function checkQuotaStatus(account: ManagedAccount): QuotaStatus {
  if (!account.usedCount || !account.limitCount) {
    return 'healthy';
  }

  const usage: UsageLimits = {
    usedCount: account.usedCount,
    limitCount: account.limitCount,
  };

  if (isQuotaExhausted(usage)) {
    return 'exhausted';
  }

  const percentage = calculateUsagePercentage(usage);
  if (percentage >= WARNING_THRESHOLD_PERCENT) {
    return 'warning';
  }

  return 'healthy';
}

export function updateAccountQuota(account: ManagedAccount, usage: UsageLimits): void {
  account.usedCount = usage.usedCount;
  account.limitCount = usage.limitCount;
}

export function getNextAvailableAccount(accounts: ManagedAccount[]): ManagedAccount | null {
  const availableAccounts = accounts.filter(account => {
    if (!account.isHealthy) {
      return false;
    }

    const status = checkQuotaStatus(account);
    return status !== 'exhausted';
  });

  if (availableAccounts.length === 0) {
    return null;
  }

  return availableAccounts[0] || null;
}

export function sortAccountsByQuota(accounts: ManagedAccount[]): ManagedAccount[] {
  return [...accounts].sort((a, b) => {
    const aRemaining = getRemainingQuota(a);
    const bRemaining = getRemainingQuota(b);
    return bRemaining - aRemaining;
  });
}

function getRemainingQuota(account: ManagedAccount): number {
  if (!account.usedCount || !account.limitCount) {
    return Infinity;
  }

  const usage: UsageLimits = {
    usedCount: account.usedCount,
    limitCount: account.limitCount,
  };

  return getRemainingCount(usage);
}

export function buildQuotaInfo(account: ManagedAccount): QuotaInfo {
  const used = account.usedCount || 0;
  const limit = account.limitCount || 0;
  const remaining = Math.max(0, limit - used);
  const percentage = limit > 0 ? Math.round((used / limit) * 100) : 0;
  const status = checkQuotaStatus(account);

  const info: QuotaInfo = {
    status,
    used,
    limit,
    remaining,
    percentage,
  };

  if (account.recoveryTime) {
    info.recoveryTime = account.recoveryTime;
  }

  return info;
}

export function filterHealthyAccounts(accounts: ManagedAccount[]): ManagedAccount[] {
  return accounts.filter(account => {
    if (!account.isHealthy) {
      return false;
    }

    const status = checkQuotaStatus(account);
    return status !== 'exhausted';
  });
}

export function filterExhaustedAccounts(accounts: ManagedAccount[]): ManagedAccount[] {
  return accounts.filter(account => {
    const status = checkQuotaStatus(account);
    return status === 'exhausted';
  });
}

export function filterWarningAccounts(accounts: ManagedAccount[]): ManagedAccount[] {
  return accounts.filter(account => {
    const status = checkQuotaStatus(account);
    return status === 'warning';
  });
}

export function hasAvailableQuota(account: ManagedAccount): boolean {
  const status = checkQuotaStatus(account);
  return status !== 'exhausted';
}

export function isQuotaNearLimit(account: ManagedAccount, thresholdPercent: number = WARNING_THRESHOLD_PERCENT): boolean {
  if (!account.usedCount || !account.limitCount) {
    return false;
  }

  const usage: UsageLimits = {
    usedCount: account.usedCount,
    limitCount: account.limitCount,
  };

  const percentage = calculateUsagePercentage(usage);
  return percentage >= thresholdPercent;
}

export function getAccountWithMostQuota(accounts: ManagedAccount[]): ManagedAccount | null {
  const healthyAccounts = filterHealthyAccounts(accounts);
  if (healthyAccounts.length === 0) {
    return null;
  }

  const sorted = sortAccountsByQuota(healthyAccounts);
  return sorted[0] || null;
}

export function getAccountWithLeastQuota(accounts: ManagedAccount[]): ManagedAccount | null {
  const healthyAccounts = filterHealthyAccounts(accounts);
  if (healthyAccounts.length === 0) {
    return null;
  }

  const sorted = sortAccountsByQuota(healthyAccounts);
  return sorted[sorted.length - 1] || null;
}

export function getTotalQuotaInfo(accounts: ManagedAccount[]): QuotaInfo {
  let totalUsed = 0;
  let totalLimit = 0;

  for (const account of accounts) {
    if (account.usedCount && account.limitCount) {
      totalUsed += account.usedCount;
      totalLimit += account.limitCount;
    }
  }

  const remaining = Math.max(0, totalLimit - totalUsed);
  const percentage = totalLimit > 0 ? Math.round((totalUsed / totalLimit) * 100) : 0;

  let status: QuotaStatus = 'healthy';
  if (totalUsed >= totalLimit) {
    status = 'exhausted';
  } else if (percentage >= WARNING_THRESHOLD_PERCENT) {
    status = 'warning';
  }

  return {
    status,
    used: totalUsed,
    limit: totalLimit,
    remaining,
    percentage,
  };
}

export function shouldRotateAccount(account: ManagedAccount, rotationThreshold: number = 90): boolean {
  if (!account.usedCount || !account.limitCount) {
    return false;
  }

  const usage: UsageLimits = {
    usedCount: account.usedCount,
    limitCount: account.limitCount,
  };

  const percentage = calculateUsagePercentage(usage);
  return percentage >= rotationThreshold;
}

export function selectAccountForRequest(accounts: ManagedAccount[], strategy: 'least-used' | 'most-quota' = 'most-quota'): ManagedAccount | null {
  const healthyAccounts = filterHealthyAccounts(accounts);
  if (healthyAccounts.length === 0) {
    return null;
  }

  if (strategy === 'most-quota') {
    return getAccountWithMostQuota(healthyAccounts);
  }

  const sorted = healthyAccounts.sort((a, b) => {
    const aLastUsed = a.lastUsed || 0;
    const bLastUsed = b.lastUsed || 0;
    return aLastUsed - bLastUsed;
  });

  return sorted[0] || null;
}
