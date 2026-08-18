import { normalizeFileAttachments, visibleMessageText } from './fileAttachments.mjs'

/**
 * The exact instruction a failed turn would be re-sent with, or null when the
 * conversation does not end in a failed turn. Only the last turn qualifies: an
 * older failure already has work after it, and re-running it would act on a
 * project the conversation has since moved past.
 *
 * Re-sending is always a new turn. The failed attempt stays in the transcript,
 * where the run prompt already marks it context-only, so nothing is replayed
 * behind the person's back and no retained job ID is ever reused.
 */
export function retryableFailedTurn(messages) {
  const last = Array.isArray(messages) ? messages.at(-1) : null
  if (!last || last.role !== 'user' || last.deliveryStatus !== 'failed') return null
  const attachments = normalizeFileAttachments(last.attachments)
  const content = typeof last.content === 'string' ? last.content : ''
  // An attachment-only turn stores rendered placeholder copy, never a prompt.
  const prompt = attachments.length > 0 && content === visibleMessageText('', attachments)
    ? ''
    : content.trim()
  if (!prompt && attachments.length === 0) return null
  return { messageId: last.id, prompt, attachments }
}
