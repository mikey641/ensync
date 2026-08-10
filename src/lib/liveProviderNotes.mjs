export const TRANSCRIPT_PROVIDER_NOTE_LIMIT = 6

/**
 * Provider notes are live transcript content only: once a run reaches any
 * terminal state the conversation ends on the final reply or terminal status,
 * while the CLI execution panel keeps the complete retained note history.
 */
export function transcriptProviderNotes(executionEvents, sending) {
  if (!sending || !Array.isArray(executionEvents)) return []
  return executionEvents
    .filter((event) => event && event.type === 'note')
    .slice(-TRANSCRIPT_PROVIDER_NOTE_LIMIT)
}
