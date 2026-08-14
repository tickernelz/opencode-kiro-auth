import { select } from './select.js'

/**
 * Yes/No confirmation prompt rendered via the interactive select menu.
 * Returns `false` on Esc / Ctrl-C.
 */
export async function confirm(message: string, defaultYes = false): Promise<boolean> {
  const items = defaultYes
    ? [
        { label: 'Yes', value: true },
        { label: 'No', value: false }
      ]
    : [
        { label: 'No', value: false },
        { label: 'Yes', value: true }
      ]
  const result = await select(items, { message })
  return result ?? false
}
