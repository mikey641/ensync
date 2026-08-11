/**
 * A detached chat job keeps running in the Host while nothing is reading its
 * stream, so losing the reader is only ever a transport problem. Reattach
 * whenever the Host proved the request never landed, or when the failure names
 * no specific fault; refuse when it named one, so a real refusal is reported
 * instead of being retried forever.
 */
export function canReattachChatJob(error) {
  if (!error) return true
  if (error.safeToRetry === true) return true
  if (error.code === 'chat_job_stream_disconnected') return true
  return error.code === null && Number(error.status) >= 500
}
