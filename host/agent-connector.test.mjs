import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  AgentConnectorError,
  AgentConnectorService,
  CONNECTOR_TOOL_LEVELS,
  connectorInvocation,
  connectorPlan,
  defaultConnectorPreferencesPath,
  routingProviderFromStatus,
} from './agent-connector.mjs'
import { runConnectorPlan } from './agent-connector-run.mjs'
import { DEFAULT_FALLBACK_PROVIDER_ORDER } from './automatic-routing.mjs'

const PROJECT = '/tmp/ensync-connector-project'

function status(id, overrides = {}) {
  const { usage = {}, ...rest } = overrides
  return {
    id,
    name: id === 'codex' ? 'Codex' : id === 'claude' ? 'Claude Code' : 'Factory Droid',
    installed: true,
    executable: `/usr/local/bin/${id}`,
    routeKind: 'subscription',
    connectionState: 'ready',
    chatExecution: 'supported',
    authentication: { state: 'authenticated', reason: 'Signed in.' },
    usage: { usedPercent: 10, plan: 'Pro', model: null, reason: 'Verified.', ...usage },
    ...rest,
  }
}

test('routing fields are read from the same status record the app reads', () => {
  const provider = routingProviderFromStatus(status('codex', { usage: { usedPercent: 42 } }))
  assert.equal(provider.connected, true)
  assert.equal(provider.usage, 42)
  assert.equal(provider.chatExecution, 'supported')
  assert.equal(
    routingProviderFromStatus(status('codex', { connectionState: 'needs_authentication' })).connected,
    false,
  )
  // Usage that is not a verified percentage stays unknown rather than becoming 0.
  assert.equal(routingProviderFromStatus(status('codex', { usage: { usedPercent: null } })).usage, null)
})

test('the plan is the whole fallback sequence, in Ensync priority order', () => {
  const plan = connectorPlan({
    providers: [status('claude'), status('codex'), status('droid')],
    order: ['claude', 'codex', 'droid'],
    cwd: PROJECT,
  })
  assert.deepEqual(plan.sequence.map((entry) => entry.id), ['claude', 'codex', 'droid'])
  assert.equal(plan.selected.id, 'claude')
  assert.equal(plan.skipped.length, 0)
})

test('an exhausted or disconnected provider is skipped with the reason a person would see', () => {
  const plan = connectorPlan({
    providers: [
      status('codex', { usage: { usedPercent: 100 } }),
      status('claude', { connectionState: 'needs_authentication', authentication: { state: 'not_authenticated', reason: 'Run claude auth login.' } }),
      status('droid'),
    ],
    order: DEFAULT_FALLBACK_PROVIDER_ORDER,
    cwd: PROJECT,
  })
  assert.deepEqual(plan.sequence.map((entry) => entry.id), ['droid'])
  assert.deepEqual(
    plan.skipped.map((entry) => entry.id).sort(),
    ['claude', 'codex'],
  )
  assert.match(plan.skipped.find((entry) => entry.id === 'codex').reason, /100% of its subscription window/)
  assert.match(plan.skipped.find((entry) => entry.id === 'claude').reason, /claude auth login/)
})

test('verified capacity outranks unknown capacity exactly as a conversation does', () => {
  const plan = connectorPlan({
    providers: [status('codex', { usage: { usedPercent: null } }), status('claude', { usage: { usedPercent: 90 } })],
    order: ['codex', 'claude'],
    cwd: PROJECT,
  })
  assert.deepEqual(plan.sequence.map((entry) => entry.id), ['claude', 'codex'])
})

test('already attempted providers are excluded so a fallback never repeats one', () => {
  const plan = connectorPlan({
    providers: [status('codex'), status('claude')],
    order: ['codex', 'claude'],
    attempted: ['codex'],
    cwd: PROJECT,
  })
  assert.deepEqual(plan.sequence.map((entry) => entry.id), ['claude'])
})

test('each tool level maps onto the runner flags Ensync verified, and nothing else', () => {
  const codex = (toolLevel) => connectorInvocation({
    provider: routingProviderFromStatus(status('codex')),
    toolLevel,
    cwd: PROJECT,
  })
  assert.deepEqual(codex('read-only').args.slice(0, 3), ['exec', '--sandbox', 'read-only'])
  assert.deepEqual(codex('workspace-write').args.slice(0, 3), ['exec', '--sandbox', 'workspace-write'])
  assert.deepEqual(codex('full-access').args.slice(0, 2), ['exec', '--dangerously-bypass-approvals-and-sandbox'])
  assert.ok(codex('workspace-write').args.includes('--cd'))
  assert.equal(codex('workspace-write').args.at(-1), '-')

  const claude = connectorInvocation({
    provider: routingProviderFromStatus(status('claude')),
    toolLevel: 'read-only',
    cwd: PROJECT,
  })
  assert.deepEqual(claude.args.slice(0, 4), ['--print', '--verbose', '--output-format', 'stream-json'])
  assert.deepEqual(claude.args.slice(-2), ['--allowed-tools', 'Read,Grep,Glob'])
  assert.equal(claude.cwd, PROJECT)

  const droid = connectorInvocation({
    provider: routingProviderFromStatus(status('droid')),
    toolLevel: 'workspace-write',
    cwd: PROJECT,
  })
  assert.equal(droid.kind, 'droid-runner')
  assert.equal(droid.containment, 'autonomy:medium')
})

test('Droid is refused, with its reason, at levels Ensync has no verified session for', () => {
  for (const toolLevel of ['read-only', 'full-access']) {
    const plan = connectorPlan({
      providers: [status('droid')],
      order: ['droid'],
      toolLevel,
      cwd: PROJECT,
    })
    assert.deepEqual(plan.sequence, [])
    assert.match(plan.skipped[0].reason, /pinned "medium" autonomy/)
  }
})

test('the model size tier becomes each provider\'s own reasoning effort', () => {
  const plan = connectorPlan({
    providers: [status('codex'), status('claude')],
    order: ['codex', 'claude'],
    sizeTier: 'large',
    cwd: PROJECT,
  })
  assert.equal(plan.effort, 'high')
  assert.ok(plan.sequence[0].invocation.args.includes('model_reasoning_effort="high"'))
  assert.deepEqual(plan.sequence[1].invocation.args.slice(4, 6), ['--effort', 'high'])
})

test('invalid connector input is refused before anything is spawned', () => {
  assert.throws(() => connectorPlan({ providers: [], order: [], toolLevel: 'yolo', cwd: PROJECT }), AgentConnectorError)
  assert.throws(() => connectorPlan({ providers: [], order: [], sizeTier: 'huge', cwd: PROJECT }), AgentConnectorError)
  assert.throws(() => connectorPlan({ providers: [], order: [], cwd: 'relative/path' }), AgentConnectorError)
  assert.deepEqual(CONNECTOR_TOOL_LEVELS, ['read-only', 'workspace-write', 'full-access'])
})

test('the mirrored ranking survives a restart and defaults before the app ever writes one', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-connector-'))
  try {
    const service = new AgentConnectorService({
      preferencesPath: join(directory, 'connector.json'),
      now: () => '2026-08-18T12:00:00.000Z',
    })
    const initial = await service.preferences()
    assert.deepEqual(initial.order, [...DEFAULT_FALLBACK_PROVIDER_ORDER])
    assert.equal(initial.source, 'default')

    const saved = await service.savePreferences(['droid', 'claude'])
    assert.deepEqual(saved.order, ['droid', 'claude', 'codex'])
    assert.equal(saved.source, 'device')

    const reread = await new AgentConnectorService({ preferencesPath: join(directory, 'connector.json') }).preferences()
    assert.deepEqual(reread.order, ['droid', 'claude', 'codex'])
    assert.equal(reread.updatedAt, '2026-08-18T12:00:00.000Z')
    const raw = JSON.parse(await readFile(join(directory, 'connector.json'), 'utf8'))
    assert.equal(raw.version, 1)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the service plans from the mirrored ranking and live provider status', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-connector-'))
  try {
    const service = new AgentConnectorService({
      preferencesPath: join(directory, 'connector.json'),
      statusService: { list: async () => [status('codex'), status('claude')] },
    })
    await service.savePreferences(['claude', 'codex'])
    const plan = await service.plan({ cwd: PROJECT })
    assert.deepEqual(plan.sequence.map((entry) => entry.id), ['claude', 'codex'])
    assert.equal(plan.orderSource, 'device')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('the daemon state file pins which preferences file a bot and the app share', () => {
  assert.equal(
    defaultConnectorPreferencesPath({ ENSYNC_HOST_STATE_FILE: '/data/Ensync/ensync-host-daemon-v1.json' }, 'darwin', '/home/x'),
    '/data/Ensync/ensync-agent-connector-v1.json',
  )
  assert.equal(
    defaultConnectorPreferencesPath({}, 'darwin', '/Users/x'),
    '/Users/x/Library/Application Support/Ensync/ensync-agent-connector-v1.json',
  )
})

function plannedCandidate(id, name) {
  return {
    rank: 1,
    id,
    name,
    usage: 10,
    invocation: {
      kind: 'spawn',
      executable: `/usr/local/bin/${id}`,
      args: [],
      promptDelivery: 'stdin',
      resultFormat: id === 'codex' ? 'codex-json' : 'claude-stream-json',
      containment: 'workspace-write',
    },
  }
}

test('a quota failure with zero activity hands the task to the next provider', async () => {
  const codexQuota = [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'turn.failed', error: { message: 'You have hit your usage limit.' } },
  ].map((event) => JSON.stringify(event)).join('\n')
  const claudeAnswer = JSON.stringify({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'restarted the container',
  })
  const spawned = []
  const result = await runConnectorPlan(
    { sequence: [plannedCandidate('codex', 'Codex'), plannedCandidate('claude', 'Claude Code')] },
    {
      prompt: 'repair the thing',
      cwd: PROJECT,
      processRunner: async (executable) => {
        spawned.push(executable)
        return spawned.length === 1
          ? { exitCode: 1, stdout: codexQuota, stderr: '', truncation: {}, timedOut: false, aborted: false, error: null }
          : { exitCode: 0, stdout: claudeAnswer, stderr: '', truncation: {}, timedOut: false, aborted: false, error: null }
      },
    },
  )
  assert.equal(result.provider, 'claude')
  assert.equal(result.response, 'restarted the container')
  assert.equal(result.attempts.length, 1)
  assert.equal(result.attempts[0].code, 'provider_quota')
  assert.match(result.fallbackReason, /zero observed activity; continuing with Claude Code/)
})

test('a failure that may have left partial work stops instead of replaying it elsewhere', async () => {
  const codexWorked = [
    { type: 'thread.started', thread_id: 'thread-1' },
    { type: 'item.completed', item: { type: 'command_execution', command: 'docker restart homeassistant' } },
    { type: 'turn.failed', error: { message: 'You have hit your usage limit.' } },
  ].map((event) => JSON.stringify(event)).join('\n')
  let calls = 0
  await assert.rejects(
    runConnectorPlan(
      { sequence: [plannedCandidate('codex', 'Codex'), plannedCandidate('claude', 'Claude Code')] },
      {
        prompt: 'repair the thing',
        cwd: PROJECT,
        processRunner: async () => {
          calls += 1
          return { exitCode: 1, stdout: codexWorked, stderr: '', truncation: {}, timedOut: false, aborted: false, error: null }
        },
      },
    ),
    (error) => error.code === 'cli_failed',
  )
  assert.equal(calls, 1, 'the second provider must never see a task whose first attempt did work')
})

test('an empty routing sequence is a routing failure, not a silent no-op', async () => {
  await assert.rejects(
    runConnectorPlan({ sequence: [] }, { prompt: 'anything', cwd: PROJECT }),
    (error) => error.code === 'provider_unavailable',
  )
})
