/**
 * A detached chat job keeps running in the Host while nothing is reading its
 * stream, so losing the reader is only ever a transport problem. Reattach
 * whenever the Host proved the request never landed, or when the failure names
 * no specific fault; refuse when it named one, so a real refusal is reported
 * instead of being retried forever.
 *
 * A terminal outcome the job itself delivered is never a transport problem. The
 * Host marks a verified zero-activity failure (a provider quota or capacity
 * refusal) safeToRetry so the *task* may be re-sent, and reattaching such a
 * finished job only replays the same ending every 750 ms while the conversation
 * stays pinned to "Working". Terminal beats safeToRetry for that reason.
 */
export function canReattachChatJob(error) {
  if (!error) return true
  if (error.terminal === true) return false
  if (error.safeToRetry === true) return true
  if (error.code === 'chat_job_stream_disconnected') return true
  return error.code === null && Number(error.status) >= 500
}
