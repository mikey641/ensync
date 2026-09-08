export type UpdateStateType =
  | 'uninitialized'
  | 'idle'
  | 'disabled'
  | 'checking for updates'
  | 'available for download'
  | 'downloading'
  | 'downloaded'
  | 'updating'
  | 'ready'
  | 'overwriting'
  | 'cancelling'
  | 'restarting'

export type UpdateDisablementReason =
  | 'not built'
  | 'disabled by environment'
  | 'manually disabled'
  | 'missing configuration'
  | 'invalid configuration'
  | 'unsupported platform'
  | 'store managed'
  | 'unsigned build'

/** VS Code's `IUpdate`, plus the two fields Ensync's manifest adds. */
export type Update = {
  version: string
  productVersion?: string
  timestamp?: number
  url?: string
  sha256hash?: string
  notesUrl?: string | null
  installActionLabel?: string | null
}

export type UpdateState =
  | { type: 'uninitialized' }
  | { type: 'disabled'; reason: UpdateDisablementReason }
  | { type: 'idle'; updateType: string; error?: string; notAvailable?: boolean }
  | { type: 'checking for updates'; explicit: boolean }
  | { type: 'available for download'; update: Update; canInstall?: boolean }
  | {
    type: 'downloading'
    update?: Update
    explicit: boolean
    overwrite: boolean
    downloadedBytes?: number
    totalBytes?: number
    startTime?: number
  }
  | { type: 'downloaded'; update: Update; explicit: boolean; overwrite: boolean }
  | { type: 'updating'; update: Update; explicit: boolean; currentProgress?: number; maxProgress?: number }
  | { type: 'ready'; update: Update; explicit: boolean; overwrite: boolean }
  | { type: 'overwriting'; update: Update; explicit: boolean }
  | { type: 'cancelling' }
  | { type: 'restarting'; update: Update }

export type UpdateChannel = 'stable' | 'beta'
export type UpdateMode = 'none' | 'manual' | 'start' | 'default'

export type NativeUpdateSnapshot = {
  state: UpdateState
  installedVersion: string | null
  installedBuildId: string | null
  channel: UpdateChannel
  mode: UpdateMode
  updateType: string
  availableVersion: string | null
  checkedAt: string | null
  notice: string | null
  releaseNotesUrl: string | null
  installActionLabel: string | null
}

export type UpdateProgress = { transferred: number; total: number | null; percent: number | null }

export const StateType: {
  readonly Uninitialized: 'uninitialized'
  readonly Idle: 'idle'
  readonly Disabled: 'disabled'
  readonly CheckingForUpdates: 'checking for updates'
  readonly AvailableForDownload: 'available for download'
  readonly Downloading: 'downloading'
  readonly Downloaded: 'downloaded'
  readonly Updating: 'updating'
  readonly Ready: 'ready'
  readonly Overwriting: 'overwriting'
  readonly Cancelling: 'cancelling'
  readonly Restarting: 'restarting'
}

export const DisablementReason: {
  readonly NotBuilt: 'not built'
  readonly DisabledByEnvironment: 'disabled by environment'
  readonly ManuallyDisabled: 'manually disabled'
  readonly MissingConfiguration: 'missing configuration'
  readonly InvalidConfiguration: 'invalid configuration'
  readonly UnsupportedPlatform: 'unsupported platform'
  readonly StoreManaged: 'store managed'
  readonly UnsignedBuild: 'unsigned build'
}
export const UPDATE_MODES: ReadonlyArray<{ value: UpdateMode; label: string; description: string }>

export function browserUpdateSnapshot(): NativeUpdateSnapshot
export function getNativeUpdateState(target?: unknown): Promise<NativeUpdateSnapshot>
export function checkForNativeUpdates(target?: unknown): Promise<NativeUpdateSnapshot>
export function downloadNativeUpdate(target?: unknown): Promise<NativeUpdateSnapshot>
export function cancelNativeUpdateDownload(target?: unknown): Promise<NativeUpdateSnapshot>
export function applyNativeUpdate(target?: unknown): Promise<NativeUpdateSnapshot>
export function setNativeUpdateChannel(channel: UpdateChannel, target?: unknown): Promise<NativeUpdateSnapshot>
export function setNativeUpdateMode(mode: UpdateMode, target?: unknown): Promise<NativeUpdateSnapshot>
export function subscribeToNativeUpdateState(
  callback: (snapshot: NativeUpdateSnapshot) => void,
  target?: unknown,
): () => void

export function canCheckForUpdates(snapshot: NativeUpdateSnapshot): boolean
export function canDownloadUpdate(snapshot: NativeUpdateSnapshot): boolean
export function canCancelUpdateDownload(snapshot: NativeUpdateSnapshot): boolean
export function canApplyUpdate(snapshot: NativeUpdateSnapshot): boolean
export function canChangeUpdateSettings(snapshot: NativeUpdateSnapshot): boolean
export function isUpdateBusy(snapshot: NativeUpdateSnapshot): boolean
export function updateStatusLabel(snapshot: NativeUpdateSnapshot): string
export function updateMessage(snapshot: NativeUpdateSnapshot): string
export function updateProgress(snapshot: NativeUpdateSnapshot): UpdateProgress | null
