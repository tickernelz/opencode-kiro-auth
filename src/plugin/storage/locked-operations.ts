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

const lockWaitBuffer = new Int32Array(new SharedArrayBuffer(4))

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

export function withDatabaseLockSync<T>(dbPath: string, fn: () => T): T {
  const deadline = Date.now() + 10000
  let release: (() => void) | undefined

  while (!release) {
    try {
      release = lockfile.lockSync(dbPath, { stale: LOCK_OPTIONS.stale, realpath: false })
    } catch (error) {
      if (
        !(error && typeof error === 'object' && 'code' in error && error.code === 'ELOCKED') ||
        Date.now() >= deadline
      ) {
        throw error
      }
      Atomics.wait(lockWaitBuffer, 0, 0, 25)
    }
  }

  try {
    return fn()
  } finally {
    release()
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
      const incomingHasPermanentError = isPermanentError(acc.unhealthyReason)
      const hasPermanentError =
        isPermanentError(existingAcc.unhealthyReason) || incomingHasPermanentError
      const incomingRecovered = acc.isHealthy && !incomingHasPermanentError
      const incomingSync = acc.lastSync || 0
      const existingSync = existingAcc.lastSync || 0
      const incomingHasQuota = (acc.limitCount || 0) > 0
      const existingHasQuota = (existingAcc.limitCount || 0) > 0
      // Only adopt the incoming quota snapshot when it is strictly newer AND it
      // is not an empty (0/0) snapshot replacing real existing quota. A failed
      // remote usage fetch produces a newer timestamp with zeroed counts, which
      // must never clobber good quota data.
      const useIncomingQuota =
        incomingSync > 0 && incomingSync > existingSync && (incomingHasQuota || !existingHasQuota)
      const incomingExpires = acc.expiresAt || 0
      const existingExpires = existingAcc.expiresAt || 0
      const preserveExistingAccess =
        existingAcc.isHealthy && existingExpires > Date.now() && existingExpires >= incomingExpires
      const incomingCredentialTime = acc.refreshTokenUpdatedAt || 0
      const existingCredentialTime = existingAcc.refreshTokenUpdatedAt || 0
      const useIncomingRefresh =
        !existingAcc.refreshToken ||
        (acc.refreshToken !== existingAcc.refreshToken &&
          incomingCredentialTime > existingCredentialTime)

      accountMap.set(acc.id, {
        ...existingAcc,
        ...acc,
        refreshToken: useIncomingRefresh ? acc.refreshToken : existingAcc.refreshToken,
        refreshTokenUpdatedAt: Math.max(existingCredentialTime, incomingCredentialTime),
        accessToken: preserveExistingAccess ? existingAcc.accessToken : acc.accessToken,
        expiresAt: preserveExistingAccess ? existingAcc.expiresAt : acc.expiresAt,
        lastUsed: Math.max(existingAcc.lastUsed || 0, acc.lastUsed || 0),
        usedCount: useIncomingQuota ? acc.usedCount : existingAcc.usedCount,
        limitCount: useIncomingQuota ? acc.limitCount : existingAcc.limitCount,
        subscriptionPlan: useIncomingQuota
          ? acc.subscriptionPlan || existingAcc.subscriptionPlan
          : existingAcc.subscriptionPlan || acc.subscriptionPlan,
        rateLimitResetTime: Math.max(
          existingAcc.rateLimitResetTime || 0,
          acc.rateLimitResetTime || 0
        ),
        isHealthy: incomingRecovered
          ? true
          : hasPermanentError
            ? false
            : existingAcc.isHealthy || acc.isHealthy,
        unhealthyReason: incomingRecovered
          ? undefined
          : acc.unhealthyReason || existingAcc.unhealthyReason,
        recoveryTime: incomingRecovered ? undefined : acc.recoveryTime || existingAcc.recoveryTime,
        failCount: incomingRecovered
          ? acc.failCount || 0
          : Math.max(existingAcc.failCount || 0, acc.failCount || 0),
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
