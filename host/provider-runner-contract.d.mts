export type ProviderRunnerTopology = 'local' | 'ssh'
export function providerRunnerIds(topology: ProviderRunnerTopology): string[]
export function supportsProviderRunner(providerId: string, topology: ProviderRunnerTopology): boolean
export function supportsAnyProviderRunner(providerId: string): boolean
