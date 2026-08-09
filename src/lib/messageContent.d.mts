export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'code'; code: string; language: string | null }

export function isLongMessageContent(value: unknown): boolean
export function parseMessageContent(value: unknown): MessageContentBlock[]
