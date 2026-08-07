export type SafeFallbackProof = {
  kind: 'quota' | 'preflight'
  code: string
}

export function safeFallbackProof(error: unknown): SafeFallbackProof | null
export function appendFallbackReason(previous: string | null, next: string): string | null
