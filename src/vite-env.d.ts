/// <reference types="vite/client" />

type NativeExactRunTarget = {
  workspaceId: string
  projectId: string
  projectPath: string
  chatId: string
  jobId: string
}

type NativeLegacyWorkspaceFocusTarget = {
  workspaceId: string
  projectId: string
  projectPath: string
  chatId?: never
  jobId?: never
}

type NativeLegacyProjectFocusRequest = {
  projectId: string
  projectPath: string
  workspaceId?: never
  chatId?: never
  jobId?: never
}

type NativeWorkspaceFocusRequest = NativeLegacyWorkspaceFocusTarget | NativeExactRunTarget
type NativeWorkspaceProjectFocusRequest = NativeLegacyProjectFocusRequest | NativeExactRunTarget

interface Window {
  ensyncDesktop?: {
    getPathForFile?: (file: File) => string
    chooseChatFiles?: () => Promise<
      | { status: 'selected'; files: Array<{ name: string; path: string }> }
      | { status: 'cancelled' }
      | { status: 'error'; message: string }
    >
    getWorkspaceIdentity?: () => Promise<{
      id: string
      kind: 'canonical' | 'isolated'
      retainedWorkspaceIds: string[]
      retainedWorkspaces: Array<{ id: string; kind: 'canonical' | 'isolated' }>
      projectLaunch?: {
        projectId: string
        projectPath: string
        sourceWorkspace: { id: string; kind: 'canonical' | 'isolated' }
      }
    } | null>
    publishActiveRuns?: (entries: NativeExactRunTarget[]) => Promise<boolean>
    matchesActiveRun?: (request: NativeExactRunTarget) => Promise<boolean>
    focusWorkspace?: (request: NativeWorkspaceFocusRequest) => Promise<boolean>
    handoffQueuedMessage?: (request: {
      handoffId: string
      target: NativeExactRunTarget
      entry: {
        id: string
        turnId: string
        messageId: string
        prompt: string
        attachments?: Array<{ name: string; path: string }>
        enqueuedAt: string
        predecessorTurnId: string | null
        resumeApprovedAt?: string | null
        preferences: {
          providerMode: 'auto' | 'fixed'
          provider: string
          sizeTier: string | null
          automaticFallback: boolean
          autoContextSkill: boolean
          fallbackProviderOrder: string[]
          executionTargetKey: string
          projectId: string
          projectPath: string
        }
      }
    }) => Promise<{ status: 'accepted' | 'rejected' | 'unavailable'; handoffId: string; messageId: string }>
    onQueuedMessageHandoff?: (callback: (request: {
      handoffId: string
      target: NativeExactRunTarget
      entry: {
        id: string
        turnId: string
        messageId: string
        prompt: string
        attachments?: Array<{ name: string; path: string }>
        enqueuedAt: string
        predecessorTurnId: string | null
        resumeApprovedAt?: string | null
        preferences: {
          providerMode: 'auto' | 'fixed'
          provider: string
          sizeTier: string | null
          automaticFallback: boolean
          autoContextSkill: boolean
          fallbackProviderOrder: string[]
          executionTargetKey: string
          projectId: string
          projectPath: string
        }
      }
    }) => { status: 'accepted' | 'duplicate' | 'rejected' } | Promise<{ status: 'accepted' | 'duplicate' | 'rejected' }>) => () => void
    openProjectWorkspace?: (request: {
      projectId: string
      projectPath: string
    }) => Promise<boolean>
    openPath?: (request: { path: string; projectPath?: string | null }) => Promise<{ ok: boolean; error?: string }>
    onWorkspaceProjectFocus?: (callback: (request: NativeWorkspaceProjectFocusRequest) => void) => () => void
    getWorkspaceRecoveryCandidate?: () => Promise<{ id: string; encoded: string } | null>
    getCodexConversationImport?: () => Promise<object | null>
    getRecentProjects?: () => Promise<{ projects: Array<{ name: string; path: string; host: 'local' }> } | null>
    migrateRecentProjects?: (projects: Array<{ name: string; path: string; host: 'local' }>) => Promise<{ projects: Array<{ name: string; path: string; host: 'local' }> } | null>
    rememberRecentProject?: (project: { name: string; path: string; host: 'local' }) => Promise<{ projects: Array<{ name: string; path: string; host: 'local' }> } | null>
    onRecentProjectsChanged?: (callback: (state: { projects: Array<{ name: string; path: string; host: 'local' }> }) => void) => () => void
    getDevicePreferences?: () => Promise<{
      completionNotifications: {
        mode: 'off' | 'ringtone' | 'speech'
        speechText: string
        voiceId: string | null
      } | null
    } | null>
    setCompletionNotificationPreferences?: (settings: {
      mode: 'off' | 'ringtone' | 'speech'
      speechText: string
      voiceId: string | null
    }) => Promise<{
      completionNotifications: {
        mode: 'off' | 'ringtone' | 'speech'
        speechText: string
        voiceId: string | null
      }
    } | null>
    openLocalFile?: (path: string) => void
  }
}
