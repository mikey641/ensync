export const AUTO_CONTEXT_PROMPT_LIMIT: number

export function buildAutoContextPrompt(input: {
  project: {
    name: string
    path: string
    context: {
      files: string[]
      featureFiles: string[]
      instructionAdapters: Array<{ file: string }>
    }
  }
  target:
    | { kind: 'local' }
    | {
        kind: 'ssh'
        connection: { username: string; hostname: string; port: number; projectPath: string }
        probe: { project: { canonicalPath: string | null } }
      }
  chat: {
    messages: Array<{
      role: 'user' | 'agent'
      deliveryStatus?: 'queued' | 'pending' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
      provider?: string
      content: string
    }>
    continuation?: unknown
  }
  prompt: string
  includeTranscript: boolean
  gitStatus: {
    branch: string | null
    dirty: boolean
    changedFiles: number
    upstream: string | null
    checkedAt: string
  } | null
  gitStatusReason: string
  providerMode?: 'auto' | 'fixed'
}): string
