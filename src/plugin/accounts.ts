import { randomBytes } from 'node:crypto';
import { loadAccounts, saveAccounts } from './storage';
import type { 
  ManagedAccount, 
  AccountMetadata, 
  AccountStorage, 
  AccountSelectionStrategy,
  KiroAuthDetails,
  RefreshParts,
} from './types';
import * as logger from './logger';

export function generateAccountId(): string {
  return randomBytes(16).toString('hex');
}

export function isAccountAvailable(account: ManagedAccount): boolean {
  const now = Date.now();
  
  if (!account.isHealthy) {
    if (account.recoveryTime && now < account.recoveryTime) {
      return false;
    }
    if (account.recoveryTime && now >= account.recoveryTime) {
      return true;
    }
    return false;
  }
  
  if (account.rateLimitResetTime && now < account.rateLimitResetTime) {
    return false;
  }
  
  return true;
}

export function encodeRefreshToken(parts: RefreshParts): string {
  const segments: string[] = [parts.refreshToken];
  
  if (parts.profileArn) {
    segments.push(`profileArn:${parts.profileArn}`);
  }
  if (parts.clientId) {
    segments.push(`clientId:${parts.clientId}`);
  }
  if (parts.clientSecret) {
    segments.push(`clientSecret:${parts.clientSecret}`);
  }
  if (parts.authMethod) {
    segments.push(`authMethod:${parts.authMethod}`);
  }
  
  return segments.join('|');
}

export function decodeRefreshToken(encoded: string): RefreshParts {
  const segments = encoded.split('|');
  const parts: RefreshParts = {
    refreshToken: segments[0] || '',
  };
  
  for (let i = 1; i < segments.length; i++) {
    const segment = segments[i];
    if (!segment) continue;
    
    const colonIndex = segment.indexOf(':');
    if (colonIndex === -1) continue;
    
    const key = segment.substring(0, colonIndex);
    const value = segment.substring(colonIndex + 1);
    
    if (key === 'profileArn') {
      parts.profileArn = value;
    } else if (key === 'clientId') {
      parts.clientId = value;
    } else if (key === 'clientSecret') {
      parts.clientSecret = value;
    } else if (key === 'authMethod') {
      parts.authMethod = value as 'social' | 'idc';
    }
  }
  
  return parts;
}

export class AccountManager {
  private accounts: ManagedAccount[];
  private cursor: number;
  private strategy: AccountSelectionStrategy;

  constructor(accounts: ManagedAccount[], strategy: AccountSelectionStrategy = 'sticky') {
    this.accounts = accounts;
    this.cursor = 0;
    this.strategy = strategy;
  }

  static async loadFromDisk(strategy?: AccountSelectionStrategy): Promise<AccountManager> {
    const storage = await loadAccounts();
    const accounts: ManagedAccount[] = storage.accounts.map((meta) => ({
      id: meta.id,
      email: meta.email,
      authMethod: meta.authMethod,
      region: meta.region,
      profileArn: meta.profileArn,
      clientId: meta.clientId,
      refreshToken: meta.refreshToken,
      accessToken: meta.accessToken,
      expiresAt: meta.expiresAt,
      rateLimitResetTime: meta.rateLimitResetTime,
      isHealthy: meta.isHealthy,
      unhealthyReason: meta.unhealthyReason,
      recoveryTime: meta.recoveryTime,
      usedCount: meta.usedCount,
      limitCount: meta.limitCount,
    }));
    
    return new AccountManager(accounts, strategy || 'sticky');
  }

  getCurrentOrNext(): ManagedAccount | null {
    const now = Date.now();
    
    const availableAccounts = this.accounts.filter((account) => {
      if (!account.isHealthy) {
        if (account.recoveryTime && now >= account.recoveryTime) {
          account.isHealthy = true;
          delete account.unhealthyReason;
          delete account.recoveryTime;
          return true;
        }
        return false;
      }
      
      if (account.rateLimitResetTime && now < account.rateLimitResetTime) {
        return false;
      }
      
      return true;
    });
    
    if (availableAccounts.length === 0) {
      return null;
    }
    
    if (this.strategy === 'sticky') {
      const currentAccount = this.accounts[this.cursor];
      if (currentAccount && isAccountAvailable(currentAccount)) {
        currentAccount.lastUsed = now;
        return currentAccount;
      }
      
      const nextAvailable = availableAccounts[0];
      if (nextAvailable) {
        this.cursor = this.accounts.indexOf(nextAvailable);
        nextAvailable.lastUsed = now;
        return nextAvailable;
      }
      
      return null;
    }
    
    if (this.strategy === 'round-robin') {
      const account = availableAccounts[this.cursor % availableAccounts.length];
      if (account) {
        this.cursor = (this.cursor + 1) % availableAccounts.length;
        account.lastUsed = now;
        return account;
      }
      return null;
    }
    
    return null;
  }

  markRateLimited(account: ManagedAccount, retryAfterMs: number): void {
    const accountIndex = this.accounts.findIndex((a) => a.id === account.id);
    if (accountIndex !== -1) {
      const acc = this.accounts[accountIndex];
      if (acc) {
        acc.rateLimitResetTime = Date.now() + retryAfterMs;
      }
    }
  }

  markUnhealthy(account: ManagedAccount, reason: string, recoveryTime?: number): void {
    const accountIndex = this.accounts.findIndex((a) => a.id === account.id);
    if (accountIndex !== -1) {
      const acc = this.accounts[accountIndex];
      if (acc) {
        acc.isHealthy = false;
        acc.unhealthyReason = reason;
        if (recoveryTime) {
          acc.recoveryTime = recoveryTime;
        }
      }
    }
  }

  markHealthy(account: ManagedAccount): void {
    const accountIndex = this.accounts.findIndex((a) => a.id === account.id);
    if (accountIndex !== -1) {
      const acc = this.accounts[accountIndex];
      if (acc) {
        acc.isHealthy = true;
        delete acc.unhealthyReason;
        delete acc.recoveryTime;
      }
    }
  }

  updateFromAuth(account: ManagedAccount, auth: KiroAuthDetails): void {
    const accountIndex = this.accounts.findIndex((a) => a.id === account.id);
    if (accountIndex !== -1) {
      const acc = this.accounts[accountIndex];
      if (acc) {
        acc.accessToken = auth.access;
        acc.expiresAt = auth.expires;
        acc.lastUsed = Date.now();
        
        const parts = decodeRefreshToken(auth.refresh);
        acc.refreshToken = parts.refreshToken;
        if (parts.profileArn) {
          acc.profileArn = parts.profileArn;
        }
        if (parts.clientId) {
          acc.clientId = parts.clientId;
        }
      }
    }
  }

  addAccount(account: ManagedAccount): void {
    if (!account.id) {
      account.id = generateAccountId();
    }
    this.accounts.push(account);
  }

  removeAccount(account: ManagedAccount): void {
    const accountIndex = this.accounts.findIndex((a) => a.id === account.id);
    if (accountIndex !== -1) {
      this.accounts.splice(accountIndex, 1);
      
      if (this.cursor >= this.accounts.length && this.accounts.length > 0) {
        this.cursor = this.accounts.length - 1;
      } else if (this.accounts.length === 0) {
        this.cursor = 0;
      }
    }
  }

  getAccounts(): ManagedAccount[] {
    return [...this.accounts];
  }

  async saveToDisk(): Promise<void> {
    const metadata: AccountMetadata[] = this.accounts.map((account) => ({
      id: account.id,
      email: account.email,
      authMethod: account.authMethod,
      region: account.region,
      profileArn: account.profileArn,
      clientId: account.clientId,
      refreshToken: account.refreshToken,
      accessToken: account.accessToken,
      expiresAt: account.expiresAt,
      rateLimitResetTime: account.rateLimitResetTime,
      isHealthy: account.isHealthy,
      unhealthyReason: account.unhealthyReason,
      recoveryTime: account.recoveryTime,
      usedCount: account.usedCount,
      limitCount: account.limitCount,
    }));
    
    const storage: AccountStorage = {
      version: 1,
      accounts: metadata,
      activeIndex: this.cursor,
    };
    
    await saveAccounts(storage);
  }

  toAuthDetails(account: ManagedAccount): KiroAuthDetails {
    const parts: RefreshParts = {
      refreshToken: account.refreshToken,
      profileArn: account.profileArn,
      clientId: account.clientId,
      authMethod: account.authMethod,
    };
    
    return {
      refresh: encodeRefreshToken(parts),
      access: account.accessToken,
      expires: account.expiresAt,
      authMethod: account.authMethod,
      region: account.region,
      profileArn: account.profileArn,
      clientId: account.clientId,
      email: account.email,
    };
  }
}
