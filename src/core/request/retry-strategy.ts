interface RetryConfig {
  max_request_iterations: number
  request_timeout_ms: number
}

interface RetryContext {
  iterations: number
  startTime: number
  // Time spent in rate-limit waits, excluded from the request timeout budget.
  excludedMs: number
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

    const elapsed = Date.now() - context.startTime - context.excludedMs
    if (elapsed > this.config.request_timeout_ms) {
      return {
        canContinue: false,
        error: 'Request timeout'
      }
    }

    return { canContinue: true }
  }

  markSleep(context: RetryContext, ms: number): void {
    context.excludedMs += Math.max(0, ms)
  }

  createContext(): RetryContext {
    return {
      iterations: 0,
      startTime: Date.now(),
      excludedMs: 0
    }
  }
}
