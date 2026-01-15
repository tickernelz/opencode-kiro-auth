export class KiroTokenRefreshError extends Error {
  code?: string;
  originalError?: Error;
  
  constructor(message: string, code?: string, originalError?: Error) {
    super(message);
    this.name = 'KiroTokenRefreshError';
    this.code = code;
    this.originalError = originalError;
  }
}

export class KiroQuotaExhaustedError extends Error {
  recoveryTime?: number;
  
  constructor(message: string, recoveryTime?: number) {
    super(message);
    this.name = 'KiroQuotaExhaustedError';
    this.recoveryTime = recoveryTime;
  }
}

export class KiroRateLimitError extends Error {
  retryAfter?: number;
  
  constructor(message: string, retryAfter?: number) {
    super(message);
    this.name = 'KiroRateLimitError';
    this.retryAfter = retryAfter;
  }
}

export class KiroAuthError extends Error {
  statusCode?: number;
  
  constructor(message: string, statusCode?: number) {
    super(message);
    this.name = 'KiroAuthError';
    this.statusCode = statusCode;
  }
}
