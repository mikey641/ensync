export function normalizeSyncServiceUrl(value: unknown): string | null
export function assertSyncServiceUrl(value: string | null | undefined): string | null
export function syncServiceUrlPreferenceAvailable(target?: typeof globalThis): boolean
export function readSyncServiceUrl(target?: typeof globalThis): Promise<string | null>
export function writeSyncServiceUrl(value: string, target?: typeof globalThis): Promise<string | null>
