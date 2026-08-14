import { ANSI, isTTY, parseKey } from './ansi.js'

const ESCAPE_TIMEOUT_MS = 50
const ANSI_REGEX = new RegExp('\\x1b\\[[0-9;]*m', 'g')
const ANSI_LEADING_REGEX = new RegExp('^\\x1b\\[[0-9;]*m')

export type SelectColor = 'red' | 'green' | 'yellow' | 'cyan'

export interface SelectItem<T> {
  label: string
  value: T
  hint?: string
  color?: SelectColor
  disabled?: boolean
  separator?: boolean
  kind?: 'heading'
}

export interface SelectOptions {
  message: string
  subtitle?: string
  help?: string
  clearScreen?: boolean
}

function stripAnsi(input: string): string {
  return input.replace(ANSI_REGEX, '')
}

function truncateAnsi(input: string, maxVisibleChars: number): string {
  if (maxVisibleChars <= 0) return ''
  const visible = stripAnsi(input)
  if (visible.length <= maxVisibleChars) return input
  const suffix = maxVisibleChars >= 3 ? '...' : '.'.repeat(maxVisibleChars)
  const keep = Math.max(0, maxVisibleChars - suffix.length)
  let out = ''
  let i = 0
  let kept = 0
  while (i < input.length && kept < keep) {
    // Preserve ANSI sequences without counting them.
    if (input[i] === '\x1b') {
      const m = input.slice(i).match(ANSI_LEADING_REGEX)
      if (m) {
        out += m[0]
        i += m[0].length
        continue
      }
    }
    out += input[i]
    i += 1
    kept += 1
  }
  if (out.includes('\x1b[')) {
    return `${out}${ANSI.reset}${suffix}`
  }
  return out + suffix
}

function getColorCode(color?: SelectColor): string {
  switch (color) {
    case 'red':
      return ANSI.red
    case 'green':
      return ANSI.green
    case 'yellow':
      return ANSI.yellow
    case 'cyan':
      return ANSI.cyan
    default:
      return ''
  }
}

/**
 * Render an interactive single-select menu in a raw-mode TTY and resolve with
 * the chosen item's value (or `null` on Esc / Ctrl-C / no TTY-signal).
 *
 * Ported from the antigravity auth plugin's select helper, generalized over the
 * item value type.
 */
export async function select<T>(items: SelectItem<T>[], options: SelectOptions): Promise<T | null> {
  if (!isTTY()) {
    throw new Error('Interactive select requires a TTY terminal')
  }
  if (items.length === 0) {
    throw new Error('No menu items provided')
  }

  const isSelectable = (i: SelectItem<T>) => !i.disabled && !i.separator && i.kind !== 'heading'
  const enabledItems = items.filter(isSelectable)
  if (enabledItems.length === 0) {
    throw new Error('All items disabled')
  }
  if (enabledItems.length === 1) {
    return enabledItems[0]!.value
  }

  const { message, subtitle } = options
  const { stdin, stdout } = process
  let cursor = items.findIndex(isSelectable)
  if (cursor === -1) cursor = 0
  let escapeTimeout: NodeJS.Timeout | null = null
  let isCleanedUp = false
  let renderedLines = 0

  const render = () => {
    const columns = stdout.columns ?? 80
    const rows = stdout.rows ?? 24
    const shouldClearScreen = options.clearScreen === true
    const previousRenderedLines = renderedLines
    if (shouldClearScreen) {
      stdout.write(ANSI.clearScreen + ANSI.moveTo(1, 1))
    } else if (previousRenderedLines > 0) {
      stdout.write(ANSI.up(previousRenderedLines))
    }
    let linesWritten = 0
    const writeLine = (line: string) => {
      stdout.write(`${ANSI.clearLine}${line}\n`)
      linesWritten += 1
    }
    // Subtitle renders as 3 lines: spacer, subtitle, blank. Header counted separately.
    const subtitleLines = subtitle ? 3 : 0
    const fixedLines = 1 + subtitleLines + 2 // header + subtitle + (help + bottom)
    const maxVisibleItems = Math.max(1, Math.min(items.length, rows - fixedLines - 1))
    // If the menu is taller than the viewport, render a window around the cursor.
    let windowStart = 0
    let windowEnd = items.length
    if (items.length > maxVisibleItems) {
      windowStart = cursor - Math.floor(maxVisibleItems / 2)
      windowStart = Math.max(0, Math.min(windowStart, items.length - maxVisibleItems))
      windowEnd = windowStart + maxVisibleItems
    }
    const visibleItems = items.slice(windowStart, windowEnd)
    const headerMessage = truncateAnsi(message, Math.max(1, columns - 4))
    writeLine(`${ANSI.dim}┌  ${ANSI.reset}${headerMessage}`)
    if (subtitle) {
      writeLine(`${ANSI.dim}│${ANSI.reset}`)
      const sub = truncateAnsi(subtitle, Math.max(1, columns - 4))
      writeLine(`${ANSI.cyan}◆${ANSI.reset}  ${sub}`)
      writeLine('')
    }
    for (let i = 0; i < visibleItems.length; i++) {
      const itemIndex = windowStart + i
      const item = visibleItems[i]
      if (!item) continue
      if (item.separator) {
        writeLine(`${ANSI.dim}│${ANSI.reset}`)
        continue
      }
      if (item.kind === 'heading') {
        const heading = truncateAnsi(
          `${ANSI.dim}${ANSI.bold}${item.label}${ANSI.reset}`,
          Math.max(1, columns - 6)
        )
        writeLine(`${ANSI.cyan}│${ANSI.reset}  ${heading}`)
        continue
      }
      const isSelected = itemIndex === cursor
      const colorCode = getColorCode(item.color)
      let labelText: string
      if (item.disabled) {
        labelText = `${ANSI.dim}${item.label} (unavailable)${ANSI.reset}`
      } else if (isSelected) {
        labelText = colorCode ? `${colorCode}${item.label}${ANSI.reset}` : item.label
        if (item.hint) labelText += ` ${ANSI.dim}${item.hint}${ANSI.reset}`
      } else {
        labelText = colorCode
          ? `${ANSI.dim}${colorCode}${item.label}${ANSI.reset}`
          : `${ANSI.dim}${item.label}${ANSI.reset}`
        if (item.hint) labelText += ` ${ANSI.dim}${item.hint}${ANSI.reset}`
      }
      // Prevent wrapping: cursor positioning relies on a fixed line count.
      labelText = truncateAnsi(labelText, Math.max(1, columns - 8))
      if (isSelected) {
        writeLine(`${ANSI.cyan}│${ANSI.reset}  ${ANSI.green}●${ANSI.reset} ${labelText}`)
      } else {
        writeLine(`${ANSI.cyan}│${ANSI.reset}  ${ANSI.dim}○${ANSI.reset} ${labelText}`)
      }
    }
    const windowHint =
      items.length > visibleItems.length ? ` (${windowStart + 1}-${windowEnd}/${items.length})` : ''
    const helpText = options.help ?? `Up/Down to select | Enter: confirm | Esc: back${windowHint}`
    const help = truncateAnsi(helpText, Math.max(1, columns - 6))
    writeLine(`${ANSI.cyan}│${ANSI.reset}  ${ANSI.dim}${help}${ANSI.reset}`)
    writeLine(`${ANSI.cyan}└${ANSI.reset}`)
    if (!shouldClearScreen && previousRenderedLines > linesWritten) {
      const extra = previousRenderedLines - linesWritten
      for (let i = 0; i < extra; i++) {
        writeLine('')
      }
    }
    renderedLines = linesWritten
  }

  return new Promise<T | null>((resolve) => {
    const wasRaw = stdin.isRaw ?? false
    const cleanup = () => {
      if (isCleanedUp) return
      isCleanedUp = true
      if (escapeTimeout) {
        clearTimeout(escapeTimeout)
        escapeTimeout = null
      }
      try {
        stdin.removeListener('data', onKey)
        stdin.setRawMode(wasRaw)
        stdin.pause()
        stdout.write(ANSI.show)
      } catch {
        // Intentionally ignored - cleanup is best-effort
      }
      process.removeListener('SIGINT', onSignal)
      process.removeListener('SIGTERM', onSignal)
    }
    const onSignal = () => {
      cleanup()
      resolve(null)
    }
    const finishWithValue = (value: T | null) => {
      cleanup()
      resolve(value)
    }
    const findNextSelectable = (from: number, direction: number): number => {
      if (items.length === 0) return from
      let next = from
      do {
        next = (next + direction + items.length) % items.length
      } while (items[next]?.disabled || items[next]?.separator || items[next]?.kind === 'heading')
      return next
    }
    const onKey = (data: Buffer) => {
      if (escapeTimeout) {
        clearTimeout(escapeTimeout)
        escapeTimeout = null
      }
      const action = parseKey(data)
      switch (action) {
        case 'up':
          cursor = findNextSelectable(cursor, -1)
          render()
          return
        case 'down':
          cursor = findNextSelectable(cursor, 1)
          render()
          return
        case 'enter':
          finishWithValue(items[cursor]?.value ?? null)
          return
        case 'escape':
          finishWithValue(null)
          return
        case 'escape-start':
          // Bare escape byte - wait to see if more bytes arrive (arrow-key sequence)
          escapeTimeout = setTimeout(() => {
            finishWithValue(null)
          }, ESCAPE_TIMEOUT_MS)
          return
        default:
          return
      }
    }
    process.once('SIGINT', onSignal)
    process.once('SIGTERM', onSignal)
    try {
      stdin.setRawMode(true)
    } catch {
      cleanup()
      resolve(null)
      return
    }
    stdin.resume()
    stdout.write(ANSI.hide)
    render()
    stdin.on('data', onKey)
  })
}
