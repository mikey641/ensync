export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'code'; code: string; language: string | null }

export function parseMessageContent(value: unknown): MessageContentBlock[]
