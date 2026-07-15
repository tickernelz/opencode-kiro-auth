// Stateful lexer for locating a "real" thinking control tag (`<thinking>` or
// `</thinking>`) inside model output. The lexer carries lexical state (inside a
// quoted span / inline code span / fenced code block) across chunk boundaries
// so that literal tags embedded in quotes or code never open or close the
// reasoning block, even when the surrounding quote or fence is split across
// multiple SDK chunks.

export interface ThinkingLexState {
  // Inside a ``` / ~~~ fenced code block.
  inFence: boolean
  // The marker character that opened the current fence ('`' or '~').
  fenceChar: string
  // The number of marker characters that opened the current fence.
  fenceLen: number
  // Number of backticks of an open inline code span (0 when not in a span).
  inlineTicks: number
  // The quote character of an open quoted span ('"' or "'"), '' when none.
  quote: string
  // True when the previous character inside a quoted span was a backslash.
  quoteEscape: boolean
  // Last committed character, used to avoid treating apostrophes in words as
  // single-quote delimiters.
  lastChar: string
  // Whether the scanner is at the logical start of a line (ignoring leading
  // whitespace), used for fenced-code detection.
  atLineStart: boolean
}

export interface ThinkingScanResult {
  // Index in `text` where the real tag begins, or -1 when not found.
  tagIndex: number
  // Number of leading characters of `text` that are safe to emit and whose
  // lexical state has been folded into `lex`. Equals `tagIndex` when a tag is
  // found.
  safeLength: number
}

export function createThinkingLexState(): ThinkingLexState {
  return {
    inFence: false,
    fenceChar: '',
    fenceLen: 0,
    inlineTicks: 0,
    quote: '',
    quoteEscape: false,
    lastChar: '',
    atLineStart: true
  }
}

export function resetThinkingLexState(lex: ThinkingLexState): void {
  lex.inFence = false
  lex.fenceChar = ''
  lex.fenceLen = 0
  lex.inlineTicks = 0
  lex.quote = ''
  lex.quoteEscape = false
  lex.lastChar = ''
  lex.atLineStart = true
}

function measureRun(text: string, start: number, ch: string): { len: number; complete: boolean } {
  let len = 0
  while (start + len < text.length && text[start + len] === ch) len++
  // The run is "complete" only when a different character follows it inside the
  // available text. A run that reaches the end of the buffer might continue in
  // the next chunk, so it cannot be classified yet.
  return { len, complete: start + len < text.length }
}

function isPartialTagAtEnd(text: string, index: number, tag: string): boolean {
  const tail = text.slice(index)
  return tail.length < tag.length && tag.startsWith(tail)
}

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t'
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch)
}

function isLikelyOpeningSingleQuote(prev: string, next: string | undefined): boolean {
  if (!next || isWhitespace(next) || next === '\n' || next === '\r') return false
  return !prev || !isWordChar(prev)
}

function commitChar(lex: ThinkingLexState, ch: string): void {
  lex.lastChar = ch
}

// Scans `text` for the first lexically "real" occurrence of `tag`, folding
// lexical transitions into `lex`. When `flush` is false the scanner retains
// trailing characters that could be the prefix of the tag or an unterminated
// backtick run so that tokens split across chunks are handled correctly on the
// next call.
export function scanForTag(
  text: string,
  lex: ThinkingLexState,
  tag: string,
  flush: boolean
): ThinkingScanResult {
  let i = 0
  let committed = 0

  while (i < text.length) {
    const ch = text[i]!

    if (ch === '\n') {
      lex.atLineStart = true
      i += 1
      committed = i
      commitChar(lex, ch)
      continue
    }

    if (lex.inFence) {
      if (lex.atLineStart && ch === lex.fenceChar) {
        const run = measureRun(text, i, ch)
        if (!run.complete && !flush) break
        if (run.len >= lex.fenceLen) {
          lex.inFence = false
          lex.fenceChar = ''
          lex.fenceLen = 0
        }
        i += run.len
        lex.atLineStart = false
        committed = i
        commitChar(lex, ch)
        continue
      }
      if (!isWhitespace(ch)) lex.atLineStart = false
      i += 1
      committed = i
      commitChar(lex, ch)
      continue
    }

    if (lex.inlineTicks > 0) {
      if (ch === '`') {
        const run = measureRun(text, i, ch)
        if (!run.complete && !flush) break
        if (run.len === lex.inlineTicks) {
          lex.inlineTicks = 0
        }
        i += run.len
        lex.atLineStart = false
        committed = i
        commitChar(lex, ch)
        continue
      }
      if (!isWhitespace(ch)) lex.atLineStart = false
      i += 1
      committed = i
      commitChar(lex, ch)
      continue
    }

    if (lex.quote) {
      if (lex.quoteEscape) {
        lex.quoteEscape = false
      } else if (ch === '\\') {
        lex.quoteEscape = true
      } else if (ch === lex.quote) {
        lex.quote = ''
      }
      if (!isWhitespace(ch)) lex.atLineStart = false
      i += 1
      committed = i
      commitChar(lex, ch)
      continue
    }

    // Normal (unprotected) state.
    if (ch === '<') {
      if (text.startsWith(tag, i)) {
        return { tagIndex: i, safeLength: i }
      }
      if (!flush && isPartialTagAtEnd(text, i, tag)) break
      lex.atLineStart = false
      i += 1
      committed = i
      commitChar(lex, ch)
      continue
    }

    if (ch === '`' || ch === '~') {
      const run = measureRun(text, i, ch)
      if (!run.complete && !flush) break
      if (lex.atLineStart && run.len >= 3) {
        lex.inFence = true
        lex.fenceChar = ch
        lex.fenceLen = run.len
      } else if (ch === '`') {
        lex.inlineTicks = run.len
      }
      // A tilde run that is not a fence is treated as literal text.
      i += run.len
      lex.atLineStart = false
      committed = i
      commitChar(lex, ch)
      continue
    }

    if (ch === '"' || (ch === "'" && isLikelyOpeningSingleQuote(lex.lastChar, text[i + 1]))) {
      lex.quote = ch
      lex.atLineStart = false
      i += 1
      committed = i
      commitChar(lex, ch)
      continue
    }

    if (!isWhitespace(ch)) lex.atLineStart = false
    i += 1
    committed = i
    commitChar(lex, ch)
  }

  return { tagIndex: -1, safeLength: committed }
}
