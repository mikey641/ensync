/**
 * Agent connector — Ensync as the routing authority for agents that run outside
 * the app (watchdogs, chat bots, cron repairs).
 *
 * The point of this module is that an outside caller never learns the provider
 * list, the fallback ranking, or the model-size mapping by copying them. It asks
 * the Host, and the Host answers with `host/automatic-routing.mjs` — the exact
 * module the renderer resolves Auto with. Adding a provider to the automatic
 * allowlist, or reordering the ranking in Settings, therefore changes an outside
 * bot's routing with no change on the bot's side.
 *
 * Two things live here:
 *  - the device-wide fallback ranking, persisted as a file so a headless daemon
 *    can answer a bot while no window is open (the renderer's localStorage copy
 *    is unreadable from the daemon, and mirrors into this file on every change);
 *  - the invocation descriptor for one headless turn per provider, so the caller
 *    spawns what Ensync would spawn instead of inventing flags.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import {
  DEFAULT_FALLBACK_PROVIDER_ORDER,
  normalizeFallbackProviderOrder,
  selectAutomaticProvider,
} from './automatic-routing.mjs'
import { DROID_AUTONOMY_LEVEL } from './droid-exec.mjs'
import { MODEL_SIZE_EFFORT, effortForModelSize } from './model-size-effort.mjs'

export const CONNECTOR_API_VERSION = 1

/**
 * Containment levels an outside caller can ask for. They are provider-neutral
 * names; each runner below maps its own verified flags onto them, and a runner
 * with no verified expression of a level refuses it rather than approximating.
 */
export const CONNECTOR_TOOL_LEVELS = Object.freeze(['read-only', 'workspace-write', 'full-access'])

export const CONNECTOR_SIZE_TIERS = Object.freeze(Object.keys(MODEL_SIZE_EFFORT))

export const CONNECTOR_PREFERENCES_FILENAME = 'ensync-agent-connector-v1.json'

export class AgentConnectorError extends Error {
  constructor(code, message, status = 400) {
    super(message)
    this.name = 'AgentConnectorError'
    this.code = code
    this.status = status
  }
}

/**
 * The renderer decides a provider is routable from exactly these three status
 * fields (src/App.tsx providerFromStatus). Reading them here, from the same
 * `/api/providers` record, is what keeps a bot's view of "available" identical
 * to the app's rather than merely similar.
 */
export function routingProviderFromStatus(status) {
  return {
    id: status.id,
    name: status.name,
    connected: status.routeKind === 'subscription' && status.connectionState === 'ready',
    chatExecution: status.chatExecution ?? null,
    usage: typeof status.usage?.usedPercent === 'number' ? status.usage.usedPercent : null,
    installed: status.installed === true,
    executable: status.executable ?? null,
    plan: status.usage?.plan ?? status.authentication?.exactPlan ?? null,
    model: status.usage?.model ?? null,
    resetLabel: status.usage?.resetLabel ?? null,
    resetAt: status.usage?.resetAt ?? null,
    usageReason: status.usage?.reason ?? null,
    authenticationReason: status.authentication?.reason ?? null,
  }
}

/**
 * Why a provider in the automatic allowlist is not a candidate right now, in the
 * same terms the Settings routing list shows a person.
 */
export function routingExclusionReason(provider) {
  if (!provider) return 'Ensync does not know this provider.'
  if (!provider.installed) return `${provider.name} is not installed on this machine.`
  if (!provider.connected) {
    return provider.authenticationReason
      ? `${provider.name} is not connected: ${provider.authenticationReason}`
      : `${provider.name} is not connected.`
  }
  if (provider.chatExecution !== 'supported') return `${provider.name} has no tested Ensync chat runner.`
  if (typeof provider.usage === 'number' && provider.usage >= 100) {
    return `${provider.name} reports ${provider.usage}% of its subscription window used.`
  }
  return null
}

function codexInvocation({ provider, toolLevel, effort, cwd, lastMessagePath }) {
  const sandbox = {
    'read-only': 'read-only',
    'workspace-write': 'workspace-write',
  }[toolLevel] ?? null
  // `--dangerously-bypass-approvals-and-sandbox` is Codex's own documented name
  // for "no sandbox and no approvals"; full access is never assembled out of a
  // sandbox mode plus an approval override here.
  const containmentArgs = sandbox
    ? ['--sandbox', sandbox]
    : ['--dangerously-bypass-approvals-and-sandbox']
  return {
    kind: 'spawn',
    executable: provider.executable,
    args: [
      'exec',
      ...containmentArgs,
      '--json',
      '--color', 'never',
      '--skip-git-repo-check',
      '--cd', cwd,
      ...(effort ? ['-c', `model_reasoning_effort="${effort}"`] : []),
      ...(lastMessagePath ? ['--output-last-message', lastMessagePath] : []),
      '-',
    ],
    promptDelivery: 'stdin',
    resultFormat: 'codex-json',
    containment: sandbox ?? 'danger-full-access',
  }
}

// Claude Code's print mode has no path-scoped sandbox: the allowlist decides
// which tools may run at all, and an allowed Bash tool is unconstrained. That is
// the same fail-open gap host/chat.mjs records for Ensync's own Claude runs, not
// a weaker contract invented for connector callers.
const CLAUDE_ALLOWED_TOOLS = Object.freeze({
  'read-only': 'Read,Grep,Glob',
  'workspace-write': 'Read,Grep,Glob,Edit,Write,NotebookEdit,Bash',
})

function claudeInvocation({ provider, toolLevel, effort, cwd }) {
  const allowed = CLAUDE_ALLOWED_TOOLS[toolLevel] ?? null
  return {
    kind: 'spawn',
    executable: provider.executable,
    args: [
      '--print',
      '--verbose',
      '--output-format', 'stream-json',
      ...(effort ? ['--effort', effort] : []),
      ...(allowed ? ['--allowed-tools', allowed] : ['--dangerously-skip-permissions']),
    ],
    promptDelivery: 'stdin',
    resultFormat: 'claude-stream-json',
    cwd,
    containment: allowed ? `allowed-tools:${allowed}` : 'dangerously-skip-permissions',
  }
}

function droidInvocation({ provider, toolLevel, effort, cwd }) {
  // Droid's containment is a per-session autonomy level sent over its
  // stream-jsonrpc handshake, and Ensync's verified runner pins exactly one:
  // `medium`. There is no verified read-only or unsandboxed Droid session, so
  // the connector refuses those levels instead of inventing a second contract.
  if (toolLevel !== 'workspace-write') {
    return {
      kind: 'unsupported',
      reason: `Ensync runs Factory Droid at its pinned "${DROID_AUTONOMY_LEVEL}" autonomy level, which is the workspace-write level. Ensync has no verified ${toolLevel} Droid session.`,
    }
  }
  return {
    kind: 'droid-runner',
    executable: provider.executable,
    projectPath: cwd,
    effort,
    resultFormat: 'droid-jsonrpc',
    containment: `autonomy:${DROID_AUTONOMY_LEVEL}`,
  }
}

const CONNECTOR_RUNNERS = Object.freeze({
  codex: codexInvocation,
  claude: claudeInvocation,
  droid: droidInvocation,
})

/**
 * How one headless turn on this provider would be launched. Returns a descriptor
 * the caller executes; `kind: 'unsupported'` carries the exact reason.
 */
export function connectorInvocation({ provider, toolLevel, effort = null, cwd, lastMessagePath = null }) {
  const build = CONNECTOR_RUNNERS[provider?.id]
  if (!build) {
    return { kind: 'unsupported', reason: `Ensync has no connector runner for ${provider?.id ?? 'this provider'}.` }
  }
  if (!provider.executable) {
    return { kind: 'unsupported', reason: `${provider.name} has no resolved executable on this machine.` }
  }
  return build({ provider, toolLevel, effort, cwd, lastMessagePath })
}

function assertToolLevel(toolLevel) {
  if (!CONNECTOR_TOOL_LEVELS.includes(toolLevel)) {
    throw new AgentConnectorError(
      'connector_tool_level_invalid',
      `Tool level must be one of ${CONNECTOR_TOOL_LEVELS.join(', ')}.`,
    )
  }
  return toolLevel
}

function assertSizeTier(sizeTier) {
  if (sizeTier === null || sizeTier === undefined) return null
  if (!CONNECTOR_SIZE_TIERS.includes(sizeTier)) {
    throw new AgentConnectorError(
      'connector_size_tier_invalid',
      `Model size must be one of ${CONNECTOR_SIZE_TIERS.join(', ')}.`,
    )
  }
  return sizeTier
}

/**
 * The full fallback sequence Ensync would walk, not just its first step.
 *
 * It is produced by asking `selectAutomaticProvider` again with each answer
 * added to the attempted set, so quota-verified providers still precede
 * unknown-quota ones exactly as they do in a conversation. A caller that walks
 * this list falls back the way the app falls back.
 */
export function connectorPlan({
  providers,
  order,
  attempted = [],
  toolLevel = 'workspace-write',
  sizeTier = null,
  cwd,
  checkedAt = null,
}) {
  assertToolLevel(toolLevel)
  assertSizeTier(sizeTier)
  if (typeof cwd !== 'string' || !isAbsolute(cwd)) {
    throw new AgentConnectorError('connector_cwd_invalid', 'The connector working directory must be an absolute path.')
  }
  const priorityOrder = normalizeFallbackProviderOrder(order)
  const effort = effortForModelSize(sizeTier)
  const routing = providers.map((status) => routingProviderFromStatus(status))
  const byId = new Map(routing.map((provider) => [provider.id, provider]))

  const tried = [...attempted]
  const sequence = []
  const skipped = []
  for (;;) {
    const selected = selectAutomaticProvider(routing, priorityOrder, tried)
    if (!selected) break
    tried.push(selected.id)
    const invocation = connectorInvocation({ provider: selected, toolLevel, effort, cwd })
    if (invocation.kind === 'unsupported') {
      skipped.push({ id: selected.id, name: selected.name, reason: invocation.reason })
      continue
    }
    sequence.push({
      rank: sequence.length + 1,
      id: selected.id,
      name: selected.name,
      usage: selected.usage,
      plan: selected.plan,
      model: selected.model,
      resetLabel: selected.resetLabel,
      invocation,
    })
  }

  for (const id of priorityOrder) {
    if (tried.includes(id) || skipped.some((entry) => entry.id === id)) continue
    const provider = byId.get(id)
    skipped.push({
      id,
      name: provider?.name ?? id,
      reason: routingExclusionReason(provider) ?? `${provider?.name ?? id} was not selectable.`,
    })
  }

  return {
    apiVersion: CONNECTOR_API_VERSION,
    order: priorityOrder,
    toolLevel,
    sizeTier: sizeTier ?? null,
    effort,
    cwd,
    attempted: [...attempted],
    selected: sequence[0] ?? null,
    sequence,
    skipped,
    checkedAt,
  }
}

function userDataDirectory(env = process.env, platform = process.platform, home = homedir()) {
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'Ensync')
  if (platform === 'win32') return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'Ensync')
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'Ensync')
}

/**
 * Where the mirrored ranking lives. The daemon's own state file pins the exact
 * per-install directory when it is running detached, so the app and a bot never
 * disagree about which file is authoritative.
 */
export function defaultConnectorPreferencesPath(env = process.env, platform = process.platform, home = homedir()) {
  const explicit = env.ENSYNC_HOST_CONNECTOR_PREFERENCES_FILE
  if (typeof explicit === 'string' && isAbsolute(explicit)) return explicit
  const stateFile = env.ENSYNC_HOST_STATE_FILE
  if (typeof stateFile === 'string' && isAbsolute(stateFile)) {
    return join(dirname(stateFile), CONNECTOR_PREFERENCES_FILENAME)
  }
  return join(userDataDirectory(env, platform, home), CONNECTOR_PREFERENCES_FILENAME)
}

export async function readConnectorPreferences(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'))
    if (!parsed || parsed.version !== CONNECTOR_API_VERSION || !Array.isArray(parsed.order)) return null
    return {
      order: normalizeFallbackProviderOrder(parsed.order),
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    }
  } catch {
    // A missing or unreadable mirror is not an error: routing falls back to the
    // shipped default ranking, which is what a fresh install would use anyway.
    return null
  }
}

export async function writeConnectorPreferences(path, order, updatedAt) {
  const normalized = normalizeFallbackProviderOrder(order)
  const staging = `${path}.${process.pid}.staging`
  await mkdir(dirname(path), { recursive: true })
  await writeFile(
    staging,
    JSON.stringify({ version: CONNECTOR_API_VERSION, order: normalized, updatedAt }, null, 2),
    { encoding: 'utf8', mode: 0o600 },
  )
  // Replace atomically: a bot reading mid-write must never see half a ranking.
  await rename(staging, path)
  return { order: normalized, updatedAt }
}

export class AgentConnectorService {
  #statusService
  #preferencesPath
  #now

  constructor(options = {}) {
    this.#statusService = options.statusService ?? null
    this.#preferencesPath = options.preferencesPath ?? defaultConnectorPreferencesPath()
    this.#now = options.now ?? (() => new Date().toISOString())
  }

  get preferencesPath() {
    return this.#preferencesPath
  }

  async preferences() {
    const stored = await readConnectorPreferences(this.#preferencesPath)
    return {
      apiVersion: CONNECTOR_API_VERSION,
      order: stored?.order ?? [...DEFAULT_FALLBACK_PROVIDER_ORDER],
      source: stored ? 'device' : 'default',
      updatedAt: stored?.updatedAt ?? null,
      toolLevels: [...CONNECTOR_TOOL_LEVELS],
      sizeTiers: [...CONNECTOR_SIZE_TIERS],
    }
  }

  async savePreferences(order) {
    if (!Array.isArray(order)) {
      throw new AgentConnectorError('connector_order_invalid', 'The fallback ranking must be an array of provider IDs.')
    }
    const saved = await writeConnectorPreferences(this.#preferencesPath, order, this.#now())
    return {
      apiVersion: CONNECTOR_API_VERSION,
      order: saved.order,
      source: 'device',
      updatedAt: saved.updatedAt,
      toolLevels: [...CONNECTOR_TOOL_LEVELS],
      sizeTiers: [...CONNECTOR_SIZE_TIERS],
    }
  }

  async plan(options = {}) {
    if (!this.#statusService) {
      throw new AgentConnectorError('connector_unavailable', 'Ensync Host has no provider status service.', 503)
    }
    const preferences = await this.preferences()
    const providers = await this.#statusService.list({ refresh: options.refresh === true })
    return {
      ...connectorPlan({
        providers,
        order: preferences.order,
        attempted: options.attempted ?? [],
        toolLevel: options.toolLevel ?? 'workspace-write',
        sizeTier: options.sizeTier ?? null,
        cwd: options.cwd,
        checkedAt: this.#now(),
      }),
      orderSource: preferences.source,
      orderUpdatedAt: preferences.updatedAt,
    }
  }
}
