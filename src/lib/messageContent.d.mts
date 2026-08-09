export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'code'; code: string; language: string | null }
  | { type: 'image'; alt: string; path: string; markdown: string }

export function parseMessageContent(value: unknown): MessageContentBlock[]
