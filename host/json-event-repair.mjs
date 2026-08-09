import { stripVTControlCharacters } from 'node:util'

const DEFAULT_MAX_DISCARDED_LINES = 32
const DEFAULT_MAX_DISCARDED_CHARACTERS = 32 * 1024

function plainEvent(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null
}

function parseEvent(value) {
  try {
    return plainEvent(JSON.parse(value))
  } catch {
    return null
  }
}

/**
 * Parses one provider protocol line without retaining malformed content. ANSI
 * framing is the only in-line rewrite; all other non-JSON text is quarantined
 * and may be ignored only by a caller that later proves terminal success.
 */
export function decodeJsonEventLine(line) {
  const trimmed = typeof line === 'string' ? line.trim() : ''
  if (!trimmed) return { kind: 'blank' }

  const event = parseEvent(trimmed)
  if (event) return { kind: 'event', event, normalized: false }

  const normalized = stripVTControlCharacters(trimmed).trim()
  if (normalized !== trimmed) {
    const normalizedEvent = parseEvent(normalized)
    if (normalizedEvent) return { kind: 'event', event: normalizedEvent, normalized: true }
  }

  return { kind: 'discarded', characters: line.length }
}

export class JsonEventRepairTracker {
  #discardedLineCount = 0
  #discardedCharacterCount = 0
  #normalizedLineCount = 0
  #maxDiscardedLines
  #maxDiscardedCharacters

  constructor(options = {}) {
    this.#maxDiscardedLines = options.maxDiscardedLines ?? DEFAULT_MAX_DISCARDED_LINES
    this.#maxDiscardedCharacters = options.maxDiscardedCharacters ?? DEFAULT_MAX_DISCARDED_CHARACTERS
  }

  decode(line, options = {}) {
    const decoded = decodeJsonEventLine(line)
    if (decoded.kind === 'blank') return null
    if (decoded.kind === 'event') {
      if (decoded.normalized) {
        if (options.allowRepair !== true) {
          throw new SyntaxError('The provider stream contains a normalized rather than exact JSON event line.')
        }
        this.#normalizedLineCount += 1
      }
      return decoded.event
    }
    if (options.allowRepair !== true) {
      throw new SyntaxError('The provider stream contains a non-JSON event line.')
    }

    this.#discardedLineCount += 1
    this.#discardedCharacterCount += decoded.characters
    if (
      this.#discardedLineCount > this.#maxDiscardedLines
      || this.#discardedCharacterCount > this.#maxDiscardedCharacters
    ) {
      throw new SyntaxError('The provider stream exceeded Ensync Host\'s bounded JSON-event repair limit.')
    }
    return null
  }

  get recovery() {
    if (this.#discardedLineCount === 0 && this.#normalizedLineCount === 0) return null
    return {
      applied: true,
      normalizedLineCount: this.#normalizedLineCount,
      discardedLineCount: this.#discardedLineCount,
    }
  }
}

export function decodeJsonEventStream(value, options = {}) {
  if (typeof value !== 'string') throw new SyntaxError('The provider stream is not text.')
  const tracker = new JsonEventRepairTracker(options)
  const events = []
  for (const line of value.split('\n')) {
    const event = tracker.decode(line, { allowRepair: options.allowRepair === true })
    if (event) events.push(event)
  }
  return { events, recovery: tracker.recovery }
}
