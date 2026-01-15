import type { KiroAuthDetails } from './types';
import type { AccountManager } from './accounts';
import { refreshAccessToken } from './token';
import * as logger from './logger';

export interface ProactiveRefreshQueue {
  start(): void;
  stop(): void;
  setAccountManager(manager: AccountManager): void;
}

export interface RefreshQueueConfig {
  enabled: boolean;
  checkIntervalSeconds: number;
  bufferSeconds: number;
}

export function isTokenExpiringSoon(auth: KiroAuthDetails, bufferMs: number): boolean {
  const now = Date.now();
  const expiresAt = auth.expires;
  const timeUntilExpiry = expiresAt - now;
  
  return timeUntilExpiry <= bufferMs && timeUntilExpiry > 0;
}

export function createProactiveRefreshQueue(
  config: RefreshQueueConfig
): ProactiveRefreshQueue {
  let intervalId: NodeJS.Timeout | null = null;
  let accountManager: AccountManager | null = null;
  let isRunning = false;
  
  async function checkAndRefresh(): Promise<void> {
    if (!accountManager) {
      return;
    }
    
    try {
      const accounts = accountManager.getAccounts();
      const bufferMs = config.bufferSeconds * 1000;
      
      for (const account of accounts) {
        try {
          const auth = accountManager.toAuthDetails(account);
          
          if (isTokenExpiringSoon(auth, bufferMs)) {
            logger.log(
              `[RefreshQueue] Token expiring soon for account ${account.email}, refreshing...`
            );
            
            const refreshedAuth = await refreshAccessToken(auth);
            
            accountManager.updateFromAuth(account, refreshedAuth);
            
            await accountManager.saveToDisk();
            
            logger.log(
              `[RefreshQueue] Successfully refreshed token for account ${account.email}`
            );
          }
        } catch (error) {
          logger.error(
            `[RefreshQueue] Failed to refresh token for account ${account.email}: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        }
      }
    } catch (error) {
      logger.error(
        `[RefreshQueue] Error during refresh check: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  
  function start(): void {
    if (!config.enabled || isRunning) {
      return;
    }
    
    const intervalMs = config.checkIntervalSeconds * 1000;
    
    intervalId = setInterval(() => {
      checkAndRefresh().catch((error) => {
        logger.error(
          `[RefreshQueue] Unhandled error in refresh check: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      });
    }, intervalMs);
    
    isRunning = true;
    
    logger.log(
      `[RefreshQueue] Started proactive refresh queue (interval: ${config.checkIntervalSeconds}s, buffer: ${config.bufferSeconds}s)`
    );
  }
  
  function stop(): void {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    
    isRunning = false;
    
    logger.log('[RefreshQueue] Stopped proactive refresh queue');
  }
  
  function setAccountManager(manager: AccountManager): void {
    accountManager = manager;
  }
  
  return {
    start,
    stop,
    setAccountManager,
  };
}
