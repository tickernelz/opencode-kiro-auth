import { createTextDeltaEvents, createThinkingDeltaEvents, stopBlock } from './stream-state.js'
import { resetThinkingLexState, scanForTag } from './thinking-lexer.js'
import { StreamEvent, StreamState, THINKING_END_TAG, THINKING_START_TAG } from './types.js'

export function createContentDeltaEvents(text: string, streamState: StreamState): StreamEvent[] {
  if (!text) return []

  if (!streamState.thinkingRequested) {
    return createTextDeltaEvents(text, streamState)
  }

  streamState.buffer += text
  return drainThinkingBuffer(streamState, false)
}

export function flushContentDeltaEvents(streamState: StreamState): StreamEvent[] {
  const events: StreamEvent[] = []

  if (!streamState.thinkingRequested) {
    events.push(...createTextDeltaEvents(streamState.buffer, streamState))
    streamState.buffer = ''
    return events
  }

  events.push(...drainThinkingBuffer(streamState, true))

  if (streamState.inThinking) {
    const remainingThinking = stripThinkingLeadingNewline(streamState.buffer, streamState)
    if (remainingThinking) {
      events.push(...createThinkingDeltaEvents(remainingThinking, streamState))
    }
    streamState.buffer = ''
    events.push(...createThinkingDeltaEvents('', streamState))
    events.push(...stopBlock(streamState.thinkingBlockIndex, streamState))
    return events
  }

  if (!streamState.thinkingExtracted) {
    const remaining = streamState.pendingTextBeforeThinking + streamState.buffer
    streamState.pendingTextBeforeThinking = ''
    streamState.buffer = ''
    events.push(...createTextDeltaEvents(remaining, streamState))
    return events
  }

  const remainingText = stripTextLeadingNewlinesAfterThinking(streamState.buffer, streamState)
  streamState.buffer = ''
  events.push(...createTextDeltaEvents(remainingText, streamState))
  return events
}

function drainThinkingBuffer(
  streamState: StreamState,
  allowEndAtBufferEnd: boolean
): StreamEvent[] {
  const events: StreamEvent[] = []

  while (streamState.buffer.length > 0) {
    if (!streamState.inThinking && !streamState.thinkingExtracted) {
      const scan = scanForTag(
        streamState.buffer,
        streamState.thinkingLex,
        THINKING_START_TAG,
        allowEndAtBufferEnd
      )
      if (scan.tagIndex !== -1) {
        streamState.pendingTextBeforeThinking = ''
        streamState.buffer = streamState.buffer.slice(scan.tagIndex + THINKING_START_TAG.length)
        streamState.inThinking = true
        streamState.stripThinkingLeadingNewline = true
        resetThinkingLexState(streamState.thinkingLex)
        // Content immediately after the open tag is on the same line as the
        // tag, so it is not at a line start until a newline is stripped below.
        streamState.thinkingLex.atLineStart = false
        continue
      }

      const safeLen = scan.safeLength
      if (safeLen > 0) {
        streamState.pendingTextBeforeThinking += streamState.buffer.slice(0, safeLen)
        streamState.buffer = streamState.buffer.slice(safeLen)
      }
      break
    }

    if (streamState.inThinking) {
      streamState.buffer = stripThinkingLeadingNewline(streamState.buffer, streamState)

      const scan = scanForTag(
        streamState.buffer,
        streamState.thinkingLex,
        THINKING_END_TAG,
        allowEndAtBufferEnd
      )

      if (scan.tagIndex !== -1) {
        const thinkingPart = streamState.buffer.slice(0, scan.tagIndex)
        if (thinkingPart) {
          events.push(...createThinkingDeltaEvents(thinkingPart, streamState))
        }

        streamState.buffer = streamState.buffer.slice(scan.tagIndex + THINKING_END_TAG.length)
        streamState.inThinking = false
        streamState.thinkingExtracted = true
        streamState.pendingTextBeforeThinking = ''
        streamState.stripThinkingLeadingNewline = false
        streamState.stripTextLeadingNewlinesAfterThinking = true
        resetThinkingLexState(streamState.thinkingLex)
        events.push(...createThinkingDeltaEvents('', streamState))
        events.push(...stopBlock(streamState.thinkingBlockIndex, streamState))
        continue
      }

      const safeLen = scan.safeLength
      if (safeLen > 0) {
        const safeThinking = streamState.buffer.slice(0, safeLen)
        if (safeThinking) {
          events.push(...createThinkingDeltaEvents(safeThinking, streamState))
        }
        streamState.buffer = streamState.buffer.slice(safeLen)
      }
      break
    }

    const text = stripTextLeadingNewlinesAfterThinking(streamState.buffer, streamState)
    streamState.buffer = ''
    events.push(...createTextDeltaEvents(text, streamState))
    break
  }

  return events
}

function stripThinkingLeadingNewline(text: string, streamState: StreamState): string {
  if (!streamState.stripThinkingLeadingNewline) return text
  if (text.startsWith('\r\n')) {
    streamState.stripThinkingLeadingNewline = false
    streamState.thinkingLex.atLineStart = true
    return text.slice(2)
  }
  if (text.startsWith('\n')) {
    streamState.stripThinkingLeadingNewline = false
    streamState.thinkingLex.atLineStart = true
    return text.slice(1)
  }
  if (text !== '\r') {
    streamState.stripThinkingLeadingNewline = false
  }
  return text
}

function stripTextLeadingNewlinesAfterThinking(text: string, streamState: StreamState): string {
  if (!streamState.stripTextLeadingNewlinesAfterThinking || !text) return text

  const stripped = text.replace(/^[\r\n]+/, '')
  if (stripped.length > 0) {
    streamState.stripTextLeadingNewlinesAfterThinking = false
  }

  return stripped
}
