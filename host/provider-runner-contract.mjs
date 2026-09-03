const providerRunners = Object.freeze({
  local: Object.freeze(['codex', 'claude']),
  ssh: Object.freeze(['codex', 'claude']),
})

function topologyRunners(topology) {
  const runners = providerRunners[topology]
  if (!runners) throw new TypeError(`Unknown provider runner topology: ${topology}`)
  return runners
}

export function providerRunnerIds(topology) {
  return [...topologyRunners(topology)]
}

export function supportsProviderRunner(providerId, topology) {
  return topologyRunners(topology).includes(providerId)
}

export function supportsAnyProviderRunner(providerId) {
  return Object.keys(providerRunners).some((topology) => supportsProviderRunner(providerId, topology))
}
