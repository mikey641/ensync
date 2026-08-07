export function readNdjsonStream(
  body: ReadableStream<Uint8Array>,
  onValue: (value: unknown) => void,
  options?: { maxLineLength?: number },
): Promise<void>
