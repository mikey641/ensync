export type FileAttachment = {
  name: string
  path: string
}

export function normalizeFileAttachments(value: unknown): FileAttachment[]
export function appendFileAttachments(current: unknown, incoming: unknown): FileAttachment[]
export function fileDragContainsFiles(value:
  | ArrayLike<string>
  | Iterable<string>
  | Pick<DataTransfer, 'types' | 'items' | 'files'>
  | null
  | undefined
): boolean
export type ChatAttachmentHostOps = {
  probeAttachmentPaths(paths: string[]): Promise<{ results: { path: string; readable: boolean }[] }>
  storeChatAttachment(name: string, bytes: ArrayBuffer): Promise<{ attachment: { path: string; name: string } }>
}
export function resolveDroppedAttachments(
  files: ArrayLike<File> | Iterable<File> | null | undefined,
  pathForFile?: ((file: File) => string) | null,
  hostOps?: ChatAttachmentHostOps | null,
): Promise<{ attachments: FileAttachment[]; unavailable: string[] }>
export function messageTextWithAttachments(message: unknown, attachments: unknown): string
export function visibleMessageText(message: unknown, attachments: unknown): string
