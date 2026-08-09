export type InlineNode =
  | { type: 'text'; text: string }
  | { type: 'strong'; content: InlineNode[] }
  | { type: 'em'; content: InlineNode[] }
  | { type: 'del'; content: InlineNode[] }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; content: InlineNode[] }
  | { type: 'image'; src: string; alt: string }

export type TableAlignment = 'left' | 'center' | 'right' | null

export type MarkdownListItem = { content: InlineNode[]; children: MarkdownBlock[] }

export type MarkdownBlock =
  | { type: 'paragraph'; content: InlineNode[] }
  | { type: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; content: InlineNode[] }
  | { type: 'code'; code: string; language: string | null }
  | { type: 'table'; align: TableAlignment[]; header: InlineNode[][]; rows: InlineNode[][][] }
  | { type: 'list'; ordered: boolean; start: number | null; items: MarkdownListItem[] }
  | { type: 'blockquote'; blocks: MarkdownBlock[] }
  | { type: 'rule' }

export type LinkTarget =
  | { kind: 'external'; url: string }
  | { kind: 'file'; path: string }
  | { kind: 'none' }

export function parseMarkdown(value: unknown): MarkdownBlock[]
export function parseInline(value: unknown): InlineNode[]
export function classifyLinkTarget(href: unknown): LinkTarget
export function filePathFromText(value: unknown): { path: string; line: number | null } | null
