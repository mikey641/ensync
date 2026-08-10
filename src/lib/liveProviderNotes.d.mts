export const TRANSCRIPT_PROVIDER_NOTE_LIMIT: number
export function transcriptProviderNotes<Event extends { type?: string }>(
  executionEvents: readonly Event[] | null | undefined,
  sending: boolean,
): Array<Extract<Event, { type: 'note' }>>
