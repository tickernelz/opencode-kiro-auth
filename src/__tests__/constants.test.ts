import { describe, expect, test } from 'bun:test'
import {
  getKiroClientId,
  isLongContextModel,
  KIRO_CONSTANTS,
  KIRO_IDE_VERSION,
  normalizeRegion,
  SUPPORTED_MODELS
} from '../constants.js'

describe('isLongContextModel', () => {
  test('returns true for all 1m model variants', () => {
    const expected1m = SUPPORTED_MODELS.filter((k) => k.includes('-1m'))
    expect(expected1m.length).toBeGreaterThan(0)
    for (const model of expected1m) {
      expect(isLongContextModel(model)).toBe(true)
    }
  })

  test('returns false for standard context models', () => {
    const standard = SUPPORTED_MODELS.filter((k) => !k.includes('-1m'))
    expect(standard.length).toBeGreaterThan(0)
    for (const model of standard) {
      expect(isLongContextModel(model)).toBe(false)
    }
  })

  test('returns false for unknown model strings', () => {
    expect(isLongContextModel('unknown-model')).toBe(false)
    expect(isLongContextModel('')).toBe(false)
    expect(isLongContextModel('claude-sonnet-4-6')).toBe(false)
  })
})

describe('normalizeRegion', () => {
  test('accepts configured AWS regions with the installed Zod enum shape', () => {
    expect(normalizeRegion('us-west-2')).toBe('us-west-2')
  })
})

describe('Kiro client id', () => {
  test('USER_AGENT carries a supported IDE version', () => {
    expect(KIRO_CONSTANTS.USER_AGENT).toBe(`KiroIDE-${KIRO_IDE_VERSION}`)
    const [major = 0, minor = 0, patch = 0] = KIRO_IDE_VERSION.split('.').map(Number)
    // Kiro rejects IDE versions earlier than 0.11.133 (kirodotdev/Kiro#11335).
    expect(major * 1e6 + minor * 1e3 + patch).toBeGreaterThanOrEqual(11133)
  })

  test('getKiroClientId matches the IDE shape KiroIDE-<version>-<machineId>', () => {
    const id = getKiroClientId()
    expect(id).toMatch(/^KiroIDE-\d+\.\d+\.\d+-[0-9a-f]{64}$/)
    expect(getKiroClientId()).toBe(id)
  })
})
