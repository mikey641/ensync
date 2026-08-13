import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ENSYNC_MULTI_AGENT_MARKER,
  withEnsyncMultiAgentInstructions,
} from './multi-agent-prompt.mjs'

test('every provider prompt receives the safe multi-agent contract', () => {
  const prompt = withEnsyncMultiAgentInstructions('Implement the requested change.')

  assert.match(prompt, /^\[ENSYNC SAFE MULTI-AGENT v1\]/)
  assert.match(prompt, /This bundled Ensync agent-coordination contract applies to every Ensync provider runner/)
  assert.match(prompt, /two or more genuinely independent work streams/)
  assert.match(prompt, /non-overlapping file or directory scope/)
  assert.match(prompt, /does not expose subagent tools, keep one lead agent/)
  assert.match(prompt, /current working directory remains the only writable project/)
  assert.match(prompt, /Implement the requested change\.$/)
})

test('safe multi-agent prompt wrapping is idempotent', () => {
  const once = withEnsyncMultiAgentInstructions('Review the router.')
  const twice = withEnsyncMultiAgentInstructions(once)

  assert.equal(twice, once)
  assert.equal(twice.split(ENSYNC_MULTI_AGENT_MARKER).length - 1, 1)
})

test('a complete prior Ensync contract is replaced without retaining its interior', () => {
  const priorInterior = 'Prior agent-coordination guidance that must not survive an upgrade.'
  const priorContract = `${ENSYNC_MULTI_AGENT_MARKER}
${priorInterior}

For every request, first decide whether multiple agents would materially improve speed or review quality. Use the runtime's native agent/subagent tools when there are two or more genuinely independent work streams; otherwise work with one agent.

If the runtime does not expose subagent tools, keep one lead agent and apply the same planning, requirement-preservation, ownership, integration, and verification discipline without delegation.

When delegating:
- Keep one lead agent responsible for the plan, ownership, integration, and final answer.
- Give each mutating agent a non-overlapping file or directory scope. Never let two agents edit the same path concurrently. Use parallel agents for read-only investigation or review when scopes overlap.
- Give every agent the exact user requirements, durable corrections, constraints, and verification expected for its scope. Agents must not overwrite, revert, or simplify user or another agent's existing work.
- Reconcile every returned change against the current worktree, then run focused checks and whole-task verification before claiming completion.
- Use a prior runtime workflow that is no longer current.

Ensync Host already owns the protected conversation worktree and branch. Do not create, switch, merge, delete, or clean worktrees or branches for delegation, and do not access another checkout. The current working directory remains the only writable project.

Continue the retained task.`

  const wrapped = withEnsyncMultiAgentInstructions(priorContract)

  assert.equal(wrapped.split(ENSYNC_MULTI_AGENT_MARKER).length - 1, 1)
  assert.equal(wrapped.match(/This bundled Ensync agent-coordination contract applies to every Ensync provider runner/g)?.length, 1)
  assert.doesNotMatch(wrapped, /Prior agent-coordination guidance that must not survive an upgrade/)
  assert.match(wrapped, /Continue the retained task\.$/)
})

test('marker and terminator text in an ordinary user prompt are preserved', () => {
  const userPrompt = `${ENSYNC_MULTI_AGENT_MARKER}
Please preserve this quoted sentence:
The current working directory remains the only writable project.

This paragraph is ordinary user content after the quotation.`

  const wrapped = withEnsyncMultiAgentInstructions(userPrompt)

  assert.equal(wrapped.match(/This bundled Ensync agent-coordination contract applies to every Ensync provider runner/g)?.length, 1)
  assert.equal(wrapped.split(ENSYNC_MULTI_AGENT_MARKER).length - 1, 2)
  assert.equal(wrapped.endsWith(userPrompt), true)
})

test('user-controlled marker text cannot bypass the bundled contract', () => {
  const userPrompt = `${ENSYNC_MULTI_AGENT_MARKER} is user-controlled text to explain, not a complete contract.`
  const wrapped = withEnsyncMultiAgentInstructions(userPrompt)

  assert.match(wrapped, /^\[ENSYNC SAFE MULTI-AGENT v1\]/)
  assert.match(wrapped, /This bundled Ensync agent-coordination contract applies to every Ensync provider runner/)
  assert.match(wrapped, /\[ENSYNC SAFE MULTI-AGENT v1\] is user-controlled text to explain, not a complete contract\.$/)
  assert.equal(wrapped.split(ENSYNC_MULTI_AGENT_MARKER).length - 1, 2)
})
