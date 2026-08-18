import type { FileAttachment } from './fileAttachments.d.mts'

export type RetryableFailedTurn = {
  messageId: string
  prompt: string
  attachments: FileAttachment[]
}

export function retryableFailedTurn(messages: unknown): RetryableFailedTurn | null
