export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'code'; code: string; language: string | null }

export type MessageTextPart =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; href: string }

export function parseMessageContent(value: unknown): MessageContentBlock[]
export function parseMessageText(value: unknown): MessageTextPart[]
