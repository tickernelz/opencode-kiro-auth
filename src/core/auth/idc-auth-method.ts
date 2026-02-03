import { exec } from 'node:child_process'
import type { AccountRepository } from '../../infrastructure/database/account-repository.js'
import type { KiroIDCTokenResult } from '../../kiro/oauth-idc.js'
import type { AccountManager } from '../../plugin/accounts.js'
import { createDeterministicAccountId } from '../../plugin/accounts.js'
import { promptAddAnotherAccount, promptDeleteAccount, promptLoginMode } from '../../plugin/cli.js'
import * as logger from '../../plugin/logger.js'
import { startIDCAuthServer } from '../../plugin/server.js'
import type { KiroRegion, ManagedAccount } from '../../plugin/types.js'
import { fetchUsageLimits } from '../../plugin/usage.js'

const openBrowser = (url: string) => {
  const escapedUrl = url.replace(/"/g, '\\"')
  const platform = process.platform
  const cmd =
    platform === 'win32'
      ? `cmd /c start "" "${escapedUrl}"`
      : platform === 'darwin'
        ? `open "${escapedUrl}"`
        : `xdg-open "${escapedUrl}"`
  exec(cmd, (error) => {
    if (error) logger.warn(`Browser error: ${error.message}`)
  })
}

export class IdcAuthMethod {
  constructor(
    private config: any,
    private repository: AccountRepository,
    private accountManager: AccountManager
  ) {}

  async authorize(inputs?: any): Promise<{
    url: string
    instructions: string
    method: 'auto'
    callback: () => Promise<{ type: 'success' | 'failed'; key?: string }>
  }> {
    return new Promise(async (resolve) => {
      const region = this.config.default_region
      if (inputs) {
        await this.handleMultipleLogin(region, resolve)
      } else {
        await this.handleSingleLogin(region, resolve)
      }
    })
  }

  private async handleMultipleLogin(region: KiroRegion, resolve: any): Promise<void> {
    const accounts: KiroIDCTokenResult[] = []
    let startFresh = true

    while (true) {
      const existingAccounts = await this.repository.findAll()
      const idcAccs = existingAccounts.filter((a) => a.authMethod === 'idc')

      if (idcAccs.length === 0) {
        break
      }

      const existingAccountsList = idcAccs.map((acc, idx) => ({
        email: acc.email,
        index: idx
      }))
      const mode = await promptLoginMode(existingAccountsList)

      if (mode === 'delete') {
        const deleteIndices = await promptDeleteAccount(existingAccountsList)
        if (deleteIndices !== null && deleteIndices.length > 0) {
          for (const idx of deleteIndices) {
            const accToDelete = idcAccs[idx]
            if (accToDelete) {
              await this.repository.delete(accToDelete.id)
              console.log(`[Success] Deleted: ${accToDelete.email}`)
            }
          }
          console.log(`\n[Success] Deleted ${deleteIndices.length} account(s)\n`)
        }
        continue
      }

      if (mode === 'add') {
        startFresh = false
        break
      }

      if (mode === 'fresh') {
        startFresh = true
        break
      }
    }
    while (true) {
      try {
        const { url, waitForAuth } = await startIDCAuthServer(
          { defaultRegion: region, defaultStartUrl: this.config.builder_id_start_url },
          this.config.auth_server_port_start,
          this.config.auth_server_port_range
        )
        openBrowser(url)
        const res = await waitForAuth()
        const u = await fetchUsageLimits({
          refresh: '',
          access: res.accessToken,
          expires: res.expiresAt,
          authMethod: 'idc',
          region,
          clientId: res.clientId,
          clientSecret: res.clientSecret
        })
        if (!u.email) {
          console.log('\n[Warn] Failed to fetch account email; saving with fallback email.\n')
        }
        const email = u.email || res.email || 'builder-id@aws.amazon.com'
        accounts.push(res as KiroIDCTokenResult)
        if (accounts.length === 1 && startFresh) {
          const allAccounts = await this.repository.findAll()
          const idcAccountsToRemove = allAccounts.filter((a) => a.authMethod === 'idc')
          for (const acc of idcAccountsToRemove) {
            await this.repository.delete(acc.id)
          }
        }
        const id = createDeterministicAccountId(email, 'idc', res.clientId)
        const acc: ManagedAccount = {
          id,
          email,
          authMethod: 'idc',
          region,
          clientId: res.clientId,
          clientSecret: res.clientSecret,
          refreshToken: res.refreshToken,
          accessToken: res.accessToken,
          expiresAt: res.expiresAt,
          rateLimitResetTime: 0,
          isHealthy: true,
          failCount: 0,
          usedCount: u.usedCount,
          limitCount: u.limitCount
        }
        await this.repository.save(acc)
        this.accountManager.addAccount(acc)
        const currentCount = (await this.repository.findAll()).length
        console.log(`\n[Success] Added: ${u.email} (Quota: ${u.usedCount}/${u.limitCount})\n`)
        if (!(await promptAddAnotherAccount(currentCount))) break
      } catch (e: any) {
        console.log(`\n[Error] Login failed: ${e.message}\n`)
        break
      }
    }
    const finalAccounts = await this.repository.findAll()
    return resolve({
      url: '',
      instructions: `Complete (${finalAccounts.length} accounts).`,
      method: 'auto',
      callback: async () => ({
        type: 'success',
        key: finalAccounts[0]?.accessToken || ''
      })
    })
  }

  private async handleSingleLogin(region: KiroRegion, resolve: any): Promise<void> {
    try {
      const { url, waitForAuth } = await startIDCAuthServer(
        { defaultRegion: region, defaultStartUrl: this.config.builder_id_start_url },
        this.config.auth_server_port_start,
        this.config.auth_server_port_range
      )
      openBrowser(url)
      resolve({
        url,
        instructions: `Open: ${url}`,
        method: 'auto',
        callback: async () => {
          try {
            const res = await waitForAuth()

            let u: any = {}
            try {
              u = await fetchUsageLimits({
                refresh: '',
                access: res.accessToken,
                expires: res.expiresAt,
                authMethod: 'idc',
                region,
                clientId: res.clientId,
                clientSecret: res.clientSecret
              })
            } catch (e) {
              logger.warn(
                'Failed to fetch usage/email after auth; saving account with fallback email',
                e
              )
            }

            const email = u.email || res.email || 'builder-id@aws.amazon.com'
            const id = createDeterministicAccountId(email, 'idc', res.clientId)
            const acc: ManagedAccount = {
              id,
              email,
              authMethod: 'idc',
              region,
              clientId: res.clientId,
              clientSecret: res.clientSecret,
              refreshToken: res.refreshToken,
              accessToken: res.accessToken,
              expiresAt: res.expiresAt,
              rateLimitResetTime: 0,
              isHealthy: true,
              failCount: 0,
              usedCount: u.usedCount,
              limitCount: u.limitCount
            }
            await this.repository.save(acc)
            this.accountManager.addAccount(acc)
            return { type: 'success', key: res.accessToken }
          } catch (e: any) {
            return { type: 'failed' }
          }
        }
      })
    } catch (e: any) {
      resolve({
        url: '',
        instructions: 'Failed',
        method: 'auto',
        callback: async () => ({ type: 'failed' })
      })
    }
  }
}
