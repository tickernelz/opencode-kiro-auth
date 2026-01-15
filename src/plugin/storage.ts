import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import lockfile from 'proper-lockfile';
import { xdgConfig } from 'xdg-basedir';
import type { AccountStorage } from './types';
import * as logger from './logger';

export function getStoragePath(): string {
  const configDir = xdgConfig || `${process.env.HOME}/.config`;
  return `${configDir}/opencode/kiro-accounts.json`;
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

async function ensureFileExists(path: string): Promise<void> {
  try {
    await fs.access(path);
  } catch {
    await fs.mkdir(dirname(path), { recursive: true });
    const defaultStorage: AccountStorage = {
      version: 1,
      accounts: [],
      activeIndex: -1,
    };
    await fs.writeFile(path, JSON.stringify(defaultStorage, null, 2), 'utf-8');
  }
}

export async function withFileLock<T>(path: string, fn: () => Promise<T>): Promise<T> {
  await ensureFileExists(path);
  let release: (() => Promise<void>) | null = null;
  try {
    release = await lockfile.lock(path, LOCK_OPTIONS);
    return await fn();
  } catch (error) {
    logger.error('File lock operation failed', error);
    throw error;
  } finally {
    if (release) {
      try {
        await release();
      } catch (unlockError) {
        logger.warn('Failed to release lock', unlockError);
      }
    }
  }
}

export async function loadAccounts(): Promise<AccountStorage> {
  const path = getStoragePath();
  
  try {
    await ensureFileExists(path);
    const content = await fs.readFile(path, 'utf-8');
    const data = JSON.parse(content) as AccountStorage;
    
    if (data.version !== 1) {
      logger.warn('Unknown storage version, returning default');
      return {
        version: 1,
        accounts: [],
        activeIndex: -1,
      };
    }
    
    if (!Array.isArray(data.accounts)) {
      logger.warn('Invalid accounts array, returning default');
      return {
        version: 1,
        accounts: [],
        activeIndex: -1,
      };
    }
    
    return data;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return {
        version: 1,
        accounts: [],
        activeIndex: -1,
      };
    }
    logger.error('Failed to load accounts', error);
    return {
      version: 1,
      accounts: [],
      activeIndex: -1,
    };
  }
}

export async function saveAccounts(storage: AccountStorage): Promise<void> {
  const path = getStoragePath();
  
  await withFileLock(path, async () => {
    const tempPath = `${path}.${randomBytes(6).toString('hex')}.tmp`;
    const content = JSON.stringify(storage, null, 2);
    
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(tempPath, content, 'utf-8');
    await fs.rename(tempPath, path);
  });
}
