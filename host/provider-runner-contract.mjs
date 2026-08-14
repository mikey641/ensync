import {
  ENSYNC_AGENT_COORDINATION_POLICY,
  withEnsyncMultiAgentInstructions,
} from './multi-agent-prompt.mjs'

const providerRunners = Object.freeze({
  local: Object.freeze([
    Object.freeze({ id: 'codex', coordinationPolicy: ENSYNC_AGENT_COORDINATION_POLICY }),
    Object.freeze({ id: 'claude', coordinationPolicy: ENSYNC_AGENT_COORDINATION_POLICY }),
    Object.freeze({ id: 'droid', coordinationPolicy: ENSYNC_AGENT_COORDINATION_POLICY }),
    Object.freeze({ id: 'cursor', coordinationPolicy: ENSYNC_AGENT_COORDINATION_POLICY }),
  ]),
  // Droid has no ssh runner: remote-ssh.mjs drives plain argv+stdin CLIs, while
  // droid needs its stream-jsonrpc session adapter. Listing it here before that
  // bridge exists would let Auto routing dispatch runs that can only fail.
  //
  // Cursor has no ssh runner either, for a different reason: its containment is
  // the argv-pinned `--sandbox enabled` flag that host/cursor-agent.mjs adds, and
  // the ssh bridge builds its own argv without those flags. Listing it here would
  // ship a remote Cursor run with no recorded containment at all.
  ssh: Object.freeze([
    Object.freeze({ id: 'codex', coordinationPolicy: ENSYNC_AGENT_COORDINATION_POLICY }),
    Object.freeze({ id: 'claude', coordinationPolicy: ENSYNC_AGENT_COORDINATION_POLICY }),
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
  if (runner.coordinationPolicy !== ENSYNC_AGENT_COORDINATION_POLICY) {
    throw new TypeError(`${providerId} does not implement Ensync's required agent-coordination policy.`)
  }
  return withEnsyncMultiAgentInstructions(prompt)
}
