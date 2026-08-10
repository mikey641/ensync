export type MessageContentBlock =
  | { type: 'text'; text: string }
  | { type: 'code'; code: string; language: string | null }
  | { type: 'image'; alt: string; path: string; markdown: string }

export type MessageTextPart =
  | { type: 'text'; text: string }
  | { type: 'link'; text: string; href: string }

export type MessageInlineLink =
  | { type: 'link'; label: string; kind: 'external'; href: string }
  | { type: 'link'; label: string; kind: 'file'; href: string; path: string }

export type MessageInlineSegment =
  | { type: 'text'; text: string }
  | MessageInlineLink

export function parseMessageContent(value: unknown): MessageContentBlock[]
export function parseInlineSegments(value: unknown): MessageInlineSegment[]
