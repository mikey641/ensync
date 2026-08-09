export type MarkdownAlignment = 'left' | 'right' | 'center' | null

export type MarkdownInline =
  | { type: 'text'; text: string }
  | { type: 'code'; text: string }
  | { type: 'strong'; inline: MarkdownInline[] }
  | { type: 'emphasis'; inline: MarkdownInline[] }
  | { type: 'strike'; inline: MarkdownInline[] }
  | { type: 'link'; href: string; inline: MarkdownInline[] }

export type MarkdownBlock =
  | { type: 'paragraph'; inline: MarkdownInline[] }
  | { type: 'heading'; level: number; inline: MarkdownInline[] }
  | { type: 'rule' }
  | { type: 'quote'; blocks: MarkdownBlock[] }
  | { type: 'list'; ordered: boolean; start: number; items: MarkdownBlock[][] }
  | {
      type: 'table'
      align: MarkdownAlignment[]
      header: MarkdownInline[][]
      rows: MarkdownInline[][][]
    }

export function safeMarkdownHref(value: unknown): string | null
export function parseInline(value: unknown): MarkdownInline[]
export function parseMarkdown(value: unknown): MarkdownBlock[]
