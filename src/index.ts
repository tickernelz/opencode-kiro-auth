export { KiroOAuthPlugin } from './plugin.js'

export type { KiroConfig } from './plugin/config/index.js'
export type { KiroAuthMethod, KiroRegion, ManagedAccount } from './plugin/types.js'

export default { id: 'kiro-auth', server: (await import('./plugin.js')).KiroOAuthPlugin }
