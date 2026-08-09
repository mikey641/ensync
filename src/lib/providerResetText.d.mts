export type ProviderResetSchedule = {
  resetsIn?: string | null
  resetLabel?: string | null
  resetWindow?: string | null
}

export function providerResetText(
  provider: ProviderResetSchedule,
  timeZone?: string,
): string | null
