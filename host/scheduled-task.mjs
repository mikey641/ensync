/**
 * Host-owned scheduled task — a recurring run that lives inside Ensync instead
 * of a system crontab entry.
 *
 * The schedule fires the same routed turn a cron bot would get through
 * `ensync-agent`: the Host asks `AgentConnectorService.plan()` (live quota, in
 * the user's saved Automatic-fallback order) and `runConnectorPlan()` walks the
 * fallback sequence — so when a provider's subscription runs out the next
 * provider with remaining capacity takes over instead of the job stopping.
 *
 * A run is only re-placed on the same wall-clock cadence; a tick that would
 * overlap an already-running turn is skipped forward to the next boundary so
 * two turns never touch the same directory at once.
 *
 * After any terminal failure or stop, a repair turn runs with the next available
 * provider. The repair prompt is a fresh inspection task, never a blind replay:
 * it is told what failed and asked to inspect the working directory and report
 * the safest recovery, which keeps the no-replay-after-mutation rule intact.
 *
 * The task definition is a small user-only JSON file (one specific recurring
 * job, not a general scheduler UI). When no file exists the scheduler stays
 * inert, so existing installs are unchanged.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import {
  CONNECTOR_SIZE_TIERS,
  CONNECTOR_TOOL_LEVELS,
  userDataDirectory,
} from './agent-connector.mjs'
import { runConnectorPlan } from './agent-connector-run.mjs'
import { redactSupportInput } from './support-repair.mjs'

export const SCHEDULED_TASK_CONFIG_VERSION = 1
export const SCHEDULED_TASK_CONFIG_FILENAME = 'scheduled-task-v1.json'
export const SCHEDULED_TASK_STATE_FILENAME = 'scheduled-task-state-v1.json'

export const DEFAULT_SCHEDULED_TASK_PROMPT = [
  'Run this repository\'s automated checks, confirm the current working state,',
  'and report concisely what is healthy, what failed, and what safe repair is still needed. Do not commit or push.',
].join(' ')

const CRON_LIMITS = Object.freeze({
  minute: [0, 59],
  hour: [0, 23],
  'day-of-month': [1, 31],
  month: [1, 12],
  'day-of-week': [0, 7],
})

const MAX_CRON_SCAN_MINUTES = 366 * 24 * 60

export class ScheduledTaskError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'ScheduledTaskError'
    this.code = code
  }
}

/* ------------------------------------------------------------------------- *
 * Schedule parsing: a positive interval, or a five-field local-time cron.
 * ------------------------------------------------------------------------- */

function parseCronField(field, minimum, maximum) {
  const values = new Set()
  for (const rawPart of field.split(',')) {
    const part = rawPart.trim()
    if (!part) throw new ScheduledTaskError('schedule_invalid', `Empty segment in schedule field "${field}".`)
    let base = part
    let step = null
    if (part.includes('/')) {
      const [left, right] = part.split('/')
      base = left
      step = Number(right)
      if (!Number.isInteger(step) || step <= 0) {
        throw new ScheduledTaskError('schedule_invalid', `Invalid step "/${right}" in schedule field "${part}".`)
      }
    }
    let start
    let end
    if (base === '*') {
      start = minimum
      end = maximum
    } else if (base.includes('-')) {
      const [left, right] = base.split('-')
      start = Number(left)
      end = Number(right)
    } else {
      start = Number(base)
      end = Number(base)
    }
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < minimum || end > maximum || start > end) {
      throw new ScheduledTaskError('schedule_invalid', `"${part}" is outside ${minimum}-${maximum} for this schedule field.`)
    }
    const stride = step ?? 1
    for (let value = start; value <= end; value += stride) values.add(value)
  }
  return values
}

function parseCron(expression) {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new ScheduledTaskError('schedule_invalid', 'A cron expression must have five fields: minute hour day-of-month month day-of-week.')
  }
  const names = ['minute', 'hour', 'day-of-month', 'month', 'day-of-week']
  const parsed = {}
  names.forEach((name, index) => {
    const [minimum, maximum] = CRON_LIMITS[name]
    parsed[name] = {
      values: parseCronField(fields[index], minimum, maximum),
      wildcard: fields[index].trim() === '*',
    }
  })
  // Sunday is reachable as 0 or 7; normalize the 7 spelling before matching.
  if (parsed['day-of-week'].values.has(7)) parsed['day-of-week'].values.add(0)
  return parsed
}

function cronMatches(parsed, date) {
  if (!parsed.minute.values.has(date.getMinutes())) return false
  if (!parsed.hour.values.has(date.getHours())) return false
  if (!parsed.month.values.has(date.getMonth() + 1)) return false
  const domRestricted = !parsed['day-of-month'].wildcard
  const dowRestricted = !parsed['day-of-week'].wildcard
  const domMatches = parsed['day-of-month'].values.has(date.getDate())
  const dowMatches = parsed['day-of-week'].values.has(date.getDay())
  if (domRestricted && dowRestricted) return domMatches || dowMatches
  if (domRestricted) return domMatches
  if (dowRestricted) return dowMatches
  return true
}

/**
 * Normalize a task `schedule` object into its internal form.
 * Accepts `{ intervalMinutes: n }` or `{ cron: "<five-field expression>" }`.
 */
export function parseSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    throw new ScheduledTaskError('schedule_invalid', 'The task schedule must be an object.')
  }
  if (Number.isInteger(schedule.intervalMinutes) && schedule.intervalMinutes > 0) {
    return { kind: 'interval', minutes: schedule.intervalMinutes }
  }
  if (typeof schedule.cron === 'string' && schedule.cron.trim()) {
    return { kind: 'cron', fields: parseCron(schedule.cron), expression: schedule.cron.trim() }
  }
  throw new ScheduledTaskError('schedule_invalid', 'The schedule must set a positive "intervalMinutes" or a five-field "cron" expression.')
}

/**
 * The next run strictly after `from`, honoring the interval or cron schedule.
 * Returns null when no match exists within a bounded lookahead window.
 */
export function nextRunAfter(schedule, from = new Date()) {
  const parsed = schedule && typeof schedule.kind === 'string' ? schedule : parseSchedule(schedule)
  const fromMs = from instanceof Date && Number.isFinite(from.getTime()) ? from.getTime() : Date.now()
  if (parsed.kind === 'interval') {
    const intervalMs = parsed.minutes * 60_000
    return new Date(Math.ceil((fromMs + 1) / intervalMs) * intervalMs)
  }
  let candidateMs = Math.floor((fromMs + 60_000) / 60_000) * 60_000
  for (let scanned = 0; scanned < MAX_CRON_SCAN_MINUTES; scanned += 1) {
    const candidate = new Date(candidateMs)
    if (cronMatches(parsed.fields, candidate)) return candidate
    candidateMs += 60_000
  }
  return null
}

/* ------------------------------------------------------------------------- *
 * Task configuration file.
 * ------------------------------------------------------------------------- */

export function defaultScheduledTaskConfigPath(env = process.env, platform = process.platform, home = homedir()) {
  const explicit = env.ENSYNC_SCHEDULED_TASK_FILE
  if (typeof explicit === 'string' && isAbsolute(explicit)) return explicit
  const stateFile = env.ENSYNC_HOST_STATE_FILE
  if (typeof stateFile === 'string' && isAbsolute(stateFile)) {
    return join(dirname(stateFile), SCHEDULED_TASK_CONFIG_FILENAME)
  }
  return join(userDataDirectory(env, platform, home), SCHEDULED_TASK_CONFIG_FILENAME)
}

/**
 * Validate a raw config object. Returns the parsed task, or null when the
 * feature is explicitly disabled. Throws ScheduledTaskError on invalid input so
 * a misconfigured file fails loudly rather than silently skipping the job.
 */
export function parseScheduledTaskConfig(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ScheduledTaskError('config_invalid', 'The scheduled-task config must be a JSON object.')
  }
  if (raw.version !== SCHEDULED_TASK_CONFIG_VERSION) {
    throw new ScheduledTaskError('config_version_mismatch', `Unsupported scheduled-task config version: ${raw.version ?? 'missing'}.`)
  }
  if (raw.enabled === false) return null
  const task = raw.task
  if (!task || typeof task !== 'object' || Array.isArray(task)) {
    throw new ScheduledTaskError('task_invalid', 'The scheduled-task config is missing its "task".')
  }
  const schedule = parseSchedule(task.schedule)
  if (typeof task.cwd !== 'string' || !isAbsolute(task.cwd)) {
    throw new ScheduledTaskError('cwd_invalid', 'The scheduled task "cwd" must be an absolute path.')
  }
  const tools = task.tools ?? 'workspace-write'
  if (!CONNECTOR_TOOL_LEVELS.includes(tools)) {
    throw new ScheduledTaskError('tools_invalid', `Tool level must be one of ${CONNECTOR_TOOL_LEVELS.join(', ')}.`)
  }
  const size = task.size ?? null
  if (size !== null && !CONNECTOR_SIZE_TIERS.includes(size)) {
    throw new ScheduledTaskError('size_invalid', `Model size must be one of ${CONNECTOR_SIZE_TIERS.join(', ')}.`)
  }
  return {
    name: typeof task.name === 'string' && task.name.trim() ? task.name.trim() : 'scheduled-task',
    schedule,
    cwd: task.cwd,
    tools,
    size,
    prompt: typeof task.prompt === 'string' && task.prompt.trim() ? task.prompt : DEFAULT_SCHEDULED_TASK_PROMPT,
    timeoutSeconds: Number.isFinite(task.timeoutSeconds) && task.timeoutSeconds > 0 ? task.timeoutSeconds : null,
  }
}

export function serializeScheduledTaskConfig(config) {
  const task = parseScheduledTaskConfig(config)
  if (!task) return null
  return {
    version: SCHEDULED_TASK_CONFIG_VERSION,
    enabled: true,
    task: {
      name: task.name,
      schedule: describeSchedule(task.schedule),
      cwd: task.cwd,
      tools: task.tools,
      size: task.size,
      prompt: task.prompt,
      ...(task.timeoutSeconds ? { timeoutSeconds: task.timeoutSeconds } : {}),
    },
  }
}

function cronExpression(fields) {
  const render = (name) => {
    const { values, wildcard } = fields[name]
    if (wildcard) return '*'
    return [...values].sort((a, b) => a - b).join(',')
  }
  return [render('minute'), render('hour'), render('day-of-month'), render('month'), render('day-of-week')].join(' ')
}

/** The human/config-friendly schedule object, preserving an original cron string. */
export function describeSchedule(schedule) {
  return schedule.kind === 'interval'
    ? { intervalMinutes: schedule.minutes }
    : { cron: schedule.expression ?? cronExpression(schedule.fields) }
}

export async function loadScheduledTaskConfig(path) {
  let raw
  try {
    raw = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
  return parseScheduledTaskConfig(raw)
}

export async function writeScheduledTaskConfig(path, config) {
  const serialized = serializeScheduledTaskConfig(config)
  const staging = `${path}.${process.pid}.staging`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(staging, `${JSON.stringify(serialized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(staging, path)
  return serialized
}

/* ------------------------------------------------------------------------- *
 * Execution: the routed primary turn, then a repair turn after any failure.
 * ------------------------------------------------------------------------- */

function describeFailure(error) {
  return {
    code: typeof error?.code === 'string' ? error.code : 'run_failed',
    message: error instanceof Error ? error.message : 'The run failed without a verifiable error.',
  }
}

function planOptionsFor(task, attempted = []) {
  return {
    cwd: task.cwd,
    toolLevel: task.tools,
    sizeTier: task.size ?? null,
    refresh: true,
    attempted,
  }
}

export function compileScheduledRepairPrompt({ task, failure }) {
  const name = task.name ?? 'scheduled task'
  return [
    `Ensync's ${name} stopped before a run completed. Investigate and repair it safely.`,
    `Working directory: ${task.cwd}`,
    `The run stopped with failure code ${failure.code}.`,
    failure.message
      ? `Verified failure message:\n${redactSupportInput(failure.message).slice(0, 4_000)}`
      : null,
    'For context only — do not re-run this blindly — the scheduled task had been asked to:'
      + `\n${redactSupportInput(task.prompt).slice(0, 2_000)}`,
    'Inspect the working directory and any logs, determine the safest recovery, make only the edits needed for a defensible fix, and report exactly what changed and the checks you ran.',
    'Never run destructive or irreversible commands without strong evidence they are required. Do not claim a fix you cannot verify.',
  ].filter(Boolean).join('\n\n')
}

/**
 * Walk one connector plan. On any terminal failure or stop — including a
 * failure the normal fallback loop refuses to replay across providers because
 * partial work may exist — run a fresh repair turn with the next available
 * provider instead of leaving the job stopped.
 *
 * The repair prompt is a new inspection task, never a blind replay of the
 * original prompt, so the no-replay-after-mutation rule still holds: the repair
 * agent is told what failed and asked to inspect the working directory and
 * report or apply the safest recovery.
 *
 * `plan` is the primary plan; `repairPlan` returns a fresh plan (re-probing
 * subscriptions) when a repair is needed, and defaults to the primary plan's
 * untouched sequence when omitted. Set `repair: false` to disable the repair
 * hop for callers that only want plain fallback.
 */
export async function runConnectorPlanWithRepair(plan, options = {}) {
  const run = options.run ?? runConnectorPlan
  try {
    const result = await run(plan, options)
    return { ...result, repaired: false }
  } catch (error) {
    if (options.repair === false) throw error
    const failure = describeFailure(error)
    options.onRepairNeeded?.({ ...failure })
    const repairPlan = typeof options.repairPlan === 'function'
      ? await options.repairPlan([])
      : { sequence: plan?.sequence ?? [] }
    if (!repairPlan?.sequence?.length) throw error
    const task = options.repairTask ?? {
      name: options.repairName ?? 'scheduled task',
      cwd: options.cwd,
      prompt: options.prompt,
    }
    const repairPrompt = compileScheduledRepairPrompt({ task, failure })
    try {
      const result = await run(repairPlan, {
        prompt: repairPrompt,
        cwd: options.cwd,
        fallbackEnabled: options.fallbackEnabled !== false,
        hardTimeoutMs: options.hardTimeoutMs ?? null,
        refreshPlan: typeof options.repairPlan === 'function'
          ? (attempted) => options.repairPlan(attempted)
          : undefined,
        onFallback: options.onRepairFallback ?? options.onFallback,
      })
      return { ...result, repaired: true, originalError: failure }
    } catch (repairError) {
      repairError.originalError = failure
      throw repairError
    }
  }
}

/**
 * Run one scheduled turn: route by live quota, fall back automatically, and on
 * any terminal failure or stop run a repair turn with the next available
 * provider. `planner` is an AgentConnectorService (or shape-compatible); `run`
 * defaults to the shared repair-enabled connector plan runner.
 */
export async function runScheduledTaskOnce({ task, planner, run = runConnectorPlanWithRepair, onEvent = () => {} }) {
  const plan = await planner.plan(planOptionsFor(task))
  if (!plan?.sequence?.length) {
    return {
      ok: false,
      stage: 'unavailable',
      error: { code: 'provider_unavailable', message: 'No connected subscription provider has capacity for the scheduled run.' },
    }
  }
  try {
    const result = await run(plan, {
      prompt: task.prompt,
      cwd: task.cwd,
      fallbackEnabled: true,
      hardTimeoutMs: Number.isFinite(task.timeoutSeconds) && task.timeoutSeconds > 0 ? task.timeoutSeconds * 1_000 : null,
      refreshPlan: (attempted) => planner.plan(planOptionsFor(task, attempted)),
      repairPlan: (attempted) => planner.plan(planOptionsFor(task, attempted)),
      repairTask: task,
      onFallback: ({ from, to, kind, code }) => onEvent({ type: 'fallback', from, to, kind, code }),
      onRepairFallback: ({ from, to, kind, code }) => onEvent({ type: 'repair_fallback', from, to, kind, code }),
      onRepairNeeded: ({ code, message }) => onEvent({ type: 'run_failed', code, message }),
    })
    return result.repaired
      ? { ok: true, stage: 'repaired', error: result.originalError, repair: result }
      : { ok: true, stage: 'completed', result }
  } catch (error) {
    const failure = describeFailure(error)
    return {
      ok: false,
      stage: error?.originalError ? 'repair_failed' : 'run_failed',
      error: error?.originalError ?? failure,
      repairError: error?.originalError ? failure : null,
    }
  }
}

/* ------------------------------------------------------------------------- *
 * The recurring runner: wall-clock timer plus a recoverable state file.
 * ------------------------------------------------------------------------- */

async function atomicWriteJson(path, value) {
  const staging = `${path}.${process.pid}.staging`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(staging, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(staging, path)
}

export class ScheduledTaskRunner {
  #task
  #runTask
  #statePath
  #now
  #log
  #timer = null
  #running = false
  #stopped = true
  #nextRunAt = null
  #lastRun = null

  constructor(options = {}) {
    if (!options.task || typeof options.task !== 'object') {
      throw new TypeError('ScheduledTaskRunner requires a parsed task.')
    }
    if (typeof options.runTask !== 'function') {
      throw new TypeError('ScheduledTaskRunner requires a runTask function.')
    }
    this.#task = options.task
    this.#runTask = options.runTask
    this.#statePath = options.statePath ?? null
    this.#now = options.now ?? (() => new Date())
    this.#log = options.log ?? null
  }

  get task() {
    return this.#task
  }

  async start() {
    if (!this.#stopped) return
    const recovered = await this.#restore()
    this.#nextRunAt = recovered?.nextRunAt ?? nextRunAfter(this.#task.schedule, this.#now())
    this.#lastRun = recovered?.lastRun ?? null
    this.#stopped = false
    this.#arm()
  }

  stop() {
    this.#stopped = true
    if (this.#timer) clearTimeout(this.#timer)
    this.#timer = null
  }

  status() {
    return {
      enabled: true,
      name: this.#task.name,
      schedule: describeSchedule(this.#task.schedule),
      cwd: this.#task.cwd,
      tools: this.#task.tools,
      nextRunAt: this.#nextRunAt instanceof Date ? this.#nextRunAt.toISOString() : null,
      running: this.#running,
      lastRun: this.#lastRun,
    }
  }

  async #restore() {
    if (!this.#statePath) return null
    try {
      const parsed = JSON.parse(await readFile(this.#statePath, 'utf8'))
      if (!parsed || parsed.version !== SCHEDULED_TASK_CONFIG_VERSION) return null
      const nextRunAt = typeof parsed.nextRunAt === 'string' ? new Date(parsed.nextRunAt) : null
      return {
        nextRunAt: nextRunAt && Number.isFinite(nextRunAt.getTime()) ? nextRunAt : null,
        lastRun: parsed.lastRun && typeof parsed.lastRun === 'object' ? parsed.lastRun : null,
      }
    } catch {
      return null
    }
  }

  async #persist() {
    if (!this.#statePath) return
    await atomicWriteJson(this.#statePath, {
      version: SCHEDULED_TASK_CONFIG_VERSION,
      nextRunAt: this.#nextRunAt instanceof Date ? this.#nextRunAt.toISOString() : null,
      lastRun: this.#lastRun,
    })
  }

  #arm() {
    if (this.#stopped || !this.#nextRunAt) return
    const delay = Math.max(0, this.#nextRunAt.getTime() - this.#now().getTime())
    this.#timer = setTimeout(() => { void this.#tick() }, delay)
  }

  async #tick() {
    if (this.#stopped) return
    if (this.#running) {
      // A fire landed while the previous turn was still working: skip forward
      // to the next boundary instead of stacking two turns on one directory.
      this.#nextRunAt = nextRunAfter(this.#task.schedule, this.#now())
      await this.#persist()
      this.#arm()
      return
    }
    this.#running = true
    const startedAt = this.#now()
    let outcome
    try {
      outcome = await this.#runTask(this.#task)
    } catch (error) {
      outcome = { ok: false, stage: 'scheduler_error', error: describeFailure(error) }
    }
    const finishedAt = this.#now()
    this.#lastRun = {
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      stage: outcome?.stage ?? (outcome?.ok ? 'completed' : 'failed'),
      ok: outcome?.ok === true,
      provider: outcome?.result?.provider ?? outcome?.repair?.provider ?? null,
      fallbackReason: outcome?.result?.fallbackReason ?? outcome?.repair?.fallbackReason ?? null,
      errorCode: outcome?.error?.code ?? outcome?.repairError?.code ?? null,
      errorMessage: outcome?.error?.message ?? outcome?.repairError?.message ?? null,
    }
    if (this.#log) {
      const level = this.#lastRun.ok ? 'info' : 'error'
      this.#log[level]?.(
        `Ensync ${this.#task.name}: ${this.#lastRun.stage}`
        + `${this.#lastRun.provider ? ` on ${this.#lastRun.provider}` : ''}`
        + (this.#lastRun.errorCode ? ` (${this.#lastRun.errorCode})` : ''),
      )
    }
    this.#running = false
    this.#nextRunAt = nextRunAfter(this.#task.schedule, finishedAt)
    await this.#persist()
    this.#arm()
  }
}

/**
 * The recoverable state file lives beside the config file so one state path
 * matches one config path across Host restarts (and across processes when the
 * desktop shell pins the state file directory).
 */
export function scheduledTaskStatePathFor(configPath) {
  return join(dirname(configPath), SCHEDULED_TASK_STATE_FILENAME)
}

/**
 * Host-owned scheduled task service. Loads the user-only config on start and
 * stays inert when no config exists. It only keeps a wall-clock timer while the
 * Host process is alive, matching the auto-push and stranded-recovery intervals;
 * for guaranteed recurring execution with the app closed, drive the same task
 * through a system scheduler with `ensync-agent run --repair`.
 */
export class ScheduledTaskService {
  #configPath
  #planner
  #run
  #log
  #runner = null
  #config = null

  constructor(options = {}) {
    if (!options.planner || typeof options.planner.plan !== 'function') {
      throw new TypeError('ScheduledTaskService requires a planner with plan().')
    }
    this.#configPath = options.configPath ?? defaultScheduledTaskConfigPath()
    this.#planner = options.planner
    this.#run = options.run ?? runConnectorPlanWithRepair
    this.#log = options.log ?? null
  }

  get configPath() {
    return this.#configPath
  }

  get enabled() {
    return this.#config !== null
  }

  async start() {
    if (this.#runner) return
    let config
    try {
      config = await loadScheduledTaskConfig(this.#configPath)
    } catch (error) {
      // A malformed config fails loudly so the operator notices, rather than
      // silently skipping a recurring job.
      if (this.#log?.error) {
        this.#log.error(`Ensync scheduled task config is invalid: ${error?.message ?? error}`)
      }
      return
    }
    if (!config) return
    this.#config = config
    const runner = new ScheduledTaskRunner({
      task: config,
      statePath: scheduledTaskStatePathFor(this.#configPath),
      log: this.#log,
      runTask: (task) => runScheduledTaskOnce({
        task,
        planner: this.#planner,
        run: this.#run,
        onEvent: (event) => {
          if (event.type === 'fallback' || event.type === 'repair_fallback') {
            this.#log?.info?.(`Ensync scheduled task flipped to ${event.to} after ${event.from} (${event.code}).`)
          } else if (event.type === 'run_failed') {
            this.#log?.error?.(`Ensync scheduled task failed (${event.code}) and will run a repair agent.`)
          }
        },
      }),
    })
    await runner.start()
    this.#runner = runner
  }

  async stop() {
    this.#runner?.stop()
    this.#runner = null
    this.#config = null
  }

  status() {
    if (!this.enabled) return { enabled: false, task: null, live: null }
    const live = this.#runner?.status() ?? { running: false, nextRunAt: null, lastRun: null }
    return {
      enabled: true,
      task: {
        name: this.#config.name,
        schedule: describeSchedule(this.#config.schedule),
        cwd: this.#config.cwd,
        tools: this.#config.tools,
        size: this.#config.size,
      },
      live: {
        running: live.running === true,
        nextRunAt: live.nextRunAt ?? null,
        lastRun: live.lastRun ?? null,
      },
    }
  }

  hasActiveWork() {
    return this.#runner?.status()?.running === true
  }
}
