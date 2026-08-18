#!/usr/bin/env node
/**
 * ensync-agent — run one headless agent turn with Ensync's routing.
 *
 * For bots that live outside the app (a Home Assistant repair watchdog, a chat
 * bot, a cron job). They stop naming a provider or a model: they ask Ensync
 * which subscription has capacity right now, in the priority the person set in
 * Settings, and Ensync's own fallback rules decide whether a failed turn may be
 * handed to the next provider.
 *
 * Reorder the ranking in Ensync, or add a provider to the automatic allowlist,
 * and every bot using this command follows — nothing to redeploy.
 *
 *   ensync-agent run --cwd ~/homeassistant --tools full-access <<'PROMPT'
 *   ...task...
 *   PROMPT
 *
 *   ensync-agent plan --cwd ~/homeassistant        # what would run, and why
 *
 * Exit codes: 0 done, 2 usage error, 3 no provider had capacity, 4 the run
 * failed on every provider Ensync offered.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const DAEMON_DESCRIPTOR_FILENAME = 'ensync-host-daemon-v1.json'
const USAGE = `Usage:
  ensync-agent run  [--cwd DIR] [--tools LEVEL] [--size TIER] [--prompt TEXT | --prompt-file FILE]
                    [--timeout SECONDS] [--no-fallback] [--json] [--quiet]
  ensync-agent plan [--cwd DIR] [--tools LEVEL] [--size TIER] [--refresh] [--json]

  --cwd DIR        Working directory for the agent (default: current directory)
  --tools LEVEL    read-only | workspace-write (default) | full-access
  --size TIER      small | medium | large | xl — Ensync's model size, mapped to each
                   provider's own reasoning effort. Providers keep their default model.
  --prompt-file -  Read the prompt from stdin (also the default when neither
                   --prompt nor --prompt-file is given)
  --refresh        Re-probe provider subscriptions instead of using cached status
  --local          Skip the running Ensync Host and probe providers in this process`

function fail(message, code = 2) {
  process.stderr.write(`ensync-agent: ${message}\n`)
  process.exit(code)
}

function parseArguments(argv) {
  const options = {
    command: argv[0] ?? '',
    cwd: process.cwd(),
    tools: 'workspace-write',
    size: null,
    prompt: null,
    promptFile: null,
    timeoutSeconds: null,
    fallback: true,
    json: false,
    quiet: false,
    refresh: false,
    local: false,
  }
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) fail(`${argument} needs a value`)
      index += 1
      return next
    }
    switch (argument) {
      case '--cwd': options.cwd = resolve(value()); break
      case '--tools': options.tools = value(); break
      case '--size': options.size = value(); break
      case '--prompt': options.prompt = value(); break
      case '--prompt-file': options.promptFile = value(); break
      case '--timeout': options.timeoutSeconds = Number(value()); break
      case '--no-fallback': options.fallback = false; break
      case '--json': options.json = true; break
      case '--quiet': options.quiet = true; break
      case '--refresh': options.refresh = true; break
      case '--local': options.local = true; break
      case '-h': case '--help': process.stdout.write(`${USAGE}\n`); process.exit(0); break
      default: fail(`unknown option ${argument}`)
    }
  }
  return options
}

/**
 * The connector runs Ensync's own modules rather than a copy of its rules, so it
 * has to find them: this checkout first, then an explicit override, then the
 * installed app — which ships host/ beside the daemon.
 */
async function loadEnsyncHostModules() {
  const candidates = [
    new URL('../host/', import.meta.url).href,
    process.env.ENSYNC_HOST_DIR ? pathToFileURL(join(process.env.ENSYNC_HOST_DIR, '/')).href : null,
    pathToFileURL('/Applications/Ensync.app/Contents/Resources/host/').href,
  ].filter(Boolean)
  let lastError = null
  for (const base of candidates) {
    try {
      const [connector, runner, providers] = await Promise.all([
        import(`${base}agent-connector.mjs`),
        import(`${base}agent-connector-run.mjs`),
        import(`${base}providers.mjs`),
      ])
      return { connector, runner, providers }
    } catch (error) {
      lastError = error
    }
  }
  fail(`could not load Ensync Host modules (${lastError?.message ?? 'unknown error'}). Set ENSYNC_HOST_DIR.`)
}

function userDataDirectory() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Ensync')
  if (process.platform === 'win32') return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Ensync')
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Ensync')
}

/** The running Host, or null when the app is closed and its daemon retired. */
async function discoverHostDaemon() {
  const explicit = process.env.ENSYNC_HOST_STATE_FILE
  const path = typeof explicit === 'string' && isAbsolute(explicit)
    ? explicit
    : join(userDataDirectory(), DAEMON_DESCRIPTOR_FILENAME)
  let descriptor
  try {
    descriptor = JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return null
  }
  if (!Number.isInteger(descriptor?.port) || typeof descriptor?.token !== 'string') return null
  const baseUrl = `http://127.0.0.1:${descriptor.port}`
  try {
    const health = await fetch(`${baseUrl}/api/health`, {
      headers: { Authorization: `Bearer ${descriptor.token}` },
      signal: AbortSignal.timeout(4_000),
    })
    if (!health.ok) return null
    const payload = await health.json()
    if (payload?.instanceId !== descriptor.instanceId) return null
  } catch {
    return null
  }
  return { baseUrl, token: descriptor.token }
}

async function daemonPlan(daemon, options, attempted = []) {
  const url = new URL('/api/agent-connector/plan', daemon.baseUrl)
  url.searchParams.set('cwd', options.cwd)
  url.searchParams.set('tools', options.tools)
  if (options.size) url.searchParams.set('size', options.size)
  if (options.refresh) url.searchParams.set('refresh', '1')
  if (attempted.length > 0) url.searchParams.set('attempted', attempted.join(','))
  const response = await fetch(url, { headers: { Authorization: `Bearer ${daemon.token}` } })
  const payload = await response.json().catch(() => null)
  if (response.ok) return { ok: true, plan: payload }
  // A rejected request is the caller's mistake; anything else means this Host
  // cannot answer connector routing (an older daemon still serving the app),
  // which is a reason to degrade rather than to refuse the run.
  if (response.status === 400) fail(payload?.error ?? 'the routing request was rejected.', 2)
  return { ok: false, status: response.status, error: payload?.error ?? null }
}

/**
 * No Host is running (the app is closed, or its daemon retired while idle), so
 * probe providers in this process with the same service the daemon uses. Only
 * the warm status cache is lost: the ranking still comes from the file the app
 * mirrors on every change, and selection still runs Ensync's algorithm.
 */
async function localPlan(modules, options, attempted = []) {
  const service = new modules.connector.AgentConnectorService({
    statusService: new modules.providers.ProviderStatusService(),
  })
  try {
    return await service.plan({
      refresh: options.refresh,
      attempted,
      toolLevel: options.tools,
      sizeTier: options.size,
      cwd: options.cwd,
    })
  } catch (error) {
    fail(error?.message ?? 'routing failed.', 2)
  }
}

/** Ask the running Host first; probe locally when it cannot answer. */
async function planFor(context, options, attempted = []) {
  if (context.daemon) {
    const result = await daemonPlan(context.daemon, options, attempted)
    if (result.ok) return result.plan
    context.daemon = null
    if (!options.quiet) {
      process.stderr.write(
        `ensync-agent: this Ensync Host does not answer connector routing (HTTP ${result.status}); probing providers locally.\n`,
      )
    }
  }
  return localPlan(context.modules, options, attempted)
}

async function readPrompt(options) {
  if (typeof options.prompt === 'string') return options.prompt
  if (options.promptFile && options.promptFile !== '-') return readFile(resolve(options.promptFile), 'utf8')
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function describePlan(plan) {
  const lines = [
    `order: ${plan.order.join(' -> ')} (${plan.orderSource === 'device' ? 'device preference' : 'default'})`,
    `tools: ${plan.toolLevel}${plan.effort ? ` · effort ${plan.effort}` : ''}`,
  ]
  for (const candidate of plan.sequence) {
    const usage = typeof candidate.usage === 'number' ? `${candidate.usage}% used` : 'usage unknown'
    lines.push(`  ${candidate.rank}. ${candidate.name} — ${usage} · ${candidate.invocation.containment}`)
  }
  for (const entry of plan.skipped) lines.push(`  -  ${entry.name} — ${entry.reason}`)
  return lines.join('\n')
}

async function main() {
  const options = parseArguments(process.argv.slice(2))
  if (!['run', 'plan'].includes(options.command)) {
    process.stderr.write(`${USAGE}\n`)
    process.exit(2)
  }
  const context = {
    modules: await loadEnsyncHostModules(),
    daemon: options.local ? null : await discoverHostDaemon(),
  }
  const plan = await planFor(context, options)

  if (options.command === 'plan') {
    process.stdout.write(options.json ? `${JSON.stringify(plan, null, 2)}\n` : `${describePlan(plan)}\n`)
    process.exit(plan.sequence.length > 0 ? 0 : 3)
  }

  const prompt = await readPrompt(options)
  if (!prompt.trim()) fail('the prompt is empty')
  if (plan.sequence.length === 0) {
    process.stderr.write(`ensync-agent: no provider has capacity for this run.\n${describePlan(plan)}\n`)
    process.exit(3)
  }
  if (!options.quiet && !options.json) {
    process.stderr.write(`ensync-agent: routing to ${plan.selected.name} (${plan.selected.invocation.containment})\n`)
  }

  try {
    const result = await context.modules.runner.runConnectorPlan(plan, {
      prompt,
      cwd: options.cwd,
      fallbackEnabled: options.fallback,
      hardTimeoutMs: Number.isFinite(options.timeoutSeconds) && options.timeoutSeconds > 0
        ? options.timeoutSeconds * 1_000
        : null,
      refreshPlan: options.fallback ? (attempted) => planFor(context, options, attempted) : undefined,
      onFallback: ({ from, to, code }) => {
        if (!options.quiet) process.stderr.write(`ensync-agent: ${from} -> ${to} after ${code}\n`)
      },
    })
    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
    } else {
      process.stdout.write(`${result.response}\n`)
      if (!options.quiet) {
        process.stderr.write(`ensync-agent: ${result.providerName}${result.model ? ` (${result.model})` : ''} finished in ${Math.round(result.durationMs / 1_000)}s\n`)
      }
    }
    process.exit(0)
  } catch (error) {
    const code = typeof error?.code === 'string' ? error.code : 'run_failed'
    process.stderr.write(`ensync-agent: ${code}: ${error?.message ?? 'the run failed.'}\n`)
    process.exit(4)
  }
}

await main()
