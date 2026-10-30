import { describe, expect, test } from 'bun:test'
import pluginModule from '../index.js'

describe('package plugin module', () => {
  test('uses the kiro provider id in the default export', () => {
    expect(pluginModule.id).toBe('kiro')
  })

  test('exposes both the V2 setup and the V1 server entrypoints', () => {
    expect(typeof pluginModule.setup).toBe('function')
    expect(typeof pluginModule.server).toBe('function')
  })
})
