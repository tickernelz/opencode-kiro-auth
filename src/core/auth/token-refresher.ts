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
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean; tokenRecovered?: boolean }> {
    if (!accessTokenExpired(auth, this.config.token_expiry_buffer_ms)) {
      return { account, shouldContinue: false }
    }

    // Before attempting OIDC refresh (which will fail if the AWS SSO session
    // expired overnight), check whether the Kiro CLI already has a fresh token
    // (e.g. renewed by Kiro IDE running in the background). This avoids the
    // unnecessary OIDC round-trip and the "Exceeded max iterations" error.
    if (this.config.auto_sync_kiro_cli) {
      try {
        await this.syncFromKiroCli()
        this.repository.invalidateCache()
        const accounts = await this.repository.findAll()
        const synced = accounts.find((a: ManagedAccount) => a.id === account.id)
        if (
          synced &&
          !accessTokenExpired(
            this.accountManager.toAuthDetails(synced),
            this.config.token_expiry_buffer_ms
          )
        ) {
          this.accountManager.updateFromAuth(account, this.accountManager.toAuthDetails(synced))
          await this.repository.save(account)
          showToast('Credentials recovered from Kiro CLI sync.', 'info')
          logger.debug('refreshIfNeeded: token recovered from CLI sync before OIDC attempt')
          // tokenRecovered=true tells the caller to reset the retry counter.
          return { account, shouldContinue: true, tokenRecovered: true }
        }
      } catch (e) {
        logger.debug(
          `refreshIfNeeded: pre-sync failed (non-fatal): ${e instanceof Error ? e.message : String(e)}`
        )
      }
    }

    try {
      const newAuth = await refreshAccessToken(auth)
      this.accountManager.updateFromAuth(account, newAuth)
      // Persist only the updated account instead of all accounts — avoids
      // invalidating the whole AccountCache on every token refresh.
      await this.repository.save(account)
      return { account, shouldContinue: false }
    } catch (e: any) {
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
  ): Promise<{ account: ManagedAccount; shouldContinue: boolean; tokenRecovered?: boolean }> {
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
      // tokenRecovered=true signals the caller not to count this as a retry
      // iteration — the token is now valid and the request should proceed.
      return { account: stillAcc, shouldContinue: true, tokenRecovered: true }
    }

    if (
      error instanceof KiroTokenRefreshError &&
      (error.code === 'ExpiredTokenException' ||
        error.code === 'InvalidTokenException' ||
        error.code === 'ExpiredClientException' ||
        error.code === 'HTTP_401' ||
        error.code === 'HTTP_403' ||
        error.code === 'invalid_client' ||
        error.message.includes('Invalid refresh token provided') ||
        error.message.includes('Invalid grant provided') ||
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
