import { existsSync } from 'node:fs'
import * as logger from './logger.js'
import { updateOpenCodeAuthPlaceholder } from './opencode-auth.js'
import { getCliDbPath } from './sync/kiro-cli-parser.js'

const BOOTSTRAP_PLACEHOLDER_KEY = 'kiro-bootstrap-placeholder'

/**
 * OpenCode only calls the auth loader when there is a stored auth entry for the
 * provider in auth.json. The plugin syncs credentials from the Kiro IDE's local
 * SQLite database, so it doesn't need the user to go through an OAuth flow first.
 *
 * This writes a minimal placeholder entry into auth.json so OpenCode calls the
 * loader on the next startup, where real credentials are synced from Kiro CLI DB.
 */
export function bootstrapAuthIfNeeded(providerId: string): void {
  try {
    const cliDbPath = getCliDbPath()
    if (!existsSync(cliDbPath)) {
      logger.log('Bootstrap: Kiro CLI DB not found, skipping')
      return
    }

    const result = updateOpenCodeAuthPlaceholder(providerId, BOOTSTRAP_PLACEHOLDER_KEY)
    if (result.status === 'unparseable') {
      logger.warn(`Bootstrap: invalid auth.json, skipping placeholder auth setup: ${result.error}`)
    } else if (result.status === 'updated') {
      logger.log(`Bootstrap: wrote placeholder auth entry for provider "${providerId}"`)
      logger.log('Bootstrap: auth.json updated - loader will run on next request')
    }
  } catch (e) {
    logger.warn(`Bootstrap failed: ${e instanceof Error ? e.message : String(e)}`)
  }
}
