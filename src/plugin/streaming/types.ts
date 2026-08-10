export interface StreamEvent {
  type: string
  message?: any
  content_block?: any
  delta?: any
  index?: number
  usage?: any
}

export interface StreamState {
  thinkingRequested: boolean
  buffer: string
  inThinking: boolean
  thinkingExtracted: boolean
  thinkingBlockIndex: number | null
  textBlockIndex: number | null
  nextBlockIndex: number
  stoppedBlocks: Set<number>
}

export interface ToolCallState {
  toolUseId: string
  name: string
  input: string
  /** true only when the SDK sent a stop event for this tool call */
  stopped: boolean
  /**
   * Block index assigned when content_block_start was emitted inline during
   * streaming. Undefined for bracket-format tool calls which are emitted
   * post-stream. Used to avoid re-emitting SDK tool calls at the end.
   */
  blockIndex?: number
}

export const THINKING_START_TAG = '<thinking>'
export const THINKING_END_TAG = '</thinking>'
