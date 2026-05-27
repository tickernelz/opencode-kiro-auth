import { describe, expect, test } from 'bun:test'
import pluginModule from '../index.js'

describe('package plugin module', () => {
  test('uses the kiro provider id in the default export', () => {
    expect(pluginModule.id).toBe('kiro')
  })
})
