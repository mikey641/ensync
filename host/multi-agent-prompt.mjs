export const ENSYNC_MULTI_AGENT_MARKER = '[ENSYNC SAFE MULTI-AGENT v1]'
export const ENSYNC_SUPERPOWERS_POLICY = 'ensync_superpowers_v1'

export const ENSYNC_MULTI_AGENT_INSTRUCTIONS = `${ENSYNC_MULTI_AGENT_MARKER}
This bundled Superpowers contract applies to every Ensync provider runner, locally and over SSH. An upstream provider plugin may enhance it, but is never required for the same safety rules to apply.

For every request, first decide whether multiple agents would materially improve speed or review quality. Use the runtime's native agent/subagent tools when there are two or more genuinely independent work streams; otherwise work with one agent.

If the runtime does not expose subagent tools, keep one lead agent and apply the same planning, requirement-preservation, ownership, integration, and verification discipline without delegation.

When delegating:
- Keep one lead agent responsible for the plan, ownership, integration, and final answer.
- Give each mutating agent a non-overlapping file or directory scope. Never let two agents edit the same path concurrently. Use parallel agents for read-only investigation or review when scopes overlap.
- Give every agent the exact user requirements, durable corrections, constraints, and verification expected for its scope. Agents must not overwrite, revert, or simplify user or another agent's existing work.
- Reconcile every returned change against the current worktree, then run focused checks and whole-task verification before claiming completion.
- Use Superpowers dispatching-parallel-agents or subagent-driven-development when those skills are available and applicable. Otherwise follow this bundled contract with the runtime's native collaboration tools.

Ensync Host already owns the protected conversation worktree and branch. Do not create, switch, merge, delete, or clean worktrees or branches for delegation, and do not access another checkout. The current working directory remains the only writable project.`

export function withEnsyncMultiAgentInstructions(prompt) {
  const body = typeof prompt === 'string' ? prompt.trim() : ''
  if (
    body === ENSYNC_MULTI_AGENT_INSTRUCTIONS
    || body.startsWith(`${ENSYNC_MULTI_AGENT_INSTRUCTIONS}\n\n`)
  ) return body
  return body
    ? `${ENSYNC_MULTI_AGENT_INSTRUCTIONS}\n\n${body}`
    : ENSYNC_MULTI_AGENT_INSTRUCTIONS
}
