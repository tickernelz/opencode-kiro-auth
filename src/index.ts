import type { Plugin } from '@opencode/plugin'
import { KiroOAuthPlugin } from './plugin.js'

export { KiroOAuthPlugin } from './plugin.js'

export type { KiroConfig } from './plugin/config/index.js'
export type { KiroAuthMethod, KiroRegion, ManagedAccount } from './plugin/types.js'

/**
 * One default export serves both OpenCode generations:
 * - OpenCode V2 reads `id` and calls `setup(ctx)`, ignoring `server`.
 * - OpenCode V1 (1.18.29+) calls `server()` and uses the returned hooks.
 *
 * The two implementations share the account and request machinery in
 * runtime.ts but register through their own host APIs.
 */
export default {
  id: 'kiro',
  // Loaded lazily so V1 never evaluates the V2-only modules.
  setup: async (ctx: Plugin.Context) => (await import('./plugin-v2.js')).setupKiroV2(ctx),
  server: KiroOAuthPlugin
}
