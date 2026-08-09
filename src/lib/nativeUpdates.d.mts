export type NativeUpdatePhase =
  | 'initializing'
  | 'unavailable'
  | 'idle'
  | 'checking'
  | 'up_to_date'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'installer_opened'
  | 'error'

export type NativeUpdateState = {
  installedVersion: string | null
  installedBuildId: string | null
  installedBuildChannel: 'dev' | 'beta' | 'stable' | null
  installedSourceCommit: string | null
  installedSourceDirty: boolean | null
  installedBuiltAt: string | null
  channel: 'stable' | 'beta'
  phase: NativeUpdatePhase
  message: string
  availableVersion: string | null
  checkedAt: string | null
  releaseNotesUrl: string | null
  progress: { transferred: number; total: number | null; percent: number | null } | null
  canCheck: boolean
  canDownload: boolean
  canCancel: boolean
  canInstall: boolean
  canChangeChannel: boolean
  installActionLabel: string | null
}

export function browserUpdateState(): NativeUpdateState
export function getNativeUpdateState(target?: unknown): Promise<NativeUpdateState>
export function checkForNativeUpdates(target?: unknown): Promise<NativeUpdateState>
export function downloadNativeUpdate(target?: unknown): Promise<NativeUpdateState>
export function cancelNativeUpdateDownload(target?: unknown): Promise<NativeUpdateState>
export function openNativeUpdateInstaller(target?: unknown): Promise<NativeUpdateState>
export function setNativeUpdateChannel(
  channel: 'stable' | 'beta',
  target?: unknown,
): Promise<NativeUpdateState>
export function subscribeToNativeUpdateState(
  callback: (state: NativeUpdateState) => void,
  target?: unknown,
): () => void
