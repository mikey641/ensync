export type MessageTableAlignment = 'left' | 'center' | 'right' | null

export type MessageContentBlock =
  | { type: 'paragraph'; text: string }
  | { type: 'heading'; level: number; text: string }
  | { type: 'code'; code: string; language: string | null }
  | { type: 'table'; header: string[]; alignments: MessageTableAlignment[]; rows: string[][] }
  | { type: 'list'; ordered: boolean; start: number | null; items: MessageContentBlock[][] }
  | { type: 'quote'; blocks: MessageContentBlock[] }
  | { type: 'rule' }

export type MessageInlineNode =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; children: MessageInlineNode[] }
  | { type: 'strong'; children: MessageInlineNode[] }
  | { type: 'em'; children: MessageInlineNode[] }
  | { type: 'strike'; children: MessageInlineNode[] }

export type MessageInlineLink =
  | { type: 'link'; kind: 'external'; label: string; href: string }
  | { type: 'link'; kind: 'file'; label: string; href: string; path: string }

export type MessageInlineSegment =
  | { type: 'text'; text: string }
  | MessageInlineLink

export function isLongMessageContent(value: unknown): boolean
export function parseMessageContent(value: unknown): MessageContentBlock[]
export function parseInline(value: unknown): MessageInlineNode[]
export function parseInlineSegments(value: unknown): MessageInlineSegment[]
