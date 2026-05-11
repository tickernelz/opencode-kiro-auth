import { describe, expect, test } from 'bun:test'
import { RetryStrategy } from '../core/request/retry-strategy.js'

describe('RetryStrategy', () => {
  test('stops after max_request_iterations', () => {
    const strategy = new RetryStrategy({
      max_request_iterations: 2,
      request_timeout_ms: 60000
    })
    const context = strategy.createContext()

    expect(strategy.shouldContinue(context)).toEqual({ canContinue: true })
    expect(strategy.shouldContinue(context)).toEqual({ canContinue: true })
    expect(strategy.shouldContinue(context)).toEqual({
      canContinue: false,
      error: 'Exceeded max iterations (2)'
    })
  })

  test('stops on request_timeout_ms', () => {
    const strategy = new RetryStrategy({
      max_request_iterations: 20,
      request_timeout_ms: 1
    })
    const context = strategy.createContext()
    context.startTime = Date.now() - 1000

    expect(strategy.shouldContinue(context)).toEqual({
      canContinue: false,
      error: 'Request timeout'
    })
  })
})
