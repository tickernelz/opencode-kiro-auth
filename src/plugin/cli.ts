import { createInterface } from 'node:readline/promises'
import { stdin as input, stdout as output } from 'node:process'

export async function promptAddAnotherAccount(currentCount: number): Promise<boolean> {
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(`Add another account? (${currentCount} added) (y/n): `)
    const normalized = answer.trim().toLowerCase()
    return normalized === 'y' || normalized === 'yes'
  } finally {
    rl.close()
  }
}

export type LoginMode = 'add' | 'fresh'

export interface ExistingAccountInfo {
  email?: string
  index: number
}

export async function promptLoginMode(existingAccounts: ExistingAccountInfo[]): Promise<LoginMode> {
  const rl = createInterface({ input, output })
  try {
    console.log(`\n${existingAccounts.length} account(s) saved:`)
    for (const acc of existingAccounts) {
      const label = acc.email || `Account ${acc.index + 1}`
      console.log(`  ${acc.index + 1}. ${label}`)
    }
    console.log('')

    while (true) {
      const answer = await rl.question('(a)dd new account(s) or (f)resh start? [a/f]: ')
      const normalized = answer.trim().toLowerCase()

      if (normalized === 'a' || normalized === 'add') {
        return 'add'
      }
      if (normalized === 'f' || normalized === 'fresh') {
        return 'fresh'
      }

      console.log("Please enter 'a' to add accounts or 'f' to start fresh.")
    }
  } finally {
    rl.close()
  }
}

export async function promptForSSOUrl(): Promise<string> {
  const rl = createInterface({ input, output })
  try {
    while (true) {
      const answer = await rl.question('SSO Start URL: ')
      const trimmed = answer.trim()

      if (!trimmed) {
        console.log('URL cannot be empty. Please try again.')
        continue
      }

      try {
        new URL(trimmed)
        if (!trimmed.includes('awsapps.com')) {
          console.log('Warning: URL does not appear to be an AWS SSO URL')
          const confirm = await rl.question('Continue anyway? (y/n): ')
          if (confirm.trim().toLowerCase() !== 'y' && confirm.trim().toLowerCase() !== 'yes') {
            continue
          }
        }
        return trimmed
      } catch {
        console.log('Invalid URL format. Please try again.')
      }
    }
  } finally {
    rl.close()
  }
}

export type AuthMethodChoice = 'idc' | 'sso'

export async function promptAuthMethod(): Promise<AuthMethodChoice> {
  const rl = createInterface({ input, output })
  try {
    console.log('\nSelect authentication method:')
    console.log('1. AWS Builder ID (Personal/Trial)')
    console.log('2. AWS SSO (Enterprise/Organization)\n')

    while (true) {
      const answer = await rl.question('Choice (1 or 2): ')
      const choice = answer.trim()

      if (choice === '1') {
        return 'idc'
      }
      if (choice === '2') {
        return 'sso'
      }

      console.log('Invalid choice. Please enter 1 or 2.')
    }
  } finally {
    rl.close()
  }
}

