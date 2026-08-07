export type NativeRecentProject = { name: string; path: string; host: 'local' }
export function collectNativeRecentProjectCandidates(
  storage: Pick<Storage, 'length' | 'key' | 'getItem'>,
  identity?: { id: string | null; kind: 'canonical' | 'isolated' },
): NativeRecentProject[]
export function initializeNativeRecentProjects(target?: typeof globalThis): Promise<{
  status: 'ready' | 'unavailable'
  projects: NativeRecentProject[]
}>
export function getNativeRecentProjects(): NativeRecentProject[]
export function subscribeNativeRecentProjects(listener: (projects: NativeRecentProject[]) => void): () => void
export function rememberNativeRecentProject(project: NativeRecentProject, target?: typeof globalThis): Promise<NativeRecentProject[]>
