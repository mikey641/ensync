import { findExecutable, runProcess } from './command.mjs'
import { parseCodexAppServerProbe, probeCodexAppServer } from './codex-app-server.mjs'
import { probeClaudeUsage } from './claude-usage.mjs'
import { probeCopilotAuthentication } from './copilot-auth.mjs'
import { probeDroidAuthentication } from './droid-auth.mjs'
import { probeDroidLimits } from './droid-limits.mjs'
import { getInstallCommand, hasInstallCommand } from './provider-install.mjs'
import { probeMcpConfig } from './provider-mcp.mjs'
import { probeOllamaRuntime } from './ollama-runtime.mjs'
import { rankProvidersByAvailability } from './provider-availability.mjs'
import { ENSYNC_SUPERPOWERS_POLICY } from './multi-agent-prompt.mjs'

// Tie-breaker only. Live provider lists are ordered by real availability (see
// provider-availability.mjs); this order decides what happens when two
// providers are equally available, and what the list looks like before any
// usage has been probed. Broadly recognized subscription coding agents appear
// first, followed by progressively more specialist discovery candidates. Ollama
// stays last because it is a separate local runtime, not a subscription.
const providerNavigationOrder = [
  'droid',
  'codex',
  'claude',
  'copilot',
  'cursor',
  'antigravity',
  'jules',
  'kimi',
  'kiro',
  'junie',
  'gitlab_duo',
  'oz',
  'amp',
  'auggie',
  'qoder',
  'codebuddy',
  'ollama',
]

const providerDefinitions = [
  {
    id: 'claude',
    name: 'Claude Code',
    command: 'claude',
    versionArgs: ['--version'],
    loginArgs: ['auth', 'login'],
    updateArgs: ['update'],
    authentication: probeClaudeAuthentication,
    usageKind: 'subscription_quota',
    usageReason:
      'Claude Code did not return verified zero-cost subscription usage data.',
  },
  {
    id: 'codex',
    name: 'Codex',
    command: 'codex',
    versionArgs: ['--version'],
    loginArgs: ['login'],
    updateArgs: ['update'],
    authentication: probeCodexAuthentication,
    usageKind: 'subscription_quota',
    usageReason:
      'Codex app-server did not return ChatGPT rate-limit data for this account.',
  },
  {
    id: 'kimi',
    name: 'Kimi Code',
    command: 'kimi',
    versionArgs: ['--version'],
    loginArgs: ['login'],
    updateArgs: ['upgrade'],
    authentication: unsupportedAuthentication(
      'Kimi Code documents OAuth subscription login, but not a non-interactive account authentication-status command. Ensync will not inspect its credential files.',
    ),
    usageKind: 'subscription_quota',
    usageReason:
      'Kimi Code exposes subscription windows in its interactive usage view, but Ensync has not yet connected a verified non-consuming quota probe.',
  },
  {
    id: 'antigravity',
    name: 'Google Antigravity',
    command: 'agy',
    versionArgs: ['--version'],
    loginArgs: [],
    updateStrategy: 'provider_automatic',
    authentication: unsupportedAuthentication(
      'Antigravity uses Google browser sign-in on first launch, but does not document a non-interactive authentication-status command.',
    ),
    usageKind: 'subscription_quota',
    usageReason:
      'Antigravity exposes live model quotas and credits in its interactive /usage and /credits panels, but not through a stable machine-readable command Ensync can verify.',
  },
  {
    id: 'jules',
    name: 'Google Jules',
    command: 'jules',
    versionArgs: ['version'],
    loginArgs: ['login'],
    authentication: unsupportedAuthentication(
      'Jules documents Google account login, but not a non-interactive authentication-status command.',
    ),
    usageKind: 'subscription_quota',
    usageReason:
      'Jules publishes daily task and concurrency limits by plan, but Ensync has no verified machine-readable account-usage command.',
  },
  {
    id: 'copilot',
    name: 'GitHub Copilot CLI',
    command: 'copilot',
    versionArgs: ['version'],
    loginArgs: [],
    updateArgs: ['update'],
    authentication: probeCopilotAuthentication,
    usageKind: 'unavailable',
    usageReason:
      'Copilot account quota is not exposed by the verified authentication check.',
  },
  {
    id: 'cursor',
    name: 'Cursor Agent',
    command: 'agent',
    commandAliases: ['cursor-agent'],
    versionArgs: ['--version'],
    loginArgs: ['login'],
    updateArgs: ['update'],
    authentication: probeCursorAuthentication,
    usageKind: 'unavailable',
    usageReason:
      'Cursor Agent status does not expose usage percentage, model allowance, or reset time.',
  },
  {
    id: 'kiro',
    name: 'Kiro CLI',
    command: 'kiro-cli',
    versionArgs: ['--version'],
    loginArgs: ['login'],
    updateStrategy: 'provider_automatic',
    authentication: probeKiroAuthentication,
    usageKind: 'unavailable',
    usageReason:
      'Kiro CLI whoami reports account identity and session status, not a subscription-credit percentage or reset time.',
  },
  {
    id: 'qoder',
    name: 'Qoder CLI',
    command: 'qodercli',
    versionArgs: ['--version'],
    loginArgs: ['login'],
    updateArgs: ['update'],
    authentication: unsupportedAuthentication(
      'Qoder documents browser account login, but not a non-interactive authentication-status command.',
    ),
    usageKind: 'unavailable',
    usageReason:
      'Qoder subscription credits are available in Settings → Usage, not through a supported machine-readable CLI quota command.',
  },
  {
    id: 'codebuddy',
    name: 'CodeBuddy Code',
    command: 'codebuddy',
    commandAliases: ['cbc'],
    versionArgs: ['--version'],
    loginArgs: [],
    updateArgs: ['update'],
    authentication: unsupportedAuthentication(
      'CodeBuddy uses browser account sign-in during first-run onboarding, but does not document a non-interactive authentication-status command.',
    ),
    usageKind: 'unavailable',
    usageReason:
      'CodeBuddy subscription credits are available in its account Usage dashboard, not through a supported machine-readable CLI quota command.',
  },
  {
    id: 'droid',
    name: 'Factory Droid',
    command: 'droid',
    versionArgs: ['--version'],
    loginArgs: [],
    updateArgs: ['update'],
    authentication: probeDroidAuthentication,
    usageKind: 'subscription_quota',
    usageReason:
      'Factory Droid reports Standard usage only in its interactive /limits view. Ensync drives that view in a disposable PTY and strictly parses the panel; the capture could not be completed and verified on this machine, so remaining capacity is unknown.',
  },
  {
    id: 'auggie',
    name: 'Augment Auggie',
    command: 'auggie',
    versionArgs: ['--version'],
    loginArgs: ['login'],
    updateArgs: ['upgrade'],
    authentication: unsupportedAuthentication(
      'Auggie documents account login and account status, but Ensync has not yet tested a stable machine-readable authentication parser.',
    ),
    usageKind: 'subscription_quota',
    usageReason:
      'Auggie reports account billing and per-run credits, but Ensync has not verified a provider-wide included-credit percentage and reset contract.',
  },
  {
    id: 'amp',
    name: 'Amp',
    command: 'amp',
    versionArgs: ['--version'],
    loginArgs: ['login'],
    updateArgs: ['update'],
    authentication: unsupportedAuthentication(
      'Amp documents browser account login, but not a separate non-interactive authentication-status command.',
    ),
    usageKind: 'subscription_quota',
    usageReason:
      'Amp exposes an account balance through amp usage, but Ensync has not verified a stable included-allowance percentage and reset contract.',
  },
  {
    id: 'gitlab_duo',
    name: 'GitLab Duo CLI',
    command: 'duo',
    versionArgs: ['--version'],
    loginArgs: null,
    authentication: unsupportedAuthentication(
      'GitLab Duo reuses GitLab CLI or GitLab account credentials; Ensync does not launch a different executable or collect a PAT from the provider wizard.',
    ),
    usageKind: 'unavailable',
    usageReason:
      'GitLab Credits are available in the GitLab usage dashboard, not through a supported local Duo quota-percentage command.',
  },
  {
    id: 'oz',
    name: 'Warp Oz',
    command: 'oz',
    versionArgs: ['--version'],
    loginArgs: ['login'],
    authentication: unsupportedAuthentication(
      'Warp Oz documents browser account login, but not a non-interactive authentication-status command.',
    ),
    usageKind: 'subscription_quota',
    usageReason:
      'Warp plans use account credits for agent runs, but Oz does not document a stable machine-readable remaining-plan percentage command.',
  },
  {
    id: 'junie',
    name: 'Junie CLI',
    command: 'junie',
    versionArgs: ['--version'],
    loginArgs: [],
    updateStrategy: 'provider_automatic',
    authentication: unsupportedAuthentication(
      'Junie documents JetBrains Account sign-in inside its interactive welcome screen, but no non-interactive account status command.',
    ),
    usageKind: 'session_only',
    usageReason:
      'Junie does not document a non-interactive JetBrains AI subscription-credit status command.',
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    command: 'ollama',
    versionArgs: ['-v'],
    loginArgs: null,
    authentication: localRuntimeAuthentication,
    usageKind: 'local_runtime',
    usageReason:
      'Local Ollama models have no vendor subscription usage window. Ensync does not estimate hardware capacity or local model availability.',
  },
]

const providerNavigationRank = new Map(
  providerNavigationOrder.map((providerId, index) => [providerId, index]),
)
providerDefinitions.sort((left, right) =>
  (providerNavigationRank.get(left.id) ?? Number.MAX_SAFE_INTEGER)
    - (providerNavigationRank.get(right.id) ?? Number.MAX_SAFE_INTEGER),
)

const providerCatalog = {
  claude: {
    routeKind: 'subscription',
    chatExecution: 'supported',
    setupKind: 'login_command',
    documentationUrl: 'https://code.claude.com/docs/en/installation',
    catalogReason: 'Ensync Host has a tested structured Claude Code runner.',
  },
  codex: {
    routeKind: 'subscription',
    chatExecution: 'supported',
    setupKind: 'login_command',
    documentationUrl: 'https://developers.openai.com/codex/cli/',
    catalogReason: 'Ensync Host has a tested structured Codex runner.',
  },
  kimi: {
    routeKind: 'subscription',
    chatExecution: 'discovery_only',
    setupKind: 'login_command',
    documentationUrl: 'https://www.kimi.com/help/kimi-code/cli-getting-started',
    catalogReason: 'Discovery and OAuth login are wired, but Ensync will not run Kimi until its ACP runner, quota probe, and paid Extra Usage guard are tested.',
  },
  antigravity: {
    routeKind: 'subscription',
    chatExecution: 'discovery_only',
    setupKind: 'interactive_onboarding',
    documentationUrl: 'https://antigravity.google/docs/cli/install',
    catalogReason: 'Google account onboarding is wired, but Ensync does not yet have a tested Antigravity event runner or machine-readable quota adapter.',
  },
  jules: {
    routeKind: 'subscription',
    chatExecution: 'discovery_only',
    setupKind: 'login_command',
    documentationUrl: 'https://jules.google/docs/cli/reference/',
    catalogReason: 'Jules uses Google AI plan cloud sessions rather than the local worktree subprocess contract; execution and usage routing are not enabled.',
  },
  copilot: {
    routeKind: 'subscription',
    chatExecution: 'discovery_only',
    setupKind: 'interactive_onboarding',
    documentationUrl: 'https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/install-copilot-cli',
    catalogReason: 'Account verification is supported. Ensync task execution and automatic fallback are not enabled yet.',
  },
  cursor: {
    routeKind: 'subscription',
    chatExecution: 'supported',
    setupKind: 'login_command',
    documentationUrl: 'https://docs.cursor.com/en/cli/installation',
    catalogReason: 'Chat runs headless through `--print --output-format stream-json` with the prompt on stdin and the stored Cursor login, and a turn counts as finished only when the CLI emits its terminal success result. Containment is the pinned `--sandbox enabled` OS sandbox, which a headless run refuses to start without. Verified against cursor-agent 2026.08.04 from its own bundled sources; no live end-to-end run was observed, because this machine reports the CLI as signed out.',
  },
  kiro: {
    routeKind: 'subscription',
    chatExecution: 'discovery_only',
    setupKind: 'login_command',
    documentationUrl: 'https://kiro.dev/docs/cli/installation/',
    catalogReason: 'Discovery and account status are wired, but Ensync Host does not yet have a tested Kiro event runner.',
  },
  qoder: {
    routeKind: 'subscription',
    chatExecution: 'discovery_only',
    setupKind: 'login_command',
    documentationUrl: 'https://docs.qoder.com/en/cli/quick-start',
    catalogReason: 'Discovery and browser login are wired, but Ensync does not yet have a tested Qoder event runner or CLI quota adapter.',
  },
  codebuddy: {
    routeKind: 'subscription',
    chatExecution: 'discovery_only',
    setupKind: 'interactive_onboarding',
    documentationUrl: 'https://www.codebuddy.ai/docs/cli/quickstart',
    catalogReason: 'Ensync has a complete CodeBuddy runner (stdin prompt, stream-json result event, permission mode and cwd verified from the session init echo before the prompt is sent), but CodeBuddy is not signed in on this machine, so no authenticated turn has been verified — in particular whether a headless permission request is denied rather than left waiting. Chat stays gated until it is. No CLI quota adapter exists; credits live in the web dashboard.',
  },
  droid: {
    routeKind: 'subscription',
    chatExecution: 'supported',
    setupKind: 'interactive_onboarding',
    documentationUrl: 'https://docs.factory.ai/cli/getting-started/quickstart',
    catalogReason: 'Chat runs through the droid exec stream-jsonrpc session runner with the stored browser login. Usage comes from the TUI /limits panel, driven in a disposable PTY and strictly parsed (verified against droid 0.191.1); an unverifiable capture degrades to honest-unknown capacity.',
  },
  auggie: {
    routeKind: 'subscription',
    chatExecution: 'discovery_only',
    setupKind: 'login_command',
    documentationUrl: 'https://docs.augmentcode.com/cli/setup-auggie/install-auggie-cli',
    catalogReason: 'Ensync has a complete Auggie runner (prompt on stdin in --print mode, a single terminal type:"result" object, and per-tool deny rules pinned with --permission), but Auggie is not signed in on this machine, so no authenticated turn has been verified — in particular whether a denied tool in a headless run is refused and reported rather than left waiting. Chat stays gated until it is. No provider-wide quota adapter exists; credits live in auggie account status and per-session stats.',
  },
  amp: {
    routeKind: 'subscription',
    chatExecution: 'discovery_only',
    setupKind: 'login_command',
    documentationUrl: 'https://ampcode.com/manual',
    catalogReason: 'Discovery and account login are wired, but the Amp binary produces no output at all on this machine — even amp --version blocks indefinitely — so no runner could be verified. Amp is also not signed in, and its own log shows an unauthenticated run opening a browser login and blocking for five minutes before failing, so Ensync will not launch it. No paid-credit guard exists either.',
  },
  gitlab_duo: {
    routeKind: 'subscription',
    chatExecution: 'discovery_only',
    setupKind: 'interactive_onboarding',
    documentationUrl: 'https://docs.gitlab.com/user/gitlab_duo_cli/set_up/',
    catalogReason: 'Discovery is wired, but setup depends on an eligible GitLab namespace and existing GitLab authentication; no chat or quota adapter is enabled.',
  },
  oz: {
    routeKind: 'subscription',
    chatExecution: 'discovery_only',
    setupKind: 'login_command',
    documentationUrl: 'https://docs.warp.dev/reference/cli',
    catalogReason: 'Discovery and browser login are wired, but Oz can only take a prompt as a command-line argument or a server-stored prompt ID, publishes no terminal event for its ndjson stream, and expresses agent permissions only as Warp-synced execution profiles that no run flag can pin — so Ensync has no runner, quota adapter, or paid-credit guard.',
  },
  junie: {
    routeKind: 'subscription',
    chatExecution: 'discovery_only',
    setupKind: 'interactive_onboarding',
    documentationUrl: 'https://junie.jetbrains.com/docs/junie-cli.html',
    catalogReason: 'Ensync can open Junie onboarding, but cannot verify account status or execute Junie chats yet.',
  },
  ollama: {
    routeKind: 'local',
    chatExecution: 'discovery_only',
    setupKind: 'none',
    documentationUrl: 'https://ollama.com/download',
    catalogReason: 'Ensync detects the local runtime and reports server reachability plus installed models. Ollama is an inference server rather than a coding agent — it cannot read or write files, run commands, or hold a session — so it is not a chat provider and is not gated pending work; local model discovery is the whole supported surface.',
  },
}

const providerIds = new Set(providerDefinitions.map((provider) => provider.id))
const universalAgentCoordination = Object.freeze({
  policy: ENSYNC_SUPERPOWERS_POLICY,
  delivery: 'ensync_prompt',
  nativePlugin: 'optional',
})

function providerCatalogEntry(id) {
  return {
    ...providerCatalog[id],
    agentCoordination: universalAgentCoordination,
  }
}

function now() {
  return new Date().toISOString()
}

function unavailableAuthentication(reason, checkedAt) {
  return {
    state: 'unavailable',
    method: null,
    reason,
    source: 'cli',
    checkedAt,
  }
}

function unsupportedAuthentication(reason) {
  return async (_executable, checkedAt) => ({
    state: 'unknown',
    method: null,
    reason,
    source: 'cli',
    checkedAt,
    exactPlan: null,
  })
}

async function localRuntimeAuthentication(_executable, checkedAt) {
  return {
    state: 'not_required',
    method: 'Local runtime',
    reason: 'Ollama is a local runtime and does not require a subscription login.',
    source: 'cli',
    checkedAt,
    exactPlan: null,
  }
}

function combinedOutput(result) {
  return [result.stdout, result.stderr].filter(Boolean).join('\n')
}

function providerUpdateStrategy(provider) {
  if (Array.isArray(provider.updateArgs)) return 'ensync_command'
  return provider.updateStrategy ?? 'official_guide'
}

function providerUpdateReason(provider, installed) {
  const strategy = providerUpdateStrategy(provider)
  if (strategy === 'ensync_command') {
    return installed
      ? `${provider.name} provides a verified self-update command. The CLI remains authoritative for its install method, release channel, and result.`
      : `Install ${provider.name} before running its official self-update command.`
  }
  if (strategy === 'provider_automatic') {
    return installed
      ? `${provider.name} checks for and applies CLI updates through its own automatic updater. Ensync includes it in update reviews without starting an agent session.`
      : `Install ${provider.name} to use its provider-managed automatic updater.`
  }
  return installed
    ? `${provider.name} updates depend on its installation method or operating system. Use the official installation and update guide.`
    : `Install ${provider.name} from its official installation and update guide.`
}

function extractJsonObject(value) {
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start === -1 || end <= start) return null

  try {
    return JSON.parse(value.slice(start, end + 1))
  } catch {
    return null
  }
}

export function parseCodexAuthentication(result, checkedAt = now()) {
  const output = combinedOutput(result)
  const lower = output.toLowerCase()

  if (result.timedOut || result.error) {
    return unavailableAuthentication(
      result.timedOut ? 'Codex login status timed out.' : 'Codex login status could not be started.',
      checkedAt,
    )
  }
  if (result.exitCode === 0 && lower.includes('logged in')) {
    return {
      state: 'authenticated',
      method: lower.includes('chatgpt') ? 'ChatGPT login' : 'CLI login',
      reason: 'Codex CLI reports an active login.',
      source: 'cli',
      checkedAt,
      exactPlan: null,
    }
  }
  if (lower.includes('not logged in') || lower.includes('not authenticated')) {
    return {
      state: 'not_authenticated',
      method: null,
      reason: 'Codex CLI reports that it is not logged in.',
      source: 'cli',
      checkedAt,
      exactPlan: null,
    }
  }
  return unavailableAuthentication('Codex returned no recognized authentication status.', checkedAt)
}

async function probeCodexAuthentication(executable, checkedAt) {
  return parseCodexAuthentication(await runProcess(executable, ['login', 'status']), checkedAt)
}

export function parseClaudeAuthentication(result, checkedAt = now()) {
  if (result.timedOut || result.error) {
    return unavailableAuthentication(
      result.timedOut ? 'Claude auth status timed out.' : 'Claude auth status could not be started.',
      checkedAt,
    )
  }

  const parsed = extractJsonObject(combinedOutput(result))
  if (parsed && typeof parsed.loggedIn === 'boolean') {
    const exactPlan =
      typeof parsed.subscriptionType === 'string' && parsed.subscriptionType.trim()
        ? parsed.subscriptionType.trim()
        : null
    return {
      state: parsed.loggedIn ? 'authenticated' : 'not_authenticated',
      method:
        parsed.loggedIn && typeof parsed.authMethod === 'string' ? parsed.authMethod : null,
      reason: parsed.loggedIn
        ? 'Claude Code reports an active login.'
        : 'Claude Code reports that it is not logged in.',
      source: 'cli',
      checkedAt,
      exactPlan,
    }
  }

  return unavailableAuthentication('Claude Code returned no recognized authentication status.', checkedAt)
}

async function probeClaudeAuthentication(executable, checkedAt) {
  return parseClaudeAuthentication(
    await runProcess(executable, ['auth', 'status', '--json']),
    checkedAt,
  )
}

export function parseCursorAuthentication(result, checkedAt = now()) {
  const lower = combinedOutput(result).toLowerCase()
  if (result.timedOut || result.error) {
    return unavailableAuthentication(
      result.timedOut ? 'Cursor Agent status timed out.' : 'Cursor Agent status could not be started.',
      checkedAt,
    )
  }
  if (lower.includes('not authenticated') || lower.includes('not logged in')) {
    return {
      state: 'not_authenticated',
      method: null,
      reason: 'Cursor Agent reports that it is not logged in.',
      source: 'cli',
      checkedAt,
      exactPlan: null,
    }
  }
  if (result.exitCode === 0 && (lower.includes('authenticated') || lower.includes('logged in'))) {
    return {
      state: 'authenticated',
      method: 'Cursor login',
      reason: 'Cursor Agent reports an active login.',
      source: 'cli',
      checkedAt,
      exactPlan: null,
    }
  }
  return unavailableAuthentication('Cursor Agent returned no recognized authentication status.', checkedAt)
}

async function probeCursorAuthentication(executable, checkedAt) {
  return parseCursorAuthentication(await runProcess(executable, ['status']), checkedAt)
}

export function parseKiroAuthentication(result, checkedAt = now()) {
  if (result.timedOut || result.error) {
    return unavailableAuthentication(
      result.timedOut ? 'Kiro whoami timed out.' : 'Kiro whoami could not be started.',
      checkedAt,
    )
  }

  const parsed = extractJsonObject(combinedOutput(result))
  if (parsed && !Array.isArray(parsed) && Object.hasOwn(parsed, 'account') && parsed.account === null) {
    return {
      state: 'not_authenticated',
      method: null,
      reason: 'Kiro CLI reports that no account is logged in.',
      source: 'cli',
      checkedAt,
      exactPlan: null,
    }
  }
  if (result.exitCode === 0 && parsed && !Array.isArray(parsed)) {
    return {
      state: 'authenticated',
      method: 'Kiro account login',
      reason: 'Kiro CLI whoami returned an authenticated account.',
      source: 'cli',
      checkedAt,
      exactPlan: null,
    }
  }

  const lower = combinedOutput(result).toLowerCase()
  if (lower.includes('not logged in') || lower.includes('not authenticated') || lower.includes('login required')) {
    return {
      state: 'not_authenticated',
      method: null,
      reason: 'Kiro CLI reports that it is not logged in.',
      source: 'cli',
      checkedAt,
      exactPlan: null,
    }
  }
  return unavailableAuthentication('Kiro CLI returned no recognized whoami status.', checkedAt)
}

async function probeKiroAuthentication(executable, checkedAt) {
  return parseKiroAuthentication(
    await runProcess(executable, ['whoami', '--format', 'json']),
    checkedAt,
  )
}

function connectionState(installed, authentication) {
  if (!installed) return 'unavailable'
  if (authentication.state === 'authenticated' || authentication.state === 'not_required') return 'ready'
  if (authentication.state === 'not_authenticated') return 'needs_authentication'
  if (authentication.state === 'unknown') return 'installed_unverified'
  return 'checking_failed'
}

function usageFor(provider, authentication, checkedAt) {
  const exactPlan = authentication.exactPlan ?? null
  return {
    availability: exactPlan ? 'partial' : 'unavailable',
    source: exactPlan ? 'cli' : 'unavailable',
    kind: provider.usageKind,
    plan: exactPlan,
    model: null,
    usedPercent: null,
    remainingPercent: null,
    resetAt: null,
    checkedAt,
    details: [],
    reason: provider.usageReason,
  }
}

async function inspectProvider(provider) {
  const checkedAt = now()
  const commandCandidates = [provider.command, ...(provider.commandAliases ?? [])]
  let executable = null
  let detectedCommand = provider.command
  for (const command of commandCandidates) {
    executable = await findExecutable(command)
    if (executable) {
      detectedCommand = command
      break
    }
  }
  const catalog = providerCatalogEntry(provider.id)

  if (!executable) {
    const authentication = unavailableAuthentication(
      `${commandCandidates.join(' or ')} was not found on PATH.`,
      checkedAt,
    )
    const installCommand = hasInstallCommand(provider.id)
      ? getInstallCommand(provider.id)
      : null
    const mcp = await probeMcpConfig(provider.id)
    return {
      id: provider.id,
      name: provider.name,
      command: provider.command,
      installed: false,
      executable: null,
      mcp,
      version: null,
      connectionState: 'unavailable',
      authentication,
      usage: usageFor(provider, authentication, checkedAt),
      availableModels: [],
      canConnect: false,
      connectReason: `Install ${provider.name} and make ${commandCandidates.join(' or ')} available on PATH.`,
      canInstall: hasInstallCommand(provider.id),
      installCommand,
      canUpdate: false,
      updateStrategy: providerUpdateStrategy(provider),
      updateReason: providerUpdateReason(provider, false),
      ...catalog,
      checkedAt,
    }
  }

  const [versionResult, authentication] = await Promise.all([
    runProcess(executable, provider.versionArgs),
    provider.authentication(executable, checkedAt),
  ])
  const codexAppServerResult = provider.id === 'codex' && authentication.state === 'authenticated'
    ? await probeCodexAppServer(executable)
    : null
  const codexProbe = codexAppServerResult
    ? parseCodexAppServerProbe(codexAppServerResult.responses, checkedAt)
    : null
  const claudeUsage = provider.id === 'claude' && authentication.state === 'authenticated'
    ? await probeClaudeUsage(executable, checkedAt, authentication.exactPlan ?? null)
    : null
  const droidLimits = provider.id === 'droid' && authentication.state === 'authenticated'
    ? await probeDroidLimits(executable, checkedAt)
    : null
  const ollamaProbe = provider.id === 'ollama'
    ? await probeOllamaRuntime(executable, checkedAt)
    : null
  const versionOutput = combinedOutput(versionResult).split('\n')[0]?.trim()
  const version = versionResult.exitCode === 0 && versionOutput ? versionOutput : null
  const mcp = await probeMcpConfig(provider.id)

  return {
    id: provider.id,
    name: provider.name,
    mcp,
    command: detectedCommand,
    installed: true,
    executable,
    version,
    connectionState: connectionState(true, authentication),
    authentication,
    usage: codexProbe?.usage ?? claudeUsage ?? droidLimits ?? ollamaProbe?.usage ?? usageFor(provider, authentication, checkedAt),
    availableModels: codexProbe?.models ?? ollamaProbe?.models ?? [],
    canConnect: Array.isArray(provider.loginArgs),
    connectReason: Array.isArray(provider.loginArgs)
      ? null
      : catalog.setupKind === 'none'
        ? `${provider.name} does not require an account login.`
        : `${provider.name} does not provide a provider-neutral subscription login command.`,
    canInstall: hasInstallCommand(provider.id),
    installCommand: hasInstallCommand(provider.id)
      ? getInstallCommand(provider.id)
      : null,
    canUpdate: Array.isArray(provider.updateArgs),
    updateStrategy: providerUpdateStrategy(provider),
    updateReason: providerUpdateReason(provider, true),
    ...catalog,
    checkedAt,
  }
}

export function isProviderId(value) {
  return providerIds.has(value)
}

export function getProviderDefinition(id) {
  return providerDefinitions.find((provider) => provider.id === id) ?? null
}

export function getProviderCatalog() {
  return providerDefinitions.map((provider) => ({
    id: provider.id,
    name: provider.name,
    ...providerCatalogEntry(provider.id),
  }))
}

// A usage probe drives a real CLI, so it can lose a race it has no stake in: a
// busy machine, a manual refresh landing on a scheduled one, a CLI that dies on
// startup. Discarding a percentage the CLI already verified because the *next*
// read failed tells the person their quota is unknown when Ensync knows it, and
// the card visibly flips between a number and "quota unavailable".
//
// A verified reading is therefore kept across a failed refresh, but never
// laundered as fresh: it keeps the checkedAt of the read that produced it, says
// so in its reason, and carries stale: true. It is dropped as soon as it stops
// being evidence — the account logged out, the CLI disappeared, or the reading
// aged past the retention window — because a frozen percentage would be a
// worse lie than an honest blank.
const VERIFIED_USAGE_RETENTION_MS = 30 * 60_000

function isVerifiedUsage(usage) {
  return usage?.source === 'cli' && typeof usage.usedPercent === 'number'
}

// Only the state that made the old reading true. A percentage captured while
// authenticated says nothing about a provider that has since logged out.
function usageEvidenceKey(provider) {
  return `${provider?.installed === true ? 'installed' : 'absent'}:${provider?.authentication?.state ?? 'unknown'}`
}

function retainedUsage(usage) {
  return {
    ...usage,
    stale: true,
    reason: `${usage.reason} This refresh's quota probe returned nothing, so Ensync kept the last verified reading rather than blanking it; it was measured at ${usage.checkedAt}.`,
  }
}

export class ProviderStatusService {
  #cache = null
  #cacheDurationMs
  #definitions
  #inspect
  #inFlight = null
  #invalidatedWhileRefreshing = false
  #verifiedUsage = new Map()
  #verifiedUsageRetentionMs
  #now

  constructor(options = {}) {
    this.#cacheDurationMs = options.cacheDurationMs ?? 60_000
    this.#definitions = options.definitions ?? providerDefinitions
    this.#inspect = options.inspectProvider ?? inspectProvider
    this.#verifiedUsageRetentionMs = options.verifiedUsageRetentionMs ?? VERIFIED_USAGE_RETENTION_MS
    this.#now = options.now ?? (() => Date.now())
  }

  #keepVerifiedUsage(providers) {
    const currentMs = this.#now()
    return providers.map((provider) => {
      const evidenceKey = usageEvidenceKey(provider)
      if (isVerifiedUsage(provider?.usage)) {
        this.#verifiedUsage.set(provider.id, { usage: provider.usage, evidenceKey, capturedAtMs: currentMs })
        return provider
      }
      const retained = this.#verifiedUsage.get(provider?.id)
      if (!retained) return provider
      if (retained.evidenceKey !== evidenceKey
        || currentMs - retained.capturedAtMs > this.#verifiedUsageRetentionMs) {
        this.#verifiedUsage.delete(provider.id)
        return provider
      }
      return { ...provider, usage: retainedUsage(retained.usage) }
    })
  }

  async list(options = {}) {
    const cacheValid =
      this.#cache && Date.now() - this.#cache.createdAt < this.#cacheDurationMs

    if (this.#inFlight) return this.#inFlight
    if (!options.refresh && cacheValid) return this.#cache.providers

    this.#inFlight = this.#refreshUntilCurrent()
    try {
      return await this.#inFlight
    } finally {
      this.#inFlight = null
    }
  }

  async #refreshUntilCurrent() {
    let providers
    do {
      this.#invalidatedWhileRefreshing = false
      providers = await Promise.all(this.#definitions.map((provider) => this.#inspect(provider)))
    } while (this.#invalidatedWhileRefreshing)

    // Retention runs before ranking so a provider whose probe lost a race keeps
    // its place in the list instead of sinking to "capacity unknown".
    const ranked = rankProvidersByAvailability(this.#keepVerifiedUsage(providers), providerNavigationOrder)
    this.#cache = { createdAt: Date.now(), providers: ranked }
    return ranked
  }

  async get(id, options = {}) {
    if (!isProviderId(id)) return null
    const providers = await this.list(options)
    return providers.find((provider) => provider.id === id) ?? null
  }

  invalidate() {
    this.#cache = null
    if (this.#inFlight) this.#invalidatedWhileRefreshing = true
  }
}
