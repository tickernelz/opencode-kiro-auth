import type { AccountRepository } from '../../infrastructure/database/account-repository'
import { accessTokenExpired } from '../../kiro/auth'
import type { AccountManager } from '../../plugin/accounts'
import { KiroTokenRefreshError } from '../../plugin/errors'
import * as logger from '../../plugin/logger'
import { refreshAccessToken } from '../../plugin/token'
import type { KiroAuthDetails, ManagedAccount } from '../../plugin/types'

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

interface TokenRefresherConfig {
  token_expiry_buffer_ms: number
  auto_sync_kiro_cli: boolean
  account_selection_strategy: 'sticky' | 'round-robin' | 'lowest-usage'
}

// Observed endpoint responses:
//   oidc.{region}.amazonaws.com/token, wrong region  -> 400 invalid_request /
//                                        "Invalid token provided"
//   oidc.{region}.amazonaws.com/token, spent token   -> 400 invalid_grant /
//                                        "Invalid refresh token provided"
function isWrongRegionError(error: any): boolean {
  if (error instanceof KiroTokenRefreshError && error.code === 'invalid_request') {
    return true
  }
  const message = error instanceof Error ? error.message : String(error ?? '')
  const lower = message.toLowerCase()
  return lower.includes('invalid token provided') && !lower.includes('invalid refresh token')
}

export class TokenRefresher {
  constructor(
    private config: TokenRefresherConfig,
    private accountManager: AccountManager,
    private syncFromKiroCli: () => Promise<void>,
    private repository: AccountRepository
  ) {}

  async refreshIfNeeded(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }> {
    if (!accessTokenExpired(auth, this.config.token_expiry_buffer_ms)) {
      return { account, shouldContinue: false }
    }

    try {
      const newAuth = await refreshAccessToken(auth)
      this.accountManager.updateFromAuth(account, newAuth)
      // Persist only the updated account instead of all accounts — avoids
      // invalidating the whole AccountCache on every token refresh.
      await this.repository.save(account)
      return { account, shouldContinue: false }
    } catch (e: any) {
      if (isWrongRegionError(e)) {
        logger.error(
          'Token refresh failed: wrong OIDC region. The refresh token was likely issued at a ' +
            'different region than the one used for this request, so retrying will not help — ' +
            'the account needs its stored region corrected (re-sync from Kiro CLI, or reauth).',
          {
            email: account.email,
            regionUsed: auth.oidcRegion || auth.region,
            code: e instanceof KiroTokenRefreshError ? e.code : undefined
          }
        )
      }
      return await this.handleRefreshError(e, account, showToast)
    }
  }

  async forceRefresh(account: ManagedAccount, auth: KiroAuthDetails): Promise<void> {
    if (this.config.auto_sync_kiro_cli) {
      await this.syncFromKiroCli()
    }

    this.repository.invalidateCache()
    const accounts = await this.repository.findAll()
    const synced = accounts.find((a: ManagedAccount) => a.id === account.id)

    if (synced && synced.accessToken !== account.accessToken) {
      this.accountManager.updateFromAuth(account, this.accountManager.toAuthDetails(synced))
      await this.repository.batchSave(this.accountManager.getAccounts())
      logger.debug('Force refresh: recovered newer token from CLI sync')
      return
    }

    try {
      const newAuth = await refreshAccessToken(auth)
      this.accountManager.updateFromAuth(account, newAuth)
      await this.repository.batchSave(this.accountManager.getAccounts())
      logger.debug('Force refresh: token refreshed via OIDC')
    } catch (e: any) {
      logger.warn('Force refresh failed, will retry with current token', {
        message: e instanceof Error ? e.message : String(e)
      })
    }
  }

  private async handleRefreshError(
    error: any,
    account: ManagedAccount,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean }> {
    logger.error('Token refresh failed', {
      email: account.email,
      code: error instanceof KiroTokenRefreshError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error)
    })
    if (this.config.auto_sync_kiro_cli) {
      await this.syncFromKiroCli()
    }

    this.repository.invalidateCache()
    const accounts = await this.repository.findAll()
    const stillAcc = accounts.find((a: ManagedAccount) => a.id === account.id)

    if (
      stillAcc &&
      !accessTokenExpired(
        this.accountManager.toAuthDetails(stillAcc),
        this.config.token_expiry_buffer_ms
      )
    ) {
      showToast('Credentials recovered from Kiro CLI sync.', 'info')
      return { account: stillAcc, shouldContinue: true }
    }

    if (
      error instanceof KiroTokenRefreshError &&
      (error.code === 'ExpiredTokenException' ||
        error.code === 'InvalidTokenException' ||
        error.code === 'ExpiredClientException' ||
        error.code === 'HTTP_401' ||
        error.code === 'HTTP_403' ||
        error.message.includes('Invalid refresh token provided') ||
        error.message.includes('Invalid grant provided') ||
        error.message.includes('Invalid token provided') ||
        error.message.includes('Client is expired'))
    ) {
      this.accountManager.markUnhealthy(account, error.code || error.message)
      await this.repository.batchSave(this.accountManager.getAccounts())
      return { account, shouldContinue: true }
    }

    logger.error('Token refresh unrecoverable', {
      email: account.email,
      code: error instanceof KiroTokenRefreshError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error)
    })
    throw error
  }
}
