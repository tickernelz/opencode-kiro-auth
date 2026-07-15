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
  private refreshInFlight = new Map<string, Promise<KiroAuthDetails>>()

  constructor(
    private config: TokenRefresherConfig,
    private accountManager: AccountManager,
    private syncFromKiroCli: () => Promise<void>,
    private repository: AccountRepository,
    private refresh: (auth: KiroAuthDetails) => Promise<KiroAuthDetails> = refreshAccessToken
  ) {}

  async refreshIfNeeded(
    account: ManagedAccount,
    auth: KiroAuthDetails,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; auth: KiroAuthDetails; shouldContinue: boolean }> {
    if (!accessTokenExpired(auth, this.config.token_expiry_buffer_ms)) {
      return { account, auth, shouldContinue: false }
    }

    try {
      let refresh = this.refreshInFlight.get(account.id)
      if (!refresh) {
        refresh = this.refreshAccount(account, auth)
        this.refreshInFlight.set(account.id, refresh)
        refresh.finally(() => this.refreshInFlight.delete(account.id)).catch(() => {})
      }
      const newAuth = await refresh
      return { account, auth: newAuth, shouldContinue: false }
    } catch (e: any) {
      return await this.handleRefreshError(e, account, showToast)
    }
  }

  private async handleRefreshError(
    error: any,
    account: ManagedAccount,
    showToast: ToastFunction
  ): Promise<{ account: ManagedAccount; auth: KiroAuthDetails; shouldContinue: boolean }> {
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
    const hasUsableCredentials = (candidate: ManagedAccount) =>
      !accessTokenExpired(
        this.accountManager.toAuthDetails(candidate),
        this.config.token_expiry_buffer_ms
      )
    let stillAcc = accounts.find(
      (candidate: ManagedAccount) => candidate.id === account.id && hasUsableCredentials(candidate)
    )
    if (!stillAcc && account.profileArn) {
      stillAcc = accounts.find(
        (candidate: ManagedAccount) =>
          candidate.authMethod === account.authMethod &&
          candidate.profileArn === account.profileArn &&
          hasUsableCredentials(candidate)
      )
    }
    if (!stillAcc && !account.profileArn && account.clientId) {
      stillAcc = accounts.find(
        (candidate: ManagedAccount) =>
          candidate.authMethod === account.authMethod &&
          !candidate.profileArn &&
          candidate.clientId === account.clientId &&
          hasUsableCredentials(candidate)
      )
    }

    if (stillAcc) {
      if (stillAcc.id !== account.id) this.accountManager.removeAccount(account)
      this.accountManager.addAccount(stillAcc)
      const recoveredAuth = this.accountManager.toAuthDetails(stillAcc)
      showToast('Credentials recovered from Kiro CLI sync.', 'info')
      return {
        account: stillAcc,
        auth: recoveredAuth,
        shouldContinue: false
      }
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
        error.message.includes('Client is expired'))
    ) {
      this.accountManager.markUnhealthy(account, error.message)
      await this.repository.batchSave(this.accountManager.getAccounts())
      return { account, auth: this.accountManager.toAuthDetails(account), shouldContinue: true }
    }

    logger.error('Token refresh unrecoverable', {
      email: account.email,
      code: error instanceof KiroTokenRefreshError ? error.code : undefined,
      message: error instanceof Error ? error.message : String(error)
    })
    throw error
  }

  private async refreshAccount(
    account: ManagedAccount,
    auth: KiroAuthDetails
  ): Promise<KiroAuthDetails> {
    const newAuth = await this.refresh(auth)
    this.accountManager.updateFromAuth(account, newAuth)
    await this.repository.batchSave(this.accountManager.getAccounts())
    return newAuth
  }
}
