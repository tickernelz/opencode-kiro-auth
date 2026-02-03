import { rmSync } from 'node:fs'

export function cleanupSqliteSidecars(dbPath: string): void {
  const candidates = [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}.lock`]
  for (const p of candidates) {
    try {
      rmSync(p, { force: true })
    } catch {
      // Best-effort cleanup.
    }
  }
}
