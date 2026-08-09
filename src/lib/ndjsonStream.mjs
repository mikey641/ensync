export class MalformedNdjsonEventError extends SyntaxError {
  constructor() {
    super('The NDJSON stream contained malformed JSON.')
    this.name = 'MalformedNdjsonEventError'
    this.code = 'malformed_ndjson_event'
  }
}

export class TruncatedNdjsonStreamError extends SyntaxError {
  constructor() {
    super('The NDJSON stream ended during an event.')
    this.name = 'TruncatedNdjsonStreamError'
    this.code = 'truncated_ndjson_stream'
  }
}

export async function readNdjsonStream(body, onValue, options = {}) {
  if (!body || typeof body.getReader !== 'function') throw new TypeError('A readable response body is required.')
  if (typeof onValue !== 'function') throw new TypeError('An NDJSON value observer is required.')
  const maxLineLength = options.maxLineLength ?? 512 * 1024
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  const readLine = (line, finalUnterminated = false) => {
    if (!line.trim()) return
    let value
    try {
      value = JSON.parse(line)
    } catch {
      throw finalUnterminated
        ? new TruncatedNdjsonStreamError()
        : new MalformedNdjsonEventError()
    }
    onValue(value)
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      buffer += decoder.decode(value, { stream: !done })
      if (buffer.length > maxLineLength && !buffer.includes('\n')) {
        throw new RangeError('The NDJSON stream contained an oversized event.')
      }
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) readLine(line)
      if (done) break
    }
    if (buffer.trim()) readLine(buffer, true)
  } catch (error) {
    try {
      await reader.cancel(error)
    } catch {
      // Cancellation is best-effort after a parser or observer failure.
    }
    throw error
  }
}
