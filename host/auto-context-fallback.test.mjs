import assert from 'node:assert/strict'
import test from 'node:test'
import {
  AUTO_CONTEXT_PROMPT_LIMIT,
  buildAutoContextPrompt,
} from '../src/lib/autoContextPrompt.mjs'
import { selectAutomaticProvider } from '../src/lib/automaticRouting.mjs'
import { appendFallbackReason, safeFallbackProof } from '../src/lib/safeFallback.mjs'

function project() {
  return {
    name: 'Ensync',
    path: '/Users/test/dev/ensync',
    context: {
      files: ['.relay/project.md', '.relay/architecture.md', '.relay/features/agent-routing.md'],
      featureFiles: ['.relay/features/agent-routing.md'],
      instructionAdapters: [{ file: 'AGENTS.md' }, { file: 'CLAUDE.md' }],
    },
  }
}

function chat() {
  return {
    messages: [
      { role: 'user', content: 'Keep the existing branch.' },
      { role: 'agent', provider: 'codex', content: 'I inspected the router.' },
    ],
    continuation: { status: 'completed', provider: 'codex' },
  }
}

function gitStatus() {
  return {
    branch: 'feature/fallback',
    dirty: true,
    changedFiles: 3,
    upstream: 'origin/feature/fallback',
    checkedAt: '2026-08-06T12:00:00.000Z',
  }
}

test('fallback capsule preserves focused local project, transcript, relevant files, and verified Git state', () => {
  const prompt = buildAutoContextPrompt({
    project: project(),
    target: { kind: 'local' },
    chat: chat(),
    prompt: 'Finish the safe quota fallback.',
    includeTranscript: true,
    gitStatus: gitStatus(),
    gitStatusReason: '',
    providerMode: 'auto',
  })

  assert.match(prompt, /Focused project: Ensync at \/Users\/test\/dev\/ensync/)
  assert.match(prompt, /Execution target: Local Ensync Host \(\/Users\/test\/dev\/ensync\)/)
  assert.match(prompt, /Relevant feature files: \.relay\/features\/agent-routing\.md/)
  assert.match(prompt, /Verified instruction adapters: AGENTS\.md, CLAUDE\.md/)
  assert.match(prompt, /Verified Git state: feature\/fallback; 3 changed files; upstream origin\/feature\/fallback/)
  assert.match(prompt, /User: Keep the existing branch\./)
  assert.match(prompt, /Agent \(codex\): I inspected the router\./)
  assert.match(prompt, /Current user request:\nFinish the safe quota fallback\./)
  assert.match(prompt, /^\[ENSYNC SAFE MULTI-AGENT v1\]/)
})

test('fallback capsule pins an SSH handoff to the verified canonical remote project', () => {
  const prompt = buildAutoContextPrompt({
    project: project(),
    target: {
      kind: 'ssh',
      connection: {
        username: 'developer',
        hostname: 'worker.example.com',
        port: 2222,
        projectPath: '/srv/alias/ensync',
      },
      probe: { project: { canonicalPath: '/srv/projects/ensync' } },
    },
    chat: chat(),
    prompt: 'Continue remotely.',
    includeTranscript: true,
    gitStatus: null,
    gitStatusReason: 'remote branch/worktree status was not exposed by the verified probe',
    providerMode: 'auto',
  })

  assert.match(prompt, /Focused project: Ensync at \/srv\/projects\/ensync/)
  assert.match(prompt, /Execution target: SSH worker developer@worker\.example\.com:2222 \(\/srv\/projects\/ensync\)/)
  assert.doesNotMatch(prompt, /Focused project: Ensync at \/Users\/test/)
  assert.match(prompt, /Do not change execution targets during this turn\./)
  assert.match(prompt, /Verified Git state: unavailable \(remote branch\/worktree status was not exposed/)
})

test('fallback capsule budgets the always-on multi-agent contract inside the Host prompt limit', () => {
  const oversizedChat = chat()
  oversizedChat.messages = [
    { role: 'user', content: 'old context '.repeat(20_000) },
  ]
  const prompt = buildAutoContextPrompt({
    project: project(),
    target: { kind: 'local' },
    chat: oversizedChat,
    prompt: 'Keep the current requirement.',
    includeTranscript: true,
    gitStatus: gitStatus(),
    gitStatusReason: '',
    providerMode: 'auto',
  })

  assert.ok(prompt.length <= AUTO_CONTEXT_PROMPT_LIMIT)
  assert.match(prompt, /characters from the oldest conversation turns were omitted/)
  assert.match(prompt, /Current user request:\nKeep the current requirement\./)
})

test('UI fallback accepts only explicit Host safe proofs and keeps saved ranking', () => {
  assert.deepEqual(safeFallbackProof({ code: 'provider_quota', safeToRetry: true }), {
    kind: 'quota',
    code: 'provider_quota',
  })
  assert.deepEqual(safeFallbackProof({ code: 'provider_not_authenticated', safeToRetry: true }), {
    kind: 'preflight',
    code: 'provider_not_authenticated',
  })
  assert.deepEqual(safeFallbackProof({ code: 'provider_startup_failed', safeToRetry: true }), {
    kind: 'preflight',
    code: 'provider_startup_failed',
  })
  for (const code of ['run_timed_out', 'invalid_cli_output', 'empty_cli_response', 'cli_failed']) {
    assert.equal(safeFallbackProof({ code, safeToRetry: true }), null)
  }
  assert.equal(safeFallbackProof({ code: 'provider_quota', safeToRetry: false }), null)
  assert.equal(safeFallbackProof({ safeToRetry: true }), null)

  const providers = [
    { id: 'claude', connected: true, chatExecution: 'supported', usage: 20 },
    { id: 'codex', connected: true, chatExecution: 'supported', usage: null },
  ]
  const destination = selectAutomaticProvider(providers, ['codex', 'claude'], ['codex'])
  assert.equal(destination?.id, 'claude')
  assert.equal(
    appendFallbackReason(null, 'Codex quota proof accepted.'),
    'Codex quota proof accepted.',
  )
  assert.equal(
    appendFallbackReason('Codex quota proof accepted.', 'Claude preflight failed.'),
    'Codex quota proof accepted. -> Claude preflight failed.',
  )
})
