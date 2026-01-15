import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { xdgConfig } from 'xdg-basedir';
import * as logger from './logger';
import { 
  KiroTokenRefreshError, 
  KiroQuotaExhaustedError, 
  KiroRateLimitError, 
  KiroAuthError 
} from './errors';

export interface RecoveryState {
  sessionId: string;
  conversationId: string;
  model: string;
  lastMessageIndex: number;
  errorCount: number;
  lastError?: string;
  timestamp: number;
}

export interface RecoveryStorage {
  version: 1;
  sessions: Record<string, RecoveryState>;
}

export interface SessionRecoveryHook {
  handleSessionError(error: any, sessionId: string): Promise<boolean>;
  isRecoverableError(error: any): boolean;
  clearSession(sessionId: string): Promise<void>;
}

const LOCK_OPTIONS = {
  stale: 10000,
  retries: {
    retries: 5,
    minTimeout: 100,
    maxTimeout: 1000,
    factor: 2,
  },
};

const MAX_ERROR_COUNT = 3;

function getRecoveryPath(): string {
  const configDir = xdgConfig || `${process.env.HOME}/.config`;
  return `${configDir}/opencode/kiro-recovery.json`;
}

async function ensureFileExists(path: string): Promise<void> {
  try {
    await fs.access(path);
  } catch {
    await fs.mkdir(dirname(path), { recursive: true });
    const defaultStorage: RecoveryStorage = {
      version: 1,
      sessions: {},
    };
    await fs.writeFile(path, JSON.stringify(defaultStorage, null, 2), 'utf-8');
  }
}

async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await ensureFileExists(path);
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(path, LOCK_OPTIONS);
    return await fn();
  } catch (error) {
    logger.error('Recovery file lock operation failed', error);
    throw error;
  } finally {
    if (release) {
      try {
        await release();
      } catch (unlockError) {
        logger.warn('Failed to release recovery lock', unlockError);
      }
    }
  }
}

async function loadRecoveryState(): Promise<RecoveryStorage> {
  const path = getRecoveryPath();
  
  try {
    await ensureFileExists(path);
    const content = await fs.readFile(path, 'utf-8');
    const data = JSON.parse(content) as RecoveryStorage;
    
    if (data.version !== 1) {
      logger.warn('Unknown recovery storage version, returning default');
      return {
        version: 1,
        sessions: {},
      };
    }
    
    if (typeof data.sessions !== 'object' || data.sessions === null) {
      logger.warn('Invalid sessions object, returning default');
      return {
        version: 1,
        sessions: {},
      };
    }
    
    return data;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        version: 1,
        sessions: {},
      };
    }
    logger.error('Failed to load recovery state', error);
    return {
      version: 1,
      sessions: {},
    };
  }
}

async function saveRecoveryState(state: RecoveryStorage): Promise<void> {
  const path = getRecoveryPath();
  
  await withFileLock(path, async () => {
    const tempPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    const content = JSON.stringify(state, null, 2);
    
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, path);
  });
}

function isNetworkError(error: any): boolean {
  if (!error) return false;
  
  const errorCode = error.code || error.errno;
  if (typeof errorCode === 'string') {
    const networkCodes = [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'ENOTFOUND',
      'ENETUNREACH',
      'EHOSTUNREACH',
      'EPIPE',
      'EAI_AGAIN',
    ];
    
    if (networkCodes.includes(errorCode)) {
      return true;
    }
  }
  
  const message = error.message || error.toString?.() || '';
  const lowerMessage = message.toLowerCase();
  
  const networkPatterns = [
    'network',
    'connection',
    'timeout',
    'econnreset',
    'econnrefused',
    'socket hang up',
    'fetch failed',
  ];
  
  return networkPatterns.some(pattern => lowerMessage.includes(pattern));
}

function getStatusCode(error: any): number | null {
  if (!error) return null;
  
  if (typeof error.statusCode === 'number') {
    return error.statusCode;
  }
  
  if (typeof error.status === 'number') {
    return error.status;
  }
  
  if (error.response && typeof error.response.status === 'number') {
    return error.response.status;
  }
  
  return null;
}

function isRecoverableStatusCode(statusCode: number): boolean {
  const recoverableCodes = [
    429,
    502,
    503,
    504,
  ];
  
  return recoverableCodes.includes(statusCode);
}

function isUnrecoverableStatusCode(statusCode: number): boolean {
  const unrecoverableCodes = [
    400,
    402,
    403,
    404,
  ];
  
  return unrecoverableCodes.includes(statusCode);
}

function isRecoverableErrorImpl(error: any): boolean {
  if (!error) return false;
  
  if (error instanceof KiroTokenRefreshError) {
    return false;
  }
  
  if (error instanceof KiroQuotaExhaustedError) {
    return false;
  }
  
  if (error instanceof KiroRateLimitError) {
    return true;
  }
  
  if (error instanceof KiroAuthError) {
    const statusCode = error.statusCode;
    if (statusCode === 401) {
      return true;
    }
    if (statusCode && isUnrecoverableStatusCode(statusCode)) {
      return false;
    }
    return true;
  }
  
  if (isNetworkError(error)) {
    return true;
  }
  
  const statusCode = getStatusCode(error);
  if (statusCode !== null) {
    if (isUnrecoverableStatusCode(statusCode)) {
      return false;
    }
    if (isRecoverableStatusCode(statusCode)) {
      return true;
    }
  }
  
  return false;
}

function getErrorMessage(error: any): string {
  if (!error) return 'Unknown error';
  
  if (typeof error === 'string') {
    return error;
  }
  
  if (error.message && typeof error.message === 'string') {
    return error.message;
  }
  
  if (error.toString && typeof error.toString === 'function') {
    return error.toString();
  }
  
  try {
    return JSON.stringify(error);
  } catch {
    return 'Unknown error';
  }
}

export function createSessionRecoveryHook(
  enabled: boolean,
  autoResume: boolean
): SessionRecoveryHook {
  const handleSessionError = async (error: any, sessionId: string): Promise<boolean> => {
    if (!enabled) {
      return false;
    }
    
    if (!sessionId) {
      logger.warn('No session ID provided for recovery');
      return false;
    }
    
    if (!isRecoverableErrorImpl(error)) {
      logger.debug('Error is not recoverable', { sessionId, error: getErrorMessage(error) });
      return false;
    }
    
    try {
      const storage = await loadRecoveryState();
      
      let sessionState = storage.sessions[sessionId];
      
      if (!sessionState) {
        sessionState = {
          sessionId,
          conversationId: '',
          model: '',
          lastMessageIndex: 0,
          errorCount: 1,
          lastError: getErrorMessage(error),
          timestamp: Date.now(),
        };
      } else {
        sessionState.errorCount += 1;
        sessionState.lastError = getErrorMessage(error);
        sessionState.timestamp = Date.now();
      }
      
      if (sessionState.errorCount > MAX_ERROR_COUNT) {
        logger.warn('Session error count exceeded maximum', { 
          sessionId, 
          errorCount: sessionState.errorCount 
        });
        
        delete storage.sessions[sessionId];
        await saveRecoveryState(storage);
        
        return false;
      }
      
      storage.sessions[sessionId] = sessionState;
      await saveRecoveryState(storage);
      
      logger.log('Session error recorded for recovery', { 
        sessionId, 
        errorCount: sessionState.errorCount,
        shouldRetry: true 
      });
      
      return true;
    } catch (storageError) {
      logger.error('Failed to handle session error', storageError);
      return false;
    }
  };
  
  const isRecoverableError = (error: any): boolean => {
    return isRecoverableErrorImpl(error);
  };
  
  const clearSession = async (sessionId: string): Promise<void> => {
    if (!sessionId) {
      return;
    }
    
    try {
      const storage = await loadRecoveryState();
      
      if (storage.sessions[sessionId]) {
        delete storage.sessions[sessionId];
        await saveRecoveryState(storage);
        logger.debug('Session cleared from recovery state', { sessionId });
      }
    } catch (error) {
      logger.error('Failed to clear session', error);
    }
  };
  
  return {
    handleSessionError,
    isRecoverableError,
    clearSession,
  };
}
