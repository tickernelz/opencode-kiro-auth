import { findRealTag, findRealThinkingEndTag } from './stream-parser.js'
import { createTextDeltaEvents, createThinkingDeltaEvents, stopBlock } from './stream-state.js'
import { StreamEvent, StreamState, THINKING_END_TAG, THINKING_START_TAG } from './types.js'

const START_TAG_KEEP_CHARS = THINKING_START_TAG.length - 1
const END_TAG_KEEP_CHARS = THINKING_END_TAG.length - 1

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
      const startPos = findRealTag(streamState.buffer, THINKING_START_TAG)
      if (startPos !== -1) {
        streamState.pendingTextBeforeThinking = ''
        streamState.buffer = streamState.buffer.slice(startPos + THINKING_START_TAG.length)
        streamState.inThinking = true
        streamState.stripThinkingLeadingNewline = true
        continue
      }

      const safeLen = allowEndAtBufferEnd
        ? streamState.buffer.length
        : Math.max(0, streamState.buffer.length - START_TAG_KEEP_CHARS)
      if (safeLen > 0) {
        streamState.pendingTextBeforeThinking += streamState.buffer.slice(0, safeLen)
        streamState.buffer = streamState.buffer.slice(safeLen)
      }
      break
    }

    if (streamState.inThinking) {
      streamState.buffer = stripThinkingLeadingNewline(streamState.buffer, streamState)

      const endPos = findRealThinkingEndTag(
        streamState.buffer,
        THINKING_END_TAG,
        allowEndAtBufferEnd
      )
      if (endPos !== -1) {
        const thinkingPart = streamState.buffer.slice(0, endPos)
        if (thinkingPart) {
          events.push(...createThinkingDeltaEvents(thinkingPart, streamState))
        }

        streamState.buffer = streamState.buffer.slice(endPos + THINKING_END_TAG.length)
        streamState.inThinking = false
        streamState.thinkingExtracted = true
        streamState.pendingTextBeforeThinking = ''
        streamState.stripThinkingLeadingNewline = false
        streamState.stripTextLeadingNewlinesAfterThinking = true
        events.push(...createThinkingDeltaEvents('', streamState))
        events.push(...stopBlock(streamState.thinkingBlockIndex, streamState))
        continue
      }

      const unresolvedEndPos = findRealTag(streamState.buffer, THINKING_END_TAG)
      const safeLen =
        unresolvedEndPos !== -1
          ? unresolvedEndPos
          : allowEndAtBufferEnd
            ? streamState.buffer.length
            : Math.max(0, streamState.buffer.length - END_TAG_KEEP_CHARS)
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
    return text.slice(2)
  }
  if (text.startsWith('\n')) {
    streamState.stripThinkingLeadingNewline = false
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
