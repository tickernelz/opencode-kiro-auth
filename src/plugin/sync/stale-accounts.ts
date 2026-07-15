export type SyncedCliAccount = {
  id: string
  email: string
  authMethod: 'idc' | 'desktop'
  clientId?: string
  profileArn?: string
}

export const STALE_CLI_ACCOUNT_REASON =
  'InvalidTokenException: Replaced by active Kiro CLI account during sync'

export function getStaleKiroCliAccountIds(
  accounts: any[],
  syncedAccounts: SyncedCliAccount[]
): string[] {
  if (syncedAccounts.length === 0) return []

  const syncedIds = new Set(syncedAccounts.map((acc) => acc.id))

  return accounts
    .filter((account) => {
      if (!account?.id || syncedIds.has(account.id)) return false

      const authMethod = account.auth_method || account.authMethod
      const email = account.email
      const clientId = account.client_id || account.clientId
      const profileArn = account.profile_arn || account.profileArn
      return syncedAccounts.some((synced) => {
        if (authMethod !== synced.authMethod) return false
        if (profileArn && synced.profileArn) return profileArn === synced.profileArn
        if (clientId && synced.clientId) return clientId === synced.clientId
        return !!email && email === synced.email
      })
    })
    .map((account) => account.id)
}
