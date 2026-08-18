export function canReattachChatJob(error: {
  code: string | null
  status: number
  safeToRetry: boolean
  /** True when the job itself delivered this outcome, so the job already ended. */
  terminal?: boolean
} | null | undefined): boolean
