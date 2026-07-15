import { createThinkingLexState } from './thinking-lexer.js'
import { StreamEvent, StreamState } from './types.js'

export function createStreamState(thinkingRequested: boolean): StreamState {
  return {
    thinkingRequested,
    buffer: '',
    pendingTextBeforeThinking: '',
    inThinking: false,
    thinkingExtracted: false,
    thinkingBlockIndex: null,
    textBlockIndex: null,
    nextBlockIndex: 0,
    stoppedBlocks: new Set(),
    stripThinkingLeadingNewline: false,
    stripTextLeadingNewlinesAfterThinking: false,
    thinkingLex: createThinkingLexState()
  }
}

export function ensureBlockStart(
  blockType: 'thinking' | 'text',
  streamState: StreamState
): StreamEvent[] {
  if (blockType === 'thinking') {
    if (streamState.thinkingBlockIndex != null) return []
    const idx = streamState.nextBlockIndex++
    streamState.thinkingBlockIndex = idx
    return [
      {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'thinking', thinking: '' }
      }
    ]
  }
  if (blockType === 'text') {
    if (streamState.textBlockIndex != null) return []
    const idx = streamState.nextBlockIndex++
    streamState.textBlockIndex = idx
    return [
      {
        type: 'content_block_start',
        index: idx,
        content_block: { type: 'text', text: '' }
      }
    ]
  }
  return []
}

export function stopBlock(index: number | null, streamState: StreamState): StreamEvent[] {
  if (index == null) return []
  if (streamState.stoppedBlocks.has(index)) return []
  streamState.stoppedBlocks.add(index)
  return [{ type: 'content_block_stop', index }]
}

export function createTextDeltaEvents(text: string, streamState: StreamState): StreamEvent[] {
  if (!text) return []
  const events: StreamEvent[] = []
  events.push(...ensureBlockStart('text', streamState))
  events.push({
    type: 'content_block_delta',
    index: streamState.textBlockIndex!,
    delta: { type: 'text_delta', text }
  })
  return events
}

export function createThinkingDeltaEvents(
  thinking: string,
  streamState: StreamState
): StreamEvent[] {
  const events: StreamEvent[] = []
  events.push(...ensureBlockStart('thinking', streamState))
  events.push({
    type: 'content_block_delta',
    index: streamState.thinkingBlockIndex!,
    delta: { type: 'thinking_delta', thinking }
  })
  return events
}
