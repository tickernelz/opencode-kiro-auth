import { describe, expect, test } from 'bun:test'
import pluginModule from '../index.js'

describe('package plugin module', () => {
  test('uses the kiro-auth provider id in the default export', () => {
    // kiro-auth is the primary id (avoids clashing with a future built-in `kiro`);
    // `kiro` remains registered as a back-compat alias by the config hook.
    expect(pluginModule.id).toBe('kiro-auth')
  })
})
