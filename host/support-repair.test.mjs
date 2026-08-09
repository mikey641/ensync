import assert from 'node:assert/strict'
import test from 'node:test'
import {
  compileSupportRepairPrompt,
  redactSupportInput,
  SupportRepairError,
  SupportRepairService,
  supportRepairErrorPayload,
} from './support-repair.mjs'

const VERIFIED_PROJECT = {
  id: 'local-verified-project',
  name: 'verified-project',
  path: '/verified/project',
  host: 'local',
  inspectedAt: '2026-08-06T08:00:00.000Z',
}

function validRequest(overrides = {}) {
  return {
    provider: 'codex',
    projectId: VERIFIED_PROJECT.id,
    projectPath: '/requested/project',
    workspaceKey: 'canonical-window:support-repair-1',
    prompt: 'Fix the conversation panel overflow and verify the focused test.',
    diagnostics: {
      summary: 'Long unbroken output escapes the message container.',
      details: 'Observed at 1440x900 after a completed local chat run.',
    },
    consent: {
      fixWithMySubscription: true,
      allowProjectEdits: true,
    },
    ...overrides,
  }
}

function completedRun(overrides = {}) {
  return {
    provider: 'codex',
    projectPath: VERIFIED_PROJECT.path,
    response: 'Updated the overflow styles. The focused test passed.',
    sessionId: '123e4567-e89b-12d3-a456-426614174000',
    model: 'gpt-5.4',
    requestedModel: null,
    usage: {
      source: 'cli',
      inputTokens: 51,
      outputTokens: 17,
      cachedInputTokens: 8,
    },
    durationMs: 412,
    completedAt: '2026-08-06T08:01:00.000Z',
    ...overrides,
  }
}

function serviceFixture(options = {}) {
  const calls = { inspections: [], runs: [] }
  const service = new SupportRepairService({
    projectService: options.projectService ?? {
      async inspect(path) {
        calls.inspections.push(path)
        return VERIFIED_PROJECT
      },
    },
    chatService: options.chatService ?? {
      async run(request) {
        calls.runs.push(request)
        return completedRun({ provider: request.provider })
      },
    },
  })
  return { service, calls }
}

test('repair requires explicit subscription/edit consent, prompt, diagnostics, and a supported provider', async () => {
  const { service, calls } = serviceFixture()
  const invalidRequests = [
    validRequest({ consent: { fixWithMySubscription: false, allowProjectEdits: true } }),
    validRequest({ prompt: '   ' }),
    validRequest({ diagnostics: null }),
    validRequest({ diagnostics: { summary: '' } }),
    validRequest({ provider: 'copilot' }),
  ]

  for (const request of invalidRequests) {
    await assert.rejects(
      service.run(request),
      (error) =>
        error instanceof SupportRepairError
        && error.safeToRetry === true
        && error.retry.automatic === false,
    )
  }
  assert.equal(calls.inspections.length, 0)
  assert.equal(calls.runs.length, 0)
})

test('repair re-inspects and binds the run to the exact canonical project identity', async () => {
  const { service, calls } = serviceFixture()
  const result = await service.run(validRequest({
    provider: 'claude',
    model: 'claude-opus-4-6',
    sessionId: '123e4567-e89b-12d3-a456-426614174000',
    timeoutMs: 30_000,
  }))

  assert.deepEqual(calls.inspections, ['/requested/project'])
  assert.equal(calls.runs.length, 1)
  const runRequest = calls.runs[0]
  assert.equal(runRequest.provider, 'claude')
  assert.equal(runRequest.projectPath, VERIFIED_PROJECT.path)
  assert.equal(runRequest.workspaceKey, 'canonical-window:support-repair-1')
  assert.equal(runRequest.model, 'claude-opus-4-6')
  assert.equal(runRequest.timeoutMs, 30_000)
  assert.match(runRequest.prompt, /git commit, git push/)
  assert.match(runRequest.prompt, /authenticated CLI subscription/)
  assert.match(runRequest.prompt, /Long unbroken output escapes/)

  assert.equal(result.status, 'agent_run_completed')
  assert.equal(result.verification, 'requires_user_review')
  assert.deepEqual(result.run.usage, completedRun({ provider: 'claude' }).usage)
  assert.equal(result.policy.execution, 'authenticated_subscription_cli_only')
  assert.equal(result.policy.gitCommit, 'forbidden')
  assert.equal(result.policy.gitPush, 'forbidden')
  assert.equal(result.policy.productionDeploy, 'forbidden')
  assert.equal(result.policy.externalTicketMutation, 'forbidden')
  assert.deepEqual(result.retry, {
    automatic: false,
    safeToRetry: false,
    reason: 'A completed repair run may have edited project files. Review its changes before any further run.',
  })
})

test('repair rejects a stale or mismatched project ID before the CLI runner starts', async () => {
  const { service, calls } = serviceFixture()

  await assert.rejects(
    service.run(validRequest({ projectId: 'local-stale-project' })),
    (error) =>
      error instanceof SupportRepairError
      && error.code === 'repair_project_mismatch'
      && error.safeToRetry === true,
  )
  assert.equal(calls.runs.length, 0)
})

test('support evidence redacts common credentials before reaching the subscription CLI', async () => {
  const source = [
    'Authorization: Bearer top-secret',
    'OPENAI API key = sk-1234567890abcdefghijklmnop',
    'password=hunter2',
    'github ghp_1234567890abcdefghijklmnop',
    'telegram 123456789:abcdefghijklmnopqrstuvwxyzABCDE',
    'remote https://user:password@example.com/repo',
  ].join('\n')
  const scrubbed = redactSupportInput(source)
  assert.doesNotMatch(scrubbed, /top-secret|hunter2|sk-123|ghp_|abcdefghijklmnopqrstuvwxyz|user:password/)
  assert.match(scrubbed, /\[REDACTED\]/)

  const prompt = compileSupportRepairPrompt(
    validRequest({
      prompt: `Fix authentication. ${source}`,
      diagnostics: { summary: source, details: source },
    }),
    VERIFIED_PROJECT,
  )
  assert.doesNotMatch(prompt, /top-secret|hunter2|sk-123|ghp_|abcdefghijklmnopqrstuvwxyz|user:password/)
})

test('repair preserves runner zero-activity retry proof but never retries or falls back itself', async () => {
  let attempts = 0
  const { service } = serviceFixture({
    chatService: {
      async run() {
        attempts += 1
        const error = new Error('Codex quota reached before tool activity.')
        error.code = 'provider_quota'
        error.status = 429
        error.safeToRetry = true
        throw error
      },
    },
  })

  await assert.rejects(
    service.run(validRequest()),
    (error) => {
      assert.equal(error.code, 'provider_quota')
      assert.equal(error.status, 429)
      assert.equal(error.safeToRetry, true)
      assert.equal(error.retry.automatic, false)
      assert.match(error.retry.reason, /proved.*safe to retry/i)
      return true
    },
  )
  assert.equal(attempts, 1)
})

test('unsafe and unverifiable runner outcomes cannot be presented as a fixed bug', async () => {
  const unsafe = serviceFixture({
    chatService: {
      async run() {
        const error = new Error('Runner stream ended after unknown activity.')
        error.code = 'invalid_cli_output'
        error.status = 502
        error.safeToRetry = false
        throw error
      },
    },
  }).service
  await assert.rejects(
    unsafe.run(validRequest()),
    (error) =>
      error instanceof SupportRepairError
      && error.safeToRetry === false
      && /Do not replay/.test(error.retry.reason),
  )

  const unverifiedSuccess = serviceFixture({
    chatService: {
      async run() {
        return { response: 'Fixed!' }
      },
    },
  }).service
  await assert.rejects(
    unverifiedSuccess.run(validRequest()),
    (error) =>
      error instanceof SupportRepairError
      && error.code === 'invalid_repair_runner_result'
      && error.safeToRetry === false,
  )
})

test('support error payload carries explicit non-automatic retry semantics', () => {
  const error = new SupportRepairError('provider_quota', 'Quota reached.', 429, {
    safeToRetry: true,
    retryReason: 'Structured zero-activity proof is available.',
  })
  assert.deepEqual(supportRepairErrorPayload(error), {
    error: 'Quota reached.',
    code: 'provider_quota',
    safeToRetry: true,
    retry: {
      automatic: false,
      safeToRetry: true,
      reason: 'Structured zero-activity proof is available.',
    },
  })
})
