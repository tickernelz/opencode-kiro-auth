interface RetryConfig {
  max_request_iterations: number
  request_timeout_ms: number
}

export interface RetryContext {
  iterations: number
  startTime: number
}

export class RetryStrategy {
  constructor(private config: RetryConfig) {}

  shouldContinue(context: RetryContext): { canContinue: boolean; error?: string } {
    context.iterations++

    if (context.iterations > this.config.max_request_iterations) {
      return {
        canContinue: false,
        error: `Exceeded max iterations (${this.config.max_request_iterations})`
      }
    }

    if (Date.now() - context.startTime > this.config.request_timeout_ms) {
      return {
        canContinue: false,
        error: 'Request timeout'
      }
    }

    return { canContinue: true }
  }

  createContext(): RetryContext {
    return {
      iterations: 0,
      startTime: Date.now()
    }
  }

  /**
   * Reset the context after a successful token recovery so that token-refresh
   * cycles don't consume request iterations. Call this whenever the loop
   * must continue but no actual API attempt was made (e.g. CLI sync recovery).
   */
  resetContext(context: RetryContext): void {
    context.iterations = 0
    context.startTime = Date.now()
  }
}
