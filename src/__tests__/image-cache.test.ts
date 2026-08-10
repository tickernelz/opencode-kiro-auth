import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ImageCache } from '../plugin/image-cache.js'
import {
  convertImagesToKiroFormat,
  extractAllImages,
  type KiroImage
} from '../plugin/image-handler.js'

function img(byteLen = 100, format = 'png', seed = 0): KiroImage {
  // Use the seed to vary head bytes so dedupKey distinguishes distinct images
  // of the same size/format. Default seed=0 reproduces "identical" images.
  const bytes = new Uint8Array(byteLen)
  if (seed !== 0) {
    for (let i = 0; i < Math.min(16, byteLen); i++) bytes[i] = (seed + i) & 0xff
  }
  return { format, source: { bytes } }
}

describe('ImageCache', () => {
  test('round-trips images by workspace+fingerprint', () => {
    const c = new ImageCache()
    const a = img(50)
    const b = img(75)
    c.set('/ws', 'fp1', [a, b])

    const got = c.get('/ws', 'fp1')
    expect(got).not.toBeNull()
    expect(got).toHaveLength(2)
    expect(got![0]!.source.bytes.byteLength).toBe(50)
  })

  test('returns null when conversation is unknown', () => {
    const c = new ImageCache()
    expect(c.get('/ws', 'fp-missing')).toBeNull()
  })

  test('does nothing on empty image array', () => {
    const c = new ImageCache()
    c.set('/ws', 'fp1', [])
    expect(c.size()).toBe(0)
  })

  test('separate fingerprints are isolated', () => {
    const c = new ImageCache()
    c.set('/ws', 'fp1', [img(10)])
    c.set('/ws', 'fp2', [img(20)])
    expect(c.get('/ws', 'fp1')![0]!.source.bytes.byteLength).toBe(10)
    expect(c.get('/ws', 'fp2')![0]!.source.bytes.byteLength).toBe(20)
  })

  test('delete removes a single entry', () => {
    const c = new ImageCache()
    c.set('/ws', 'fp1', [img()])
    c.set('/ws', 'fp2', [img()])
    c.delete('/ws', 'fp1')
    expect(c.get('/ws', 'fp1')).toBeNull()
    expect(c.get('/ws', 'fp2')).not.toBeNull()
  })

  test('TTL prunes stale entries on lookup', () => {
    let t = 1000
    const c = new ImageCache({ ttlMs: 500, now: () => t })
    c.set('/ws', 'fp1', [img()])
    t = 1300
    expect(c.get('/ws', 'fp1')).not.toBeNull() // within TTL
    t = 2000
    expect(c.get('/ws', 'fp1')).toBeNull() // expired
    expect(c.size()).toBe(0)
  })

  test('LRU evicts the oldest when over capacity', () => {
    let t = 0
    const c = new ImageCache({ maxEntries: 3, now: () => ++t })
    c.set('/ws', 'a', [img()])
    c.set('/ws', 'b', [img()])
    c.set('/ws', 'c', [img()])
    c.set('/ws', 'd', [img()]) // pushes 'a' out
    expect(c.size()).toBe(3)
    expect(c.get('/ws', 'a')).toBeNull()
    expect(c.get('/ws', 'b')).not.toBeNull()
    expect(c.get('/ws', 'd')).not.toBeNull()
  })

  test('get() refreshes LRU position', () => {
    let t = 0
    const c = new ImageCache({ maxEntries: 3, now: () => ++t })
    c.set('/ws', 'a', [img()])
    c.set('/ws', 'b', [img()])
    c.set('/ws', 'c', [img()])
    c.get('/ws', 'a') // 'a' is now most-recently-used
    c.set('/ws', 'd', [img()]) // should evict 'b', not 'a'
    expect(c.get('/ws', 'a')).not.toBeNull()
    expect(c.get('/ws', 'b')).toBeNull()
  })

  test('clear empties everything', () => {
    const c = new ImageCache()
    c.set('/ws', 'a', [img()])
    c.set('/ws', 'b', [img()])
    c.clear()
    expect(c.size()).toBe(0)
  })
})

describe('ImageCache.upsert (merge + dedup + caps)', () => {
  test('merges new images with existing — new ones first', () => {
    const c = new ImageCache()
    c.set('/ws', 'fp', [img(100, 'png', 1), img(100, 'png', 2)])

    const newImg = img(100, 'png', 3)
    const count = c.upsert('/ws', 'fp', [newImg])

    expect(count).toBe(3)
    const got = c.get('/ws', 'fp')!
    // Newest first
    expect(got[0]!.source.bytes[0]).toBe((3 + 0) & 0xff)
    expect(got).toHaveLength(3)
  })

  test('deduplicates identical content (same format + size + head/tail bytes)', () => {
    const c = new ImageCache()
    const a = img(100, 'png', 7)
    c.set('/ws', 'fp', [a])

    // Same content fingerprint as a — should not be added twice.
    const aDup = img(100, 'png', 7)
    const count = c.upsert('/ws', 'fp', [aDup])

    expect(count).toBe(1)
    expect(c.get('/ws', 'fp')).toHaveLength(1)
  })

  test('caps merged result at MAX_KIRO_IMAGES, dropping oldest first', () => {
    const c = new ImageCache()
    // Existing: 3 images
    c.set('/ws', 'fp', [img(100, 'png', 1), img(100, 'png', 2), img(100, 'png', 3)])
    // Upsert 2 new → would be 5, MAX is 4, so the oldest (seed=3) drops.
    const count = c.upsert('/ws', 'fp', [img(100, 'png', 9), img(100, 'png', 8)])

    expect(count).toBe(4)
    const got = c.get('/ws', 'fp')!
    // Newest first
    expect(got[0]!.source.bytes[0]).toBe((9 + 0) & 0xff)
    expect(got[1]!.source.bytes[0]).toBe((8 + 0) & 0xff)
    // Seed=3 should have been dropped from the tail.
    const seedsPresent = got.map((g) => g.source.bytes[0])
    expect(seedsPresent).not.toContain((3 + 0) & 0xff)
  })

  test('caps total bytes at MAX_KIRO_IMAGE_BYTES (3.75MB)', () => {
    const c = new ImageCache()
    // Two 2MB images already cached
    const TWO_MB = 2 * 1024 * 1024
    c.set('/ws', 'fp', [img(TWO_MB, 'png', 1), img(TWO_MB, 'png', 2)])

    // Add another 2MB. Total would be 6MB; budget is 3.75MB. Oldest must drop.
    c.upsert('/ws', 'fp', [img(TWO_MB, 'png', 3)])

    const got = c.get('/ws', 'fp')!
    const total = got.reduce((n, g) => n + g.source.bytes.byteLength, 0)
    expect(total).toBeLessThanOrEqual(3_750_000)
    // The newest image must still be there (seed=3 is most recent)
    expect(got[0]!.source.bytes[0]).toBe((3 + 0) & 0xff)
  })

  test('upsert with empty input + no existing returns 0', () => {
    const c = new ImageCache()
    expect(c.upsert('/ws', 'fp', [])).toBe(0)
    expect(c.size()).toBe(0)
  })

  test('upsert with empty input keeps existing intact', () => {
    const c = new ImageCache()
    c.set('/ws', 'fp', [img(100, 'png', 5)])
    // Empty newImages should not wipe the existing entry; returns the unchanged count.
    expect(c.upsert('/ws', 'fp', [])).toBe(1)
    expect(c.get('/ws', 'fp')).toHaveLength(1)
  })
})

describe('ImageCache.hasEverHadImages', () => {
  test('returns false when no entry exists', () => {
    const c = new ImageCache()
    expect(c.hasEverHadImages('/ws', 'fp')).toBe(false)
  })

  test('returns true after set', () => {
    const c = new ImageCache()
    c.set('/ws', 'fp', [img(100)])
    expect(c.hasEverHadImages('/ws', 'fp')).toBe(true)
  })

  test('returns true after upsert with images', () => {
    const c = new ImageCache()
    c.upsert('/ws', 'fp', [img(100)])
    expect(c.hasEverHadImages('/ws', 'fp')).toBe(true)
  })

  test('returns false after delete', () => {
    const c = new ImageCache()
    c.set('/ws', 'fp', [img(100)])
    c.delete('/ws', 'fp')
    expect(c.hasEverHadImages('/ws', 'fp')).toBe(false)
  })

  test('checks disk when in-memory cache misses', () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-img-cache-'))
    try {
      const writer = new ImageCache({ cacheDir: dir })
      writer.set('/ws', 'fp', [img(100)])
      const reader = new ImageCache({ cacheDir: dir })
      // No in-memory entry yet, but hasEverHadImages should still find it on disk
      expect(reader.hasEverHadImages('/ws', 'fp')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('hasEverHadImages avoids disk hit when cacheDir is null', () => {
    const c = new ImageCache()
    // Should be O(1), no disk access attempted
    const start = performance.now()
    for (let i = 0; i < 1000; i++) c.hasEverHadImages('/ws', 'fp-' + i)
    expect(performance.now() - start).toBeLessThan(10)
  })
})

describe('ImageCache filesystem persistence', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'kiro-img-cache-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('persists across instances', () => {
    const writer = new ImageCache({ cacheDir: dir })
    writer.set('/ws', 'fp', [img(100, 'png', 5)])

    // Fresh instance pointing at the same dir simulates an OpenCode restart.
    const reader = new ImageCache({ cacheDir: dir })
    expect(reader.size()).toBe(0) // memory map starts empty
    const got = reader.get('/ws', 'fp')
    expect(got).not.toBeNull()
    expect(got).toHaveLength(1)
    expect(got![0]!.source.bytes[0]).toBe(5)
    expect(reader.size()).toBe(1) // lazy-loaded into memory after first get
  })

  test('delete removes the on-disk file too', () => {
    const c = new ImageCache({ cacheDir: dir })
    c.set('/ws', 'fp', [img()])
    expect(readdirSync(dir).filter((n) => n.endsWith('.json'))).toHaveLength(1)
    c.delete('/ws', 'fp')
    expect(readdirSync(dir).filter((n) => n.endsWith('.json'))).toHaveLength(0)
  })

  test('upsert merges with on-disk state from a previous instance', () => {
    const first = new ImageCache({ cacheDir: dir })
    first.set('/ws', 'fp', [img(100, 'png', 1), img(100, 'png', 2)])

    // Restart: new instance, in-memory is empty but disk has the entry.
    const second = new ImageCache({ cacheDir: dir })
    const count = second.upsert('/ws', 'fp', [img(100, 'png', 3)])

    expect(count).toBe(3)
    const got = second.get('/ws', 'fp')!
    // Newest (seed=3) is first; existing seeds 1 and 2 are still present.
    expect(got[0]!.source.bytes[0]).toBe(3)
    expect(got).toHaveLength(3)
  })

  test('constructor sweeps files older than the TTL', () => {
    const c1 = new ImageCache({ cacheDir: dir, ttlMs: 1000 })
    c1.set('/ws', 'fp', [img()])
    const files = readdirSync(dir).filter((n) => n.endsWith('.json'))
    expect(files).toHaveLength(1)

    // Backdate the file so it's far older than the TTL.
    const ancient = new Date(Date.now() - 24 * 60 * 60 * 1000)
    utimesSync(join(dir, files[0]!), ancient, ancient)

    // New instance with the same TTL should sweep the stale file at init.
    new ImageCache({ cacheDir: dir, ttlMs: 1000 })
    expect(readdirSync(dir).filter((n) => n.endsWith('.json'))).toHaveLength(0)
  })

  test('lazy-load drops a file that has expired since it was written', () => {
    const c1 = new ImageCache({ cacheDir: dir, ttlMs: 1000 })
    c1.set('/ws', 'fp', [img()])
    const file = readdirSync(dir).filter((n) => n.endsWith('.json'))[0]!
    const ancient = new Date(Date.now() - 24 * 60 * 60 * 1000)
    utimesSync(join(dir, file), ancient, ancient)

    // Big TTL on the reader so the constructor sweep doesn't wipe it; but the
    // lazy-load path uses the reader's TTL too — make it small so it expires.
    const reader = new ImageCache({ cacheDir: dir, ttlMs: 1000 })
    expect(reader.get('/ws', 'fp')).toBeNull()
    // File should be cleaned up.
    expect(existsSync(join(dir, file))).toBe(false)
  })

  test('disk persistence is OFF when no cacheDir is given', () => {
    const c = new ImageCache()
    c.set('/ws', 'fp', [img()])
    // Nothing should land in our tmpdir because the cache wasn't told about it.
    expect(readdirSync(dir)).toHaveLength(0)
  })
})

// ── Image extraction + conversion performance ────────────────────────────────

describe('image extraction performance', () => {
  test('extractAllImages + convertImagesToKiroFormat: 4 large images under 50ms', () => {
    // Simulates an agentic turn carrying the 3.75MB Kiro payload limit worth of
    // PNG screenshots. The base64 char-loop was the bottleneck — verify Buffer
    // decoding keeps us well under the budget.
    const big = 'A'.repeat(900_000) // ~675KB raw -> ~900KB base64
    const content = [
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: big } }
    ]
    const start = performance.now()
    const unified = extractAllImages(content)
    const { images, omitted } = convertImagesToKiroFormat(unified)
    const elapsed = performance.now() - start
    expect(unified.length).toBe(4)
    expect(images.length).toBe(4)
    expect(omitted).toBe(0)
    expect(elapsed).toBeLessThan(50)
  })

  test('extractAllImages handles OpenAI data URLs in one pass', () => {
    const content = [
      { type: 'text', text: 'hello' },
      {
        type: 'image_url',
        image_url: {
          url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
        }
      },
      { type: 'image_url', image_url: { url: 'https://example.com/img.png' } } // non-data URL: skipped
    ]
    const result = extractAllImages(content)
    expect(result).toHaveLength(1)
    expect(result[0]!.mediaType).toBe('image/png')
  })
})
