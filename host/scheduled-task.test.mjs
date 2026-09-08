import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import {
  ScheduledTaskError,
  ScheduledTaskService,
  compileScheduledRepairPrompt,
  describeSchedule,
  loadScheduledTaskConfig,
  nextRunAfter,
  parseSchedule,
  parseScheduledTaskConfig,
  runConnectorPlanWithRepair,
  runScheduledTaskOnce,
  writeScheduledTaskConfig,
} from './scheduled-task.mjs'

function config(overrides = {}) {
  return {
    version: 1,
    enabled: true,
    task: {
      name: 'watchdog',
      schedule: { intervalMinutes: 5 },
      cwd: '/tmp/ensync-scheduled-project',
      tools: 'full-access',
      size: null,
      prompt: 'Run the checks and report.',
      ...overrides,
    },
  }
}

const CRON_PLAN = () => ({ sequence: [{ id: 'codex', name: 'Codex', invocation: { kind: 'spawn' } }], selected: { id: 'codex' } })

/* ------------------------------------------------------------------------- *
 * Schedule parsing and next-run computation.
 * ------------------------------------------------------------------------- */

test('an interval schedule aligns to wall-clock boundaries and skips the present moment', () => {
  const schedule = parseSchedule({ intervalMinutes: 5 })
  assert.equal(schedule.kind, 'interval')
  const from = new Date('2026-09-07T03:07:31.000Z')
  const next = nextRunAfter({ intervalMinutes: 5 }, from)
  assert.equal(next.toISOString(), '2026-09-07T03:10:00.000Z')
})

test('a five-field cron expression matches its step values', () => {
  const schedule = parseSchedule({ cron: '*/5 * * * *' })
  assert.equal(schedule.kind, 'cron')
  assert.equal(schedule.expression, '*/5 * * * *')
  const next = nextRunAfter({ cron: '*/5 * * * *' }, new Date('2026-09-07T03:07:31.000Z'))
  assert.equal(next.toISOString(), '2026-09-07T03:10:00.000Z')
})

test('cron day-of-week accepts both Sunday spellings and day-of-month ORs', () => {
  const schedule = parseSchedule({ cron: '0 3 1 * 7' })
  assert.equal(schedule.kind, 'cron')
  // Sunday as 7 normalizes to 0, and day-of-month 1 ORs with day-of-week Sunday,
  // so the next match after a Thursday is the first Sunday at 03:00 local time.
  const from = new Date('2026-10-20T00:00:00.000Z')
  const next = nextRunAfter({ cron: '0 3 1 * 7' }, from)
  assert.ok(next > from)
  assert.equal(next.getDay(), 0)
  assert.equal(next.getHours(), 3)
  assert.equal(next.getMinutes(), 0)
})

test('invalid schedules fail loudly', () => {
  assert.throws(() => parseSchedule({}), ScheduledTaskError)
  assert.throws(() => parseSchedule({ intervalMinutes: 0 }), ScheduledTaskError)
  assert.throws(() => parseSchedule({ cron: '*/5 * * *' }), ScheduledTaskError)
  assert.throws(() => parseSchedule({ cron: '* * * * 9' }), ScheduledTaskError)
})

/* ------------------------------------------------------------------------- *
 * Config validation and round-trip.
 * ------------------------------------------------------------------------- */

test('config parsing fills a default prompt and validates tools and cwd', () => {
  const parsed = parseScheduledTaskConfig(config({ prompt: '' }))
  assert.match(parsed.prompt, /automated checks/)
  assert.equal(parsed.tools, 'full-access')
  assert.equal(parsed.name, 'watchdog')
  assert.throws(() => parseScheduledTaskConfig(config({ tools: 'everything' })), /Tool level/)
  assert.throws(() => parseScheduledTaskConfig(config({ cwd: 'relative/path' })), /absolute path/)
  assert.throws(() => parseScheduledTaskConfig({ version: 9, task: {} }), /version/)
})

test('a disabled config is a no-op, not an error', () => {
  assert.equal(parseScheduledTaskConfig({ version: 1, enabled: false }), null)
})

test('config round-trips through the file, preserving an original cron expression', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'ensync-scheduled-'))
  const path = join(dir, 'scheduled-task-v1.json')
  try {
    const written = await writeScheduledTaskConfig(path, config({ schedule: { cron: '*/5 * * * *' } }))
    assert.equal(written.task.schedule.cron, '*/5 * * * *')
    const loaded = await loadScheduledTaskConfig(path)
    assert.deepEqual(describeSchedule(loaded.schedule), { cron: '*/5 * * * *' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

/* ------------------------------------------------------------------------- *
 * Repair prompt compilation.
 * ------------------------------------------------------------------------- */

test('the repair prompt names the failure and stops short of a replay instruction', () => {
  const prompt = compileScheduledRepairPrompt({
    task: { name: 'watchdog', cwd: '/tmp/project', prompt: 'Deploy the thing.' },
    failure: { code: 'provider_quota', message: 'No capacity before any tool activity.' },
  })
  assert.match(prompt, /watchdog/)
  assert.match(prompt, /\/tmp\/project/)
  assert.match(prompt, /provider_quota/)
  assert.match(prompt, /do not re-run this blindly/i)
  assert.match(prompt, /Deploy the thing/)
})

/* ------------------------------------------------------------------------- *
 * Repair-enabled connector orchestration.
 * ------------------------------------------------------------------------- */

test('a successful run passes through without a repair hop', async () => {
  const calls = []
  const run = async (plan, options) => {
    calls.push(options.prompt)
    return { provider: 'codex', providerName: 'Codex', response: 'ok' }
  }
  const result = await runConnectorPlanWithRepair(CRON_PLAN(), {
    run,
    prompt: 'original task',
    cwd: '/tmp/project',
  })
  assert.equal(result.repaired, false)
  assert.deepEqual(calls, ['original task'])
})

test('any failure triggers a fresh repair prompt with an available provider, never a replay', async () => {
  const calls = []
  const planCalls = []
  const run = async (plan, options) => {
    calls.push(options.prompt)
    if (calls.length === 1) {
      const error = new Error('partial work may exist')
      error.code = 'cli_failed'
      throw error
    }
    return { provider: 'claude', providerName: 'Claude Code', response: 'repaired' }
  }
  const result = await runConnectorPlanWithRepair(CRON_PLAN(), {
    run,
    prompt: 'original task',
    cwd: '/tmp/project',
    repairPlan: async (attempted) => {
      planCalls.push(attempted)
      return CRON_PLAN()
    },
    onRepairNeeded: () => {},
  })
  assert.equal(result.repaired, true)
  assert.equal(result.originalError.code, 'cli_failed')
  assert.deepEqual(planCalls, [[]])
  assert.equal(calls.length, 2)
  assert.notEqual(calls[1], calls[0])
  assert.match(calls[1], /do not re-run this blindly/i)
})

test('repair picks the next platform in the same way when repairPlan is omitted', async () => {
  const calls = []
  const run = async (plan, options) => {
    calls.push(options.prompt)
    if (calls.length === 1) {
      const error = new Error('stopped')
      error.code = 'run_cancelled'
      throw error
    }
    return { provider: 'droid', providerName: 'Factory Droid', response: 'done' }
  }
  const result = await runConnectorPlanWithRepair(CRON_PLAN(), {
    run, prompt: 'task', cwd: '/tmp/project', repairTask: { name: 'watch', cwd: '/tmp/project', prompt: 'task' },
  })
  assert.equal(result.repaired, true)
  assert.equal(calls.length, 2)
})

test('repair: false keeps the original fail-fast behavior', async () => {
  let runs = 0
  const run = async () => {
    runs += 1
    throw new Error('blocked')
  }
  await assert.rejects(
    () => runConnectorPlanWithRepair(CRON_PLAN(), { run, prompt: 'task', cwd: '/tmp/project', repair: false }),
    /blocked/,
  )
  assert.equal(runs, 1)
})

test('a repair that cannot find an available provider preserves the original error', async () => {
  const run = async () => {
    const error = new Error('original failure')
    error.code = 'provider_unavailable'
    throw error
  }
  await assert.rejects(
    () => runConnectorPlanWithRepair(CRON_PLAN(), {
      run, prompt: 'task', cwd: '/tmp/project',
      repairPlan: async () => ({ sequence: [] }),
    }),
    /original failure/,
  )
})

/* ------------------------------------------------------------------------- *
 * runScheduledTaskOnce stage mapping.
 * ------------------------------------------------------------------------- */

test('runScheduledTaskOnce reports completed, repaired, and repair-failed outcomes', async () => {
  const planner = { plan: async () => CRON_PLAN() }

  const completed = await runScheduledTaskOnce({
    task: config().task,
    planner,
    run: async () => ({ provider: 'codex', response: 'ok', repaired: false }),
  })
  assert.equal(completed.stage, 'completed')
  assert.equal(completed.ok, true)

  const repaired = await runScheduledTaskOnce({
    task: config().task,
    planner,
    run: async () => ({
      provider: 'claude',
      response: 'fixed',
      repaired: true,
      originalError: { code: 'cli_failed', message: 'bad' },
    }),
  })
  assert.equal(repaired.stage, 'repaired')
  assert.equal(repaired.repair.provider, 'claude')

  const repairFailed = await runScheduledTaskOnce({
    task: config().task,
    planner,
    run: async () => {
      const error = new Error('still down')
      error.code = 'cli_failed'
      error.originalError = { code: 'provider_quota', message: 'first failure' }
      throw error
    },
  })
  assert.equal(repairFailed.stage, 'repair_failed')
  assert.equal(repairFailed.ok, false)
})

test('runScheduledTaskOnce reports unavailable when no provider has capacity', async () => {
  const planner = { plan: async () => ({ sequence: [] }) }
  const result = await runScheduledTaskOnce({ task: config().task, planner })
  assert.equal(result.stage, 'unavailable')
  assert.equal(result.ok, false)
  assert.equal(result.error.code, 'provider_unavailable')
})

/* ------------------------------------------------------------------------- *
 * ScheduledTaskService lifecycle.
 * ------------------------------------------------------------------------- */

test('the service stays inert without a config file and loads one when present', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'ensync-scheduled-svc-'))
  const configPath = join(dir, 'scheduled-task-v1.json')
  context.after(() => rm(dir, { recursive: true, force: true }))
  const planner = { plan: async () => CRON_PLAN() }

  const empty = new ScheduledTaskService({ configPath, planner })
  await empty.start()
  assert.deepEqual(empty.status(), { enabled: false, task: null, live: null })
  await empty.stop()

  await writeScheduledTaskConfig(configPath, config())
  const service = new ScheduledTaskService({ configPath, planner })
  await service.start()
  const status = service.status()
  assert.equal(status.enabled, true)
  assert.equal(status.task.name, 'watchdog')
  assert.deepEqual(status.task.schedule, { intervalMinutes: 5 })
  assert.equal('prompt' in status.task, false)
  assert.equal(status.live.running, false)
  assert.ok(status.live.nextRunAt)
  assert.equal(service.hasActiveWork(), false)
  await service.stop()
  assert.equal(service.status().enabled, false)
})

test('an invalid config file is reported and leaves the service inert', async (context) => {
  const dir = await mkdtemp(join(tmpdir(), 'ensync-scheduled-bad-'))
  const configPath = join(dir, 'scheduled-task-v1.json')
  context.after(() => rm(dir, { recursive: true, force: true }))
  await writeFile(configPath, JSON.stringify({ version: 1, task: { schedule: { intervalMinutes: 5 }, cwd: 'nope' } }))
  const errors = []
  const service = new ScheduledTaskService({
    configPath,
    planner: { plan: async () => CRON_PLAN() },
    log: { error: (message) => errors.push(message) },
  })
  await service.start()
  assert.equal(service.status().enabled, false)
  assert.equal(errors.length, 1)
  assert.match(errors[0], /invalid/i)
})
