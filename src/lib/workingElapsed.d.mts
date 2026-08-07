export function workingElapsedSeconds(startedAt: string | null | undefined, nowMs?: number): number | null

export function workingElapsedLabel(options: {
  running: boolean
  startedAt: string | null | undefined
  nowMs?: number
}): string | null

export function nextWorkingElapsedDelay(startedAt: string, nowMs?: number): number
