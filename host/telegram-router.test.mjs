import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatRunError } from './chat.mjs'
import { TelegramChatRouter } from './telegram-router.mjs'

function approvedRequest(overrides = {}) {
  return {
    source: 'telegram',
    connectionId: 'connection-1',
    approvalId: 'approval-1',
    approvalScope: 'task_start_only',
    toolApprovalMode: 'host_required',
    projectId: 'project-1',
    projectPath: '/verified/project',
    conversationId: 'conversation-1',
    provider: 'claude',
    prompt: 'Continue the task.',
    ...overrides,
  }
}

test('Telegram router requires the narrow task-start approval contract', async () => {
  const router = new TelegramChatRouter({
    chatService: { run: async () => ({ response: 'should not run' }) },
    statusService: { list: async () => [] },
  })
  await assert.rejects(
    router.run(approvedRequest({ toolApprovalMode: 'auto_approve' })),
    (error) => error instanceof ChatRunError && error.code === 'telegram_approval_required',
  )
})

test('Telegram router falls back only after a retry-safe pre-activity failure and carries context', async () => {
  const calls = []
  const router = new TelegramChatRouter({
    chatService: {
      run: async (request) => {
        calls.push(request)
        if (request.provider === 'claude') {
          throw new ChatRunError('provider_quota', 'Quota exhausted.', 429, true)
        }
        return {
          provider: 'codex',
          response: calls.length === 2 ? 'Fallback answer' : 'Follow-up answer',
          sessionId: '12345678-1234-1234-9234-123456789abc',
        }
      },
    },
    statusService: {
      list: async () => [{ id: 'codex', connectionState: 'ready', chatExecution: 'supported' }],
    },
  })

  const first = await router.run(approvedRequest())
  assert.equal(first.provider, 'codex')
  assert.deepEqual(calls.map((call) => call.provider), ['claude', 'codex'])

  await router.run(approvedRequest({ provider: 'codex', prompt: 'What changed?' }))
  assert.equal(calls[2].provider, 'codex')
  assert.equal(calls[2].sessionId, '12345678-1234-1234-9234-123456789abc')
  assert.equal(calls[2].prompt, 'What changed?')
})

test('Telegram router does not retry an unsafe provider failure', async () => {
  let calls = 0
  const failure = new ChatRunError('cli_failed', 'Tool activity may have occurred.', 502, false)
  const router = new TelegramChatRouter({
    chatService: { run: async () => { calls += 1; throw failure } },
    statusService: { list: async () => { throw new Error('must not inspect fallbacks') } },
  })
  await assert.rejects(router.run(approvedRequest()), failure)
  assert.equal(calls, 1)
})

test('Telegram router keeps an approved SSH task on the verified remote runtime', async () => {
  const calls = []
  const quotaError = new Error('Remote quota exhausted.')
  quotaError.safeToRetry = true
  const connection = {
    hostname: 'worker.example.com',
    username: 'developer',
    port: 22,
    identityFile: null,
    projectPath: '/srv/project',
  }
  const router = new TelegramChatRouter({
    chatService: { run: async () => { throw new Error('local runner must not be used') } },
    statusService: { list: async () => { throw new Error('local statuses must not be used') } },
    remoteSshService: {
      runChat: async (request) => {
        calls.push(request)
        if (request.provider === 'claude') throw quotaError
        return { provider: 'codex', response: 'Remote fallback answer', sessionId: null }
      },
      probe: async (input) => {
        assert.deepEqual(input, connection)
        return {
          providers: [{
            id: 'codex',
            directlyRunnable: true,
            authentication: { state: 'authenticated', method: 'ChatGPT login' },
          }],
        }
      },
    },
  })

  const result = await router.run(approvedRequest({
    executionTarget: { kind: 'ssh', connection },
  }))
  assert.equal(result.response, 'Remote fallback answer')
  assert.deepEqual(calls.map((call) => call.provider), ['claude', 'codex'])
  assert.deepEqual(calls[1].connection, connection)
})
