declare module '@openauthjs/openauth' {
  export function generatePKCE(): Promise<{ challenge: string; verifier: string }>;
}
