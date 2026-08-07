export type NativeProjectFolderResult =
  | { status: 'selected'; path: string }
  | { status: 'cancelled' }
  | { status: 'unavailable'; message: string }
  | { status: 'error'; message: string }

export function nativeProjectFolderPickerAvailable(target?: unknown): boolean
export function chooseNativeProjectFolder(target?: unknown): Promise<NativeProjectFolderResult>
