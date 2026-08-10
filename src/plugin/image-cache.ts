/**
 * In-memory + on-disk cache of converted Kiro images, keyed per conversation
 * (workspace + fingerprint). See AGENTS.md §3 "Image carry-forward" for the
 * design rationale and the OpenCode-strip behaviour this works around.
 *
 * Bounded by 24h TTL, 20-conversation memory LRU, and the per-entry
 * MAX_KIRO_IMAGES / MAX_KIRO_IMAGE_BYTES caps. Disk persistence uses
 * write-temp-rename so a partial write can't corrupt the cache file.
 */
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'

import { getConfigDir } from './config/loader.js'
import { MAX_KIRO_IMAGES, MAX_KIRO_IMAGE_BYTES, type KiroImage } from './image-handler.js'

// Content fingerprint for dedup — format + byte length + first/last 16 bytes
// is unique enough in practice; matching head AND tail for two distinct
// screenshots of identical size is vanishingly rare. No crypto needed.
function dedupKey(img: KiroImage): string {
  const b = img.source.bytes
  const n = b.byteLength
  if (n === 0) return `${img.format}:empty`
  const hex = (start: number, end: number): string =>
    Array.from(b.subarray(start, end), (v) => v.toString(16).padStart(2, '0')).join('')
  return `${img.format}:${n}:${hex(0, Math.min(16, n))}:${hex(Math.max(0, n - 16), n)}`
}

// Mirrors the layout of logger.ts and kiro.json so everything sits under one
// base folder. Internal — only the module-level singleton uses this.
function defaultCacheDir(): string {
  return join(getConfigDir(), 'kiro-images')
}

function diskFileFor(cacheDir: string, workspace: string, fingerprint: string): string {
  // Hash the composite key so the filename has no path separators or other
  // shell-unsafe characters from the workspace path.
  const id = createHash('sha256')
    .update(workspace + '\0' + fingerprint)
    .digest('hex')
    .slice(0, 32)
  return join(cacheDir, `${id}.json`)
}

interface CacheEntry {
  images: KiroImage[]
  totalBytes: number
  lastAccess: number
  // True once this conversation has ever contained an image-bearing turn.
  // Lets callers skip the history scan entirely on long sessions where no
  // images were ever attached.
  everHadImages: boolean
}

export interface ImageCacheOptions {
  ttlMs?: number
  maxEntries?: number
  // Injectable clock for deterministic tests.
  now?: () => number
  // Filesystem persistence directory. Omit (or pass null) to keep the cache
  // memory-only — tests rely on this default.
  cacheDir?: string | null
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_MAX_ENTRIES = 20

export class ImageCache {
  private cache = new Map<string, CacheEntry>()
  private ttlMs: number
  private maxEntries: number
  private now: () => number
  private cacheDir: string | null

  constructor(opts: ImageCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS
    this.maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.now = opts.now ?? (() => Date.now())
    this.cacheDir = opts.cacheDir ?? null
    if (this.cacheDir) this.sweepDiskExpired()
  }

  private k(workspace: string, fingerprint: string): string {
    return `${workspace}\0${fingerprint}`
  }

  set(workspace: string, fingerprint: string, images: KiroImage[]): void {
    if (images.length === 0) return
    const totalBytes = images.reduce((n, im) => n + im.source.bytes.byteLength, 0)
    const key = this.k(workspace, fingerprint)
    const entry: CacheEntry = {
      images,
      totalBytes,
      lastAccess: this.now(),
      everHadImages: true
    }
    // delete-then-set so the entry moves to the tail of the Map's insertion
    // order — that's what makes the eviction sweep pick the truly oldest.
    this.cache.delete(key)
    this.cache.set(key, entry)
    this.writeEntryToDisk(workspace, fingerprint, entry)
    this.evict()
  }

  /**
   * Merge new images with the existing cache for this conversation.
   * New images go to the front (most recent), then existing fills in.
   * Duplicates (same content fingerprint) collapse.
   * Result is capped at MAX_KIRO_IMAGES and MAX_KIRO_IMAGE_BYTES;
   * when over budget, the OLDEST entries drop first (FIFO).
   *
   * Returns the final image count for diagnostics.
   */
  upsert(workspace: string, fingerprint: string, newImages: KiroImage[]): number {
    const key = this.k(workspace, fingerprint)
    // Try in-memory first; fall back to disk so cross-restart upserts merge
    // with what we already persisted instead of overwriting it.
    let existing = this.cache.get(key)?.images
    if (!existing && this.cacheDir) {
      existing = this.loadEntryFromDisk(workspace, fingerprint)?.images
    }
    existing ??= []

    if (newImages.length === 0 && existing.length === 0) return 0

    const seen = new Set<string>()
    const merged: KiroImage[] = []
    const add = (img: KiroImage): void => {
      if (merged.length >= MAX_KIRO_IMAGES) return
      const k = dedupKey(img)
      if (seen.has(k)) return
      seen.add(k)
      merged.push(img)
    }
    for (const img of newImages) add(img)
    for (const img of existing) add(img)

    // Enforce byte budget by dropping the oldest entries (tail) until in cap.
    let total = merged.reduce((n, im) => n + im.source.bytes.byteLength, 0)
    while (total > MAX_KIRO_IMAGE_BYTES && merged.length > 0) {
      total -= merged.pop()!.source.bytes.byteLength
    }

    if (merged.length === 0) {
      this.cache.delete(key)
      this.deleteFromDisk(workspace, fingerprint)
      return 0
    }

    const entry: CacheEntry = {
      images: merged,
      totalBytes: total,
      lastAccess: this.now(),
      everHadImages: true
    }
    this.cache.delete(key)
    this.cache.set(key, entry)
    this.writeEntryToDisk(workspace, fingerprint, entry)
    this.evict()
    return merged.length
  }

  get(workspace: string, fingerprint: string): KiroImage[] | null {
    const key = this.k(workspace, fingerprint)
    let entry = this.cache.get(key)

    // Lazy-load from disk if we don't have it in memory (e.g. fresh plugin
    // process resuming a prior conversation).
    if (!entry && this.cacheDir) {
      const loaded = this.loadEntryFromDisk(workspace, fingerprint)
      if (loaded) {
        entry = loaded
        this.cache.set(key, entry)
        this.evict()
      }
    }

    if (!entry) return null

    if (this.now() - entry.lastAccess > this.ttlMs) {
      this.cache.delete(key)
      this.deleteFromDisk(workspace, fingerprint)
      return null
    }
    // Refresh LRU position.
    entry.lastAccess = this.now()
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.images
  }

  delete(workspace: string, fingerprint: string): void {
    this.cache.delete(this.k(workspace, fingerprint))
    this.deleteFromDisk(workspace, fingerprint)
  }

  // True if this conversation has ever carried images. Lets callers skip
  // the history scan entirely on long text-only sessions.
  hasEverHadImages(workspace: string, fingerprint: string): boolean {
    const entry = this.cache.get(this.k(workspace, fingerprint))
    if (entry) return entry.everHadImages
    if (this.cacheDir) {
      try {
        return existsSync(diskFileFor(this.cacheDir, workspace, fingerprint))
      } catch {
        return false
      }
    }
    return false
  }

  // Memory-only clear; disk files survive and may be re-loaded by later get().
  clear(): void {
    this.cache.clear()
  }

  size(): number {
    return this.cache.size
  }

  private evict(): void {
    const t = this.now()
    for (const [key, e] of this.cache) {
      if (t - e.lastAccess > this.ttlMs) this.cache.delete(key)
    }
    while (this.cache.size > this.maxEntries) {
      const first = this.cache.keys().next().value
      if (first === undefined) break
      this.cache.delete(first)
    }
  }

  // ── Disk persistence (no-ops when cacheDir is null) ────────────────────────

  private writeEntryToDisk(workspace: string, fingerprint: string, entry: CacheEntry): void {
    if (!this.cacheDir) return
    try {
      mkdirSync(this.cacheDir, { recursive: true })
      const file = diskFileFor(this.cacheDir, workspace, fingerprint)
      const tmp = `${file}.tmp`
      const payload = {
        workspace,
        fingerprint,
        updatedAt: entry.lastAccess,
        images: entry.images.map((im) => ({
          format: im.format,
          b64: Buffer.from(im.source.bytes).toString('base64')
        }))
      }
      writeFileSync(tmp, JSON.stringify(payload))
      renameSync(tmp, file)
    } catch {
      // Disk failures must never break the request — in-memory cache still works.
    }
  }

  private loadEntryFromDisk(workspace: string, fingerprint: string): CacheEntry | null {
    if (!this.cacheDir) return null
    try {
      const file = diskFileFor(this.cacheDir, workspace, fingerprint)
      if (!existsSync(file)) return null
      const stat = statSync(file)
      // mtime acts as "last access" — if older than TTL, treat as expired
      // and clean up.
      if (this.now() - stat.mtimeMs > this.ttlMs) {
        try {
          unlinkSync(file)
        } catch {}
        return null
      }
      const raw = readFileSync(file, 'utf-8')
      const data = JSON.parse(raw)
      if (!data || !Array.isArray(data.images)) return null
      const images: KiroImage[] = []
      for (const im of data.images) {
        if (!im || typeof im.format !== 'string' || typeof im.b64 !== 'string') continue
        const bytes = new Uint8Array(Buffer.from(im.b64, 'base64'))
        images.push({ format: im.format, source: { bytes } })
      }
      if (images.length === 0) return null
      const totalBytes = images.reduce((n, im) => n + im.source.bytes.byteLength, 0)
      return { images, totalBytes, lastAccess: stat.mtimeMs, everHadImages: true }
    } catch {
      return null
    }
  }

  private deleteFromDisk(workspace: string, fingerprint: string): void {
    if (!this.cacheDir) return
    try {
      const file = diskFileFor(this.cacheDir, workspace, fingerprint)
      if (existsSync(file)) unlinkSync(file)
    } catch {}
  }

  /**
   * Remove expired files from the cache dir. Runs once at construction so
   * a long-lived dir doesn't grow unbounded with stale conversations.
   */
  private sweepDiskExpired(): void {
    if (!this.cacheDir) return
    try {
      if (!existsSync(this.cacheDir)) return
      const cutoff = this.now() - this.ttlMs
      for (const name of readdirSync(this.cacheDir)) {
        if (!name.endsWith('.json') && !name.endsWith('.tmp')) continue
        const file = join(this.cacheDir, name)
        try {
          const stat = statSync(file)
          if (stat.mtimeMs < cutoff) unlinkSync(file)
        } catch {}
      }
    } catch {}
  }
}

// Shared instance for the plugin runtime — persisted to ~/.config/opencode/kiro-images/
// (or %APPDATA%/opencode/kiro-images/ on Windows). Tests construct their own
// ImageCache with a tmpdir or no cacheDir at all.
export const imageCache = new ImageCache({ cacheDir: defaultCacheDir() })
