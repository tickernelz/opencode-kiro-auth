const SYSTEM_REMINDER_START = '<system-reminder>'
const SYSTEM_REMINDER_END = '</system-reminder>'

type LineMode = 'candidate' | 'passthrough'

export class SystemReminderFilter {
  private candidate = ''
  private currentLine = ''
  private inFence = false
  private fenceChar = ''
  private fenceLength = 0
  private lineMode: LineMode = 'candidate'

  push(text: string): string {
    if (!text) return ''

    const output: string[] = []
    for (const char of text) {
      this.currentLine += char

      if (this.lineMode === 'passthrough') {
        output.push(char)
        if (char === '\n') this.finishLine()
        continue
      }

      this.candidate += char
      if (char === '\n') {
        this.finishCandidate(output)
        continue
      }

      if (!this.couldBeMarkerLine()) {
        output.push(this.candidate)
        this.lineMode = 'passthrough'
        this.candidate = ''
      }
    }

    return output.join('')
  }

  flush(): string {
    if (this.lineMode !== 'candidate' || !this.candidate) {
      this.candidate = ''
      this.currentLine = ''
      return ''
    }

    const output: string[] = []
    this.finishCandidate(output)
    return output.join('')
  }

  private couldBeMarkerLine(): boolean {
    if (this.inFence) return false

    const value = this.candidate.trimStart()
    return [SYSTEM_REMINDER_START, SYSTEM_REMINDER_END].some(
      (marker) =>
        marker.startsWith(value) || (value.startsWith(marker) && !value.slice(marker.length).trim())
    )
  }

  private finishCandidate(output: string[]): void {
    const marker = this.candidate.trim()
    if (this.inFence || (marker !== SYSTEM_REMINDER_START && marker !== SYSTEM_REMINDER_END)) {
      output.push(this.candidate)
    }
    this.finishLine()
  }

  private finishLine(): void {
    this.updateFenceState()
    this.candidate = ''
    this.currentLine = ''
    this.lineMode = 'candidate'
  }

  private updateFenceState(): void {
    const line = this.currentLine.replace(/[\r\n]+$/, '').trimStart()
    const match = line.match(/^(`{3,}|~{3,})/)
    if (!match) return

    const marker = match[1]!
    if (!this.inFence) {
      this.inFence = true
      this.fenceChar = marker[0]!
      this.fenceLength = marker.length
    } else if (marker[0] === this.fenceChar && marker.length >= this.fenceLength) {
      this.inFence = false
      this.fenceChar = ''
      this.fenceLength = 0
    }
  }
}
