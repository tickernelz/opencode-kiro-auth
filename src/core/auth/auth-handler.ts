import type { AccountRepository } from '../../infrastructure/database/account-repository.js'
import { IdcAuthMethod } from './idc-auth-method.js'

export class AuthHandler {
  private accountManager?: any

  constructor(
    private config: any,
    private repository: AccountRepository
  ) {}

  async initialize(): Promise<void> {
    const { syncFromKiroCli } = await import('../../plugin/sync/kiro-cli.js')

    if (this.config.auto_sync_kiro_cli) {
      await syncFromKiroCli()
    }
  }

  setAccountManager(am: any): void {
    this.accountManager = am
  }

  getMethods(): Array<{
    id: string
    label: string
    type: 'oauth'
    authorize: (inputs?: any) => Promise<any>
  }> {
    if (!this.accountManager) {
      return []
    }

    const idcMethod = new IdcAuthMethod(this.config, this.repository, this.accountManager)

    return [
      {
        id: 'idc',
        label: 'AWS Builder ID (IDC)',
        type: 'oauth',
        authorize: (inputs?: any) => idcMethod.authorize(inputs)
      }
    ]
  }
}
