import { KIRO_PROVIDER_ID } from './constants.js'

export { KIRO_LEGACY_PROVIDER_ID, KIRO_PROVIDER_ID } from './constants.js'
export { KiroOAuthPlugin } from './plugin.js'
export type { KiroConfig } from './plugin/config/index.js'
export type { KiroAuthMethod, KiroRegion, ManagedAccount } from './plugin/types.js'

export default { id: KIRO_PROVIDER_ID, server: (await import('./plugin.js')).KiroOAuthPlugin }
