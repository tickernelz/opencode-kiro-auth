#!/usr/bin/env bun

import { createSolidTransformPlugin } from '@opentui/solid/bun-plugin'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const result = await Bun.build({
  entrypoints: ['src/tui.tsx'],
  target: 'bun',
  format: 'esm',
  outdir: 'dist',
  plugins: [createSolidTransformPlugin()],
  external: ['@opentui/solid', 'solid-js'],
  sourcemap: 'none'
})

for (const log of result.logs) {
  console.error(log)
}

if (!result.success) {
  process.exit(1)
}

const output = await readFile(resolve('dist/tui.js'), 'utf8')

if (output.includes('@opentui/solid/jsx-runtime')) {
  throw new Error(
    'TUI build still imports @opentui/solid/jsx-runtime, which is types-only at runtime.'
  )
}

console.log('build-tui: wrote dist/tui.js with OpenTUI Solid transform')
