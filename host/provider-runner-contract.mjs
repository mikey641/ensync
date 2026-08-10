import {
  ENSYNC_SUPERPOWERS_POLICY,
  withEnsyncMultiAgentInstructions,
} from './multi-agent-prompt.mjs'

const providerRunners = Object.freeze({
  local: Object.freeze([
    Object.freeze({ id: 'codex', coordinationPolicy: ENSYNC_SUPERPOWERS_POLICY }),
    Object.freeze({ id: 'claude', coordinationPolicy: ENSYNC_SUPERPOWERS_POLICY }),
    Object.freeze({ id: 'droid', coordinationPolicy: ENSYNC_SUPERPOWERS_POLICY }),
  ]),
  // Droid has no ssh runner: remote-ssh.mjs drives plain argv+stdin CLIs, while
  // droid needs its stream-jsonrpc session adapter. Listing it here before that
  // bridge exists would let Auto routing dispatch runs that can only fail.
  ssh: Object.freeze([
    Object.freeze({ id: 'codex', coordinationPolicy: ENSYNC_SUPERPOWERS_POLICY }),
    Object.freeze({ id: 'claude', coordinationPolicy: ENSYNC_SUPERPOWERS_POLICY }),
  ]),
})

function topologyRunners(topology) {
  const runners = providerRunners[topology]
  if (!runners) throw new TypeError(`Unknown provider runner topology: ${topology}`)
  return runners
}

export function providerRunnerIds(topology) {
  return topologyRunners(topology).map((runner) => runner.id)
}

export function supportsProviderRunner(providerId, topology) {
  return topologyRunners(topology).some((runner) => runner.id === providerId)
}

export function supportsAnyProviderRunner(providerId) {
  return Object.keys(providerRunners).some((topology) => supportsProviderRunner(providerId, topology))
}

export function withProviderRunnerInstructions(providerId, topology, prompt) {
  const runner = topologyRunners(topology).find((candidate) => candidate.id === providerId)
  if (!runner) {
    throw new TypeError(`${providerId} does not have a tested ${topology} runner.`)
  }
  if (runner.coordinationPolicy !== ENSYNC_SUPERPOWERS_POLICY) {
    throw new TypeError(`${providerId} does not implement Ensync's required Superpowers policy.`)
  }
  return withEnsyncMultiAgentInstructions(prompt)
}
