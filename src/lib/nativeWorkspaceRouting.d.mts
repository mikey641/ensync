import type { NativeWorkspaceIdentity } from './nativeWorkspaceIdentity.mjs'

type StorageReader = Pick<Storage, 'getItem'>

export function nativeProjectPathKey(value: unknown): string
export function workspaceProjectHistoryScore(state: unknown, project: { id?: string; path?: string }): number
export function findRetainedWorkspaceForProject(storage: StorageReader, options: {
  currentWorkspace: NativeWorkspaceIdentity
  retainedWorkspaces: NativeWorkspaceIdentity[]
  project: { id?: string; path?: string }
}): {
  workspace: { id: string; kind: NativeWorkspaceIdentity['kind'] }
  projectId: string
  projectPath: string
  score: number
  revision: number
  committedAt: string
} | null

export type NativeExactChatTarget = {
  workspaceId: string
  projectId: string
  projectPath: string
  chatId: string
}

export type ReferencedOwningConversation = NativeExactChatTarget & {
  projectName: string
  chatTitle: string
  branch: string
}

export function findReferencedOwningConversation(storage: StorageReader, options: {
  currentWorkspace: NativeWorkspaceIdentity
  retainedWorkspaces: NativeWorkspaceIdentity[]
  chat: unknown
}): ReferencedOwningConversation | null

export function exactNativeChatFocusCanApply(
  request: unknown,
  current: NativeExactChatTarget,
): boolean
