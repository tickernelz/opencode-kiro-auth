import { createHash } from 'node:crypto'
import { existsSync, promises as fs } from 'node:fs'
import lockfile from 'proper-lockfile'
import { isPermanentError } from '../health'
import type { ManagedAccount } from '../types'

const LOCK_OPTIONS = {
  stale: 10000,
  retries: {
    retries: 5,
    minTimeout: 100,
    maxTimeout: 1000,
    factor: 2
  },
  realpath: false
}

export async function withDatabaseLock<T>(dbPath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${dbPath}.lock`

  if (!existsSync(dbPath)) {
    const dir = dbPath.substring(0, dbPath.lastIndexOf('/'))
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(dbPath, '')
  }

  let release: (() => Promise<void>) | null = null
  try {
    release = await lockfile.lock(dbPath, LOCK_OPTIONS)
    return await fn()
  } finally {
    if (release) {
      try {
        await release()
      } catch (e) {
        console.warn('Failed to release lock:', e)
      }
    }
  }
}

export function createDeterministicId(
  email: string,
  authMethod: string,
  clientId?: string,
  profileArn?: string
): string {
  const parts = [email, authMethod, clientId || '', profileArn || ''].join(':')
  return createHash('sha256').update(parts).digest('hex')
}

export function mergeAccounts(
  existing: ManagedAccount[],
  incoming: ManagedAccount[]
): ManagedAccount[] {
  const accountMap = new Map<string, ManagedAccount>()

  for (const acc of existing) {
    accountMap.set(acc.id, acc)
  }

  for (const acc of incoming) {
    const existingAcc = accountMap.get(acc.id)

    if (existingAcc) {
      const hasPermanentError =
        isPermanentError(existingAcc.unhealthyReason) || isPermanentError(acc.unhealthyReason)

      accountMap.set(acc.id, {
        ...existingAcc,
        ...acc,
        lastUsed: Math.max(existingAcc.lastUsed || 0, acc.lastUsed || 0),
        usedCount: Math.max(existingAcc.usedCount || 0, acc.usedCount || 0),
        limitCount: Math.max(existingAcc.limitCount || 0, acc.limitCount || 0),
        rateLimitResetTime: Math.max(
          existingAcc.rateLimitResetTime || 0,
          acc.rateLimitResetTime || 0
        ),
        isHealthy: hasPermanentError ? false : existingAcc.isHealthy || acc.isHealthy,
        failCount: Math.max(existingAcc.failCount || 0, acc.failCount || 0),
        lastSync: Math.max(existingAcc.lastSync || 0, acc.lastSync || 0)
      })
    } else {
      accountMap.set(acc.id, acc)
    }
  }

  return Array.from(accountMap.values())
}

export function deduplicateAccounts(accounts: ManagedAccount[]): ManagedAccount[] {
  const accountMap = new Map<string, ManagedAccount>()

  for (const acc of accounts) {
    const existing = accountMap.get(acc.id)
    if (!existing) {
      accountMap.set(acc.id, acc)
      continue
    }

    const currLastUsed = acc.lastUsed || 0
    const existLastUsed = existing.lastUsed || 0

    if (currLastUsed > existLastUsed) {
      accountMap.set(acc.id, acc)
    } else if (currLastUsed === existLastUsed) {
      const currAddedAt = acc.expiresAt || 0
      const existAddedAt = existing.expiresAt || 0
      if (currAddedAt > existAddedAt) {
        accountMap.set(acc.id, acc)
      }
    }
  }

  return Array.from(accountMap.values())
}
