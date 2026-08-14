import type { AuthOAuthResult } from '@opencode-ai/plugin'
import type { AccountRepository } from '../../infrastructure/database/account-repository.js'
import type { AccountManager } from '../../plugin/accounts.js'
import * as logger from '../../plugin/logger.js'
import type { ManagedAccount } from '../../plugin/types.js'
import { ANSI, isTTY } from '../../plugin/ui/ansi.js'
import { confirm } from '../../plugin/ui/confirm.js'
import { select, type SelectItem } from '../../plugin/ui/select.js'
import { summarizeUsage } from '../../plugin/usage.js'
import { UsageTracker } from '../account/usage-tracker.js'
import type { IdcAuthMethod } from './idc-auth-method.js'
import { TokenRefresher } from './token-refresher.js'

const noopToast = () => {}

type MenuChoice =
  | { type: 'cancel' }
  | { type: 'add' }
  | { type: 'check' }
  | { type: 'delete-all' }
  | { type: 'account'; account: ManagedAccount }

function statusBadge(acc: ManagedAccount): string {
  if (!acc.isHealthy) return `${ANSI.red}[unhealthy]${ANSI.reset}`
  if (acc.rateLimitResetTime && Date.now() < acc.rateLimitResetTime) {
    return `${ANSI.yellow}[rate-limited]${ANSI.reset}`
  }
  return `${ANSI.green}[healthy]${ANSI.reset}`
}

function usageLabel(acc: ManagedAccount): string {
  const { used, limit, pct } = summarizeUsage(acc.usedCount ?? 0, acc.limitCount ?? 0)
  if (limit > 0) return `${used}/${limit} (${pct}%)`
  if (used > 0) return `${used} used`
  return 'usage unknown'
}

/**
 * Interactive multi-account manager shown when the user picks the "Manage
 * accounts" login method. Renders a TUI menu (Add / Check quotas / per-account
 * delete / Delete all) on top of the plugin's existing account storage and
 * rotation backend. Non-login actions return an empty OAuth result whose
 * callback reports `failed`, matching the plugin auth contract without storing
 * a new credential.
 */
export class AccountMenuMethod {
  constructor(
    private config: any,
    private repository: AccountRepository,
    private accountManager: AccountManager,
    private idcMethod: IdcAuthMethod
  ) {}

  async authorize(inputs?: Record<string, string>): Promise<AuthOAuthResult> {
    // The interactive menu needs a raw-mode TTY. In non-interactive contexts
    // (SSH pipes, CI) fall back to the plain add-account flow.
    if (!isTTY()) {
      return this.idcMethod.authorize(inputs)
    }
    try {
      return await this.runMenu(inputs)
    } catch (e) {
      logger.warn('Account menu failed; falling back to add-account flow', {
        error: e instanceof Error ? e.message : String(e)
      })
      return this.idcMethod.authorize(inputs)
    }
  }

  private done(message: string): AuthOAuthResult {
    return {
      url: '',
      instructions: message,
      method: 'auto',
      callback: async () => ({ type: 'failed' })
    }
  }

  private async runMenu(inputs?: Record<string, string>): Promise<AuthOAuthResult> {
    for (;;) {
      const accounts = this.accountManager.getAccounts()
      const choice = await select<MenuChoice>(this.buildItems(accounts), {
        message: 'Kiro accounts',
        subtitle: 'Select an action or account',
        clearScreen: true
      })

      if (!choice || choice.type === 'cancel') {
        return this.done('Closed account manager.')
      }

      if (choice.type === 'add') {
        // Delegate to the real OAuth device flow (AWS Builder ID by default).
        return this.idcMethod.authorize(inputs)
      }

      if (choice.type === 'check') {
        await this.checkQuotas(accounts)
        continue
      }

      if (choice.type === 'delete-all') {
        const ok = await confirm('Delete ALL accounts? This cannot be undone.')
        if (!ok) continue
        for (const a of accounts) this.accountManager.removeAccount(a)
        return this.done('All accounts deleted. Run `opencode auth login` to re-add.')
      }

      if (choice.type === 'account') {
        await this.accountSubmenu(choice.account)
        continue
      }
    }
  }

  private buildItems(accounts: ManagedAccount[]): SelectItem<MenuChoice>[] {
    const items: SelectItem<MenuChoice>[] = [
      { label: 'Actions', value: { type: 'cancel' }, kind: 'heading' },
      { label: 'Add account', value: { type: 'add' }, color: 'cyan' },
      { label: 'Check quotas (refresh all)', value: { type: 'check' }, color: 'cyan' }
    ]

    if (accounts.length > 0) {
      items.push({ label: '', value: { type: 'cancel' }, separator: true })
      items.push({ label: 'Accounts', value: { type: 'cancel' }, kind: 'heading' })
      accounts.forEach((acc, idx) => {
        items.push({
          label: `${idx + 1}. ${acc.email} ${statusBadge(acc)}`,
          hint: usageLabel(acc),
          value: { type: 'account', account: acc }
        })
      })
      items.push({ label: '', value: { type: 'cancel' }, separator: true })
      items.push({ label: 'Danger zone', value: { type: 'cancel' }, kind: 'heading' })
      items.push({ label: 'Delete all accounts', value: { type: 'delete-all' }, color: 'red' })
    }

    return items
  }

  private async accountSubmenu(acc: ManagedAccount): Promise<void> {
    const action = await select<'back' | 'delete'>(
      [
        { label: 'Back', value: 'back' },
        { label: 'Delete this account', value: 'delete', color: 'red' }
      ],
      {
        message: `${acc.email} ${statusBadge(acc)}`,
        subtitle: `Usage: ${usageLabel(acc)} | Method: ${acc.authMethod} | Region: ${acc.region}`,
        clearScreen: true
      }
    )

    if (action === 'delete') {
      const ok = await confirm(`Delete ${acc.email}?`)
      if (ok) this.accountManager.removeAccount(acc)
    }
  }

  private async checkQuotas(accounts: ManagedAccount[]): Promise<void> {
    const out = process.stdout
    out.write(ANSI.clearScreen + ANSI.moveTo(1, 1))
    out.write(`${ANSI.bold}Checking quotas for ${accounts.length} account(s)...${ANSI.reset}\n\n`)

    if (accounts.length === 0) {
      out.write('  No accounts. Choose "Add account" first.\n')
      await this.waitForKey()
      return
    }

    const { syncFromKiroCli } = await import('../../plugin/sync/kiro-cli.js')
    const tokenRefresher = new TokenRefresher(
      this.config,
      this.accountManager,
      syncFromKiroCli,
      this.repository
    )
    const usageTracker = new UsageTracker(this.config, this.accountManager, this.repository)

    for (const acc of accounts) {
      out.write(`  ${acc.email} ... `)
      try {
        const { account: usable } = await tokenRefresher.refreshIfNeeded(
          acc,
          this.accountManager.toAuthDetails(acc),
          noopToast
        )
        if (!usable.isHealthy) {
          out.write(`${ANSI.red}unhealthy (${usable.unhealthyReason ?? 'unknown'})${ANSI.reset}\n`)
          continue
        }
        await usageTracker.syncNow(usable, this.accountManager.toAuthDetails(usable))
        const fresh = this.accountManager.getAccounts().find((a) => a.id === acc.id) ?? usable
        const { used, limit, pct } = summarizeUsage(fresh.usedCount ?? 0, fresh.limitCount ?? 0)
        const color = pct >= 90 ? ANSI.red : pct >= 60 ? ANSI.yellow : ANSI.green
        out.write(
          limit > 0
            ? `${color}${used}/${limit} (${pct}%)${ANSI.reset}\n`
            : `${color}${used} used${ANSI.reset}\n`
        )
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        out.write(`${ANSI.red}error: ${msg.slice(0, 100)}${ANSI.reset}\n`)
      }
    }

    out.write(`\n  ${ANSI.dim}Press any key to return to the menu...${ANSI.reset}`)
    await this.waitForKey()
  }

  private waitForKey(): Promise<void> {
    return new Promise((resolve) => {
      const stdin = process.stdin
      if (!stdin.isTTY) {
        resolve()
        return
      }
      const wasRaw = stdin.isRaw ?? false
      const cleanup = () => {
        stdin.removeListener('data', onData)
        try {
          stdin.setRawMode(wasRaw)
        } catch {
          // best-effort
        }
        stdin.pause()
      }
      const onData = () => {
        cleanup()
        resolve()
      }
      try {
        stdin.setRawMode(true)
      } catch {
        // best-effort
      }
      stdin.resume()
      stdin.once('data', onData)
    })
  }
}
