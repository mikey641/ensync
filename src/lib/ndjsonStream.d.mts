export class MalformedNdjsonEventError extends SyntaxError {
  readonly code: 'malformed_ndjson_event'
}

export class TruncatedNdjsonStreamError extends SyntaxError {
  readonly code: 'truncated_ndjson_stream'
}

export function readNdjsonStream(
  body: ReadableStream<Uint8Array>,
  onValue: (value: unknown) => void,
  options?: { maxLineLength?: number },
): Promise<void>
