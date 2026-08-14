export const ENSYNC_MULTI_AGENT_MARKER = '[ENSYNC SAFE MULTI-AGENT v1]'
export const ENSYNC_AGENT_COORDINATION_POLICY = 'ensync_agent_coordination_v1'
const ENSYNC_MULTI_AGENT_TERMINATOR = 'The current working directory remains the only writable project.'
const ENSYNC_MULTI_AGENT_CORE_FINGERPRINT = `

For every request, first decide whether multiple agents would materially improve speed or review quality. Use the runtime's native agent/subagent tools when there are two or more genuinely independent work streams; otherwise work with one agent.

If the runtime does not expose subagent tools, keep one lead agent and apply the same planning, requirement-preservation, ownership, integration, and verification discipline without delegation.

When delegating:
- Keep one lead agent responsible for the plan, ownership, integration, and final answer.
- Give each mutating agent a non-overlapping file or directory scope. Never let two agents edit the same path concurrently. Use parallel agents for read-only investigation or review when scopes overlap.
- Give every agent the exact user requirements, durable corrections, constraints, and verification expected for its scope. Agents must not overwrite, revert, or simplify user or another agent's existing work.
- Reconcile every returned change against the current worktree, then run focused checks and whole-task verification before claiming completion.
`
const ENSYNC_MULTI_AGENT_HOST_BOUNDARY = `Ensync Host already owns the protected conversation worktree and branch. Do not create, switch, merge, delete, or clean worktrees or branches for delegation, and do not access another checkout. ${ENSYNC_MULTI_AGENT_TERMINATOR}`

export const ENSYNC_MULTI_AGENT_INSTRUCTIONS = `${ENSYNC_MULTI_AGENT_MARKER}
This bundled Ensync agent-coordination contract applies to every Ensync provider runner, locally and over SSH. An upstream provider plugin may enhance it, but is never required for the same safety rules to apply.

For every request, first decide whether multiple agents would materially improve speed or review quality. Use the runtime's native agent/subagent tools when there are two or more genuinely independent work streams; otherwise work with one agent.

If the runtime does not expose subagent tools, keep one lead agent and apply the same planning, requirement-preservation, ownership, integration, and verification discipline without delegation.

When delegating:
- Keep one lead agent responsible for the plan, ownership, integration, and final answer.
- Give each mutating agent a non-overlapping file or directory scope. Never let two agents edit the same path concurrently. Use parallel agents for read-only investigation or review when scopes overlap.
- Give every agent the exact user requirements, durable corrections, constraints, and verification expected for its scope. Agents must not overwrite, revert, or simplify user or another agent's existing work.
- Reconcile every returned change against the current worktree, then run focused checks and whole-task verification before claiming completion.
- Use the runtime's applicable parallel-agent or subagent-development workflow when available. Otherwise follow this bundled contract with the runtime's native collaboration tools.

Ensync Host already owns the protected conversation worktree and branch. Do not create, switch, merge, delete, or clean worktrees or branches for delegation, and do not access another checkout. The current working directory remains the only writable project.`

function completeLeadingEnsyncEnvelopeEnd(body) {
  const envelopeStart = ENSYNC_MULTI_AGENT_MARKER.length + 1
  if (!body.startsWith(`${ENSYNC_MULTI_AGENT_MARKER}\n`)) return -1
  const coreIndex = body.indexOf(ENSYNC_MULTI_AGENT_CORE_FINGERPRINT, envelopeStart)
  if (coreIndex === -1) return -1
  const openingParagraph = body.slice(envelopeStart, coreIndex)
  if (!openingParagraph || openingParagraph.includes('\n\n')) return -1
  const workflowStart = coreIndex + ENSYNC_MULTI_AGENT_CORE_FINGERPRINT.length
  const hostBoundary = `\n\n${ENSYNC_MULTI_AGENT_HOST_BOUNDARY}`
  const hostIndex = body.indexOf(hostBoundary, workflowStart)
  if (hostIndex === -1) return -1
  const workflowLines = body.slice(workflowStart, hostIndex).split('\n')
  if (workflowLines.length === 0 || workflowLines.some((line) => !line.startsWith('- '))) return -1
  return hostIndex + hostBoundary.length
}

export function withoutLeadingEnsyncMultiAgentInstructions(prompt) {
  const body = typeof prompt === 'string' ? prompt.trim() : ''
  const envelopeEnd = completeLeadingEnsyncEnvelopeEnd(body)
  if (envelopeEnd === -1) return body
  if (envelopeEnd === body.length) return ''
  if (!body.startsWith('\n\n', envelopeEnd)) return body
  return body.slice(envelopeEnd + 2).trim()
}

export function withEnsyncMultiAgentInstructions(prompt) {
  const body = withoutLeadingEnsyncMultiAgentInstructions(prompt)
  return body
    ? `${ENSYNC_MULTI_AGENT_INSTRUCTIONS}\n\n${body}`
    : ENSYNC_MULTI_AGENT_INSTRUCTIONS
}
