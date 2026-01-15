function formatTimestamp(): string {
  return new Date().toISOString();
}

export function log(message: string, ...args: unknown[]): void {
  console.log(`[${formatTimestamp()}] ${message}`, ...args);
}

export function error(message: string, ...args: unknown[]): void {
  console.error(`[${formatTimestamp()}] ERROR: ${message}`, ...args);
}

export function warn(message: string, ...args: unknown[]): void {
  console.warn(`[${formatTimestamp()}] WARN: ${message}`, ...args);
}

export function debug(message: string, ...args: unknown[]): void {
  if (process.env.DEBUG) {
    console.debug(`[${formatTimestamp()}] DEBUG: ${message}`, ...args);
  }
}
