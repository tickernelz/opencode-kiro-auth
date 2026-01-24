import { stdin as input, stdout as output } from 'node:process'
import { createInterface } from 'node:readline/promises'

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
export type AuthProvider = 'builder-id' | 'identity-center'

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

export async function promptAuthProvider(): Promise<AuthProvider> {
  const rl = createInterface({ input, output })
  try {
    console.log('\nSelect authentication method:')
    console.log('  1. AWS Builder ID')
    console.log('  2. AWS Identity Center')
    console.log('')

    while (true) {
      const answer = await rl.question('Enter choice [1/2]: ')
      const normalized = answer.trim()

      if (normalized === '1') return 'builder-id'
      if (normalized === '2') return 'identity-center'

      console.log("Please enter '1' for Builder ID or '2' for Identity Center.")
    }
  } finally {
    rl.close()
  }
}

export async function promptStartUrl(): Promise<string> {
  const rl = createInterface({ input, output })
  try {
    while (true) {
      const answer = await rl.question('Enter your Identity Center start URL: ')
      const url = answer.trim()

      if (!url) {
        console.log('Start URL cannot be empty.')
        continue
      }

      if (!url.startsWith('https://')) {
        console.log('Start URL must use HTTPS protocol.')
        continue
      }

      try {
        new URL(url)
        return url
      } catch {
        console.log('Invalid URL format.')
      }
    }
  } finally {
    rl.close()
  }
}

export async function promptRegion(): Promise<import('./types').KiroRegion> {
  const rl = createInterface({ input, output })
  try {
    while (true) {
      const answer = await rl.question('Enter region (us-east-1, us-west-2) [us-east-1]: ')
      const region = answer.trim() || 'us-east-1'

      if (region === 'us-east-1' || region === 'us-west-2') {
        return region as import('./types').KiroRegion
      }

      console.log('Supported regions: us-east-1, us-west-2')
    }
  } finally {
    rl.close()
  }
}
