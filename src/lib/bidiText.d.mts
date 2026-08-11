export type BidiDirection = 'ltr' | 'rtl'

export type BidiRun = { text: string; isolate: boolean }

export type BidiCursor = { split(value: unknown): BidiRun[] }

export function characterDirection(value: unknown): BidiDirection | null
export function createBidiCursor(): BidiCursor
