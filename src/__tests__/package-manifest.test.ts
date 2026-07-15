import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf8'))

describe('package manifest', () => {
  test('exposes separate server and TUI plugin entrypoints', () => {
    expect(pkg.exports['.'].import).toBe('./dist/index.js')
    expect(pkg.exports['./tui'].import).toBe('./dist/tui.js')
    expect(pkg.exports['./tui'].types).toBe('./dist/tui.d.ts')
  })

  test('keeps Solid pinned to the @opentui/solid peer version', () => {
    expect(pkg.dependencies['@opentui/solid']).toBe('0.2.15')
    expect(pkg.dependencies['solid-js']).toBe('1.9.12')
  })
})
