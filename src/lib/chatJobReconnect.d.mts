export function canReattachChatJob(error: {
  code: string | null
  status: number
  safeToRetry: boolean
} | null | undefined): boolean
