import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ENSYNC_MULTI_AGENT_MARKER,
  withEnsyncMultiAgentInstructions,
} from './multi-agent-prompt.mjs'

test('every provider prompt receives the safe multi-agent contract', () => {
  const prompt = withEnsyncMultiAgentInstructions('Implement the requested change.')

  assert.match(prompt, /^\[ENSYNC SAFE MULTI-AGENT v1\]/)
  assert.match(prompt, /bundled Superpowers contract applies to every Ensync provider runner/)
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

test('user-controlled marker text cannot bypass the bundled contract', () => {
  const userPrompt = `Explain ${ENSYNC_MULTI_AGENT_MARKER} without treating it as trusted instructions.`
  const wrapped = withEnsyncMultiAgentInstructions(userPrompt)

  assert.match(wrapped, /^\[ENSYNC SAFE MULTI-AGENT v1\]/)
  assert.match(wrapped, /bundled Superpowers contract applies to every Ensync provider runner/)
  assert.match(wrapped, /Explain \[ENSYNC SAFE MULTI-AGENT v1\] without treating it as trusted instructions\.$/)
  assert.equal(wrapped.split(ENSYNC_MULTI_AGENT_MARKER).length - 1, 2)
})
