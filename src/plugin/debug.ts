export function isDebugEnabled(): boolean {
  return !!process.env.DEBUG;
}

export function debugLog(context: string, message: string, data?: unknown): void {
  if (isDebugEnabled()) {
    const formattedData = data !== undefined ? ` ${JSON.stringify(data)}` : '';
    console.debug(`[${context}] ${message}${formattedData}`);
  }
}
