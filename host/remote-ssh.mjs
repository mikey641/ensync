import { stat, realpath } from 'node:fs/promises'
import { isIP } from 'node:net'
import { isAbsolute, posix, win32 } from 'node:path'
import {
  parseClaudeChatResult,
  parseCodexChatResult,
  quotaFailureIsSafe,
} from './chat.mjs'
import { describeProcessExit, findExecutable, runProcess, subscriptionEnvironment } from './command.mjs'
import {
  createRemoteBridgeInput,
  decodeRemoteBridgeEnvelope,
} from './remote-ssh-bridge.mjs'

const DEFAULT_SSH_TIMEOUT_MS = 30_000
const DEFAULT_CHAT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000
const CHAT_TRANSPORT_TIMEOUT_GRACE_MS = 30_000
const MAX_CHAT_TIMEOUT_MS = 10 * 60 * 1_000
const MAX_PROMPT_LENGTH = 100_000
const MAX_BRIDGE_CAPTURE_BYTES = 12 * 1024 * 1024
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/
const MODEL_EFFORTS = new Set(['low', 'medium', 'high', 'max'])
const USERNAME_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]{0,63}$/
const HOST_LABEL_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/
const CONTROL_CHARACTER_PATTERN = /[\u0000-\u001f\u007f]/

export class RemoteSshError extends Error {
  constructor(code, message, status = 400, safeToRetry = false) {
    super(message)
    this.name = 'RemoteSshError'
    this.code = code
    this.status = status
    this.safeToRetry = safeToRetry
  }
}

function requirePlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RemoteSshError('invalid_request', `${label} must be a JSON object.`)
  }
}

export function validateSshHostname(value) {
  if (typeof value !== 'string' || !value || value.length > 253 || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new RemoteSshError('invalid_ssh_hostname', 'Enter a valid SSH hostname or IP address.')
  }
  if (value !== value.trim() || value.includes('@') || value.includes('/') || value.includes('\\')) {
    throw new RemoteSshError('invalid_ssh_hostname', 'Enter the hostname or IP address without a username or path.')
  }
  if (isIP(value)) return value
  const hostname = value.endsWith('.') ? value.slice(0, -1) : value
  if (!hostname || !hostname.split('.').every((label) => HOST_LABEL_PATTERN.test(label))) {
    throw new RemoteSshError('invalid_ssh_hostname', 'Enter a valid DNS hostname or IP address.')
  }
  return hostname.toLowerCase()
}

export function validateSshUsername(value) {
  if (typeof value !== 'string' || !USERNAME_PATTERN.test(value)) {
    throw new RemoteSshError(
      'invalid_ssh_username',
      'The SSH username may contain letters, numbers, underscores, dots, and hyphens.',
    )
  }
  return value
}

export function validateSshPort(value) {
  if (!Number.isInteger(value) || value < 1 || value > 65_535) {
    throw new RemoteSshError('invalid_ssh_port', 'The SSH port must be an integer from 1 to 65535.')
  }
  return value
}

export function validateRemoteProjectPath(value) {
  if (
    typeof value !== 'string'
    || !value
    || value.length > 4_096
    || value !== value.trim()
    || CONTROL_CHARACTER_PATTERN.test(value)
  ) {
    throw new RemoteSshError('invalid_remote_project', 'Enter a valid absolute remote project path.')
  }
  const pathFlavor = posix.isAbsolute(value) ? posix : win32.isAbsolute(value) ? win32 : null
  if (!pathFlavor) {
    throw new RemoteSshError('invalid_remote_project', 'The remote project path must be absolute.')
  }
  const parsed = pathFlavor.parse(value)
  if (pathFlavor.normalize(value) === parsed.root) {
    throw new RemoteSshError('invalid_remote_project', 'A remote filesystem root cannot be an Ensync project.')
  }
  const pathParts = value.slice(parsed.root.length).split(/[\\/]+/)
  if (pathParts.some((part) => part === '.' || part === '..')) {
    throw new RemoteSshError('invalid_remote_project', 'The remote project path cannot contain . or .. segments.')
  }
  return value
}

async function validateIdentityFile(value) {
  if (value == null || value === '') return null
  if (typeof value !== 'string' || value !== value.trim() || CONTROL_CHARACTER_PATTERN.test(value)) {
    throw new RemoteSshError('invalid_identity_file', 'Enter a valid absolute SSH identity-file path.')
  }
  if (!isAbsolute(value)) {
    throw new RemoteSshError('invalid_identity_file', 'The SSH identity-file path must be absolute.')
  }
  try {
    const canonicalPath = await realpath(value)
    const info = await stat(canonicalPath)
    if (!info.isFile()) throw new Error('not a file')
    return canonicalPath
  } catch {
    throw new RemoteSshError(
      'invalid_identity_file',
      'The SSH identity file does not exist, is not a file, or cannot be accessed.',
    )
  }
}

export async function validateRemoteSshConnection(input) {
  requirePlainObject(input, 'The SSH connection')
  if (input.password || input.privateKey || input.keyPassphrase || input.token) {
    throw new RemoteSshError(
      'credentials_not_supported',
      'Ensync does not accept SSH passwords, private-key contents, passphrases, or tokens. Use ssh-agent or an existing identity-file path.',
    )
  }
  return {
    hostname: validateSshHostname(input.hostname),
    username: validateSshUsername(input.username),
    port: validateSshPort(input.port),
    identityFile: await validateIdentityFile(input.identityFile),
    projectPath: validateRemoteProjectPath(input.projectPath),
  }
}

export async function discoverSshExecutable(options = {}) {
  return findExecutable('ssh', options)
}

export function buildSshArguments(connection, remoteCommand = ['node', '-']) {
  const args = [
    '-T',
    '-F', 'none',
    '-a',
    '-x',
    '-o', 'BatchMode=yes',
    '-o', 'NumberOfPasswordPrompts=0',
    '-o', 'PasswordAuthentication=no',
    '-o', 'KbdInteractiveAuthentication=no',
    '-o', 'PreferredAuthentications=publickey',
    '-o', 'StrictHostKeyChecking=yes',
    '-o', 'CheckHostIP=yes',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'PermitLocalCommand=no',
    '-o', 'ConnectTimeout=10',
    '-o', 'ConnectionAttempts=1',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=2',
    '-p', String(connection.port),
    '-l', connection.username,
  ]
  if (connection.identityFile) args.push('-o', 'IdentitiesOnly=yes', '-i', connection.identityFile)
  args.push(connection.hostname, ...remoteCommand)
  return args
}

function scrubDiagnostic(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  return value
    .replace(/[\r\n]+/g, ' ')
    .replace(/((?:token|password|passphrase|secret|api[_-]?key)\s*[:=])\s*\S+/gi, '$1[redacted]')
    .slice(0, 400)
}

function remoteNodeUnavailable(result) {
  const diagnostic = `${result.stdout || ''}\n${result.stderr || ''}`
  return [126, 127].includes(result.exitCode)
    || /(?:node(?:\.exe)?[^\n]*(?:not found|not recognized|cannot find)|command not found[^\n]*node)/i.test(diagnostic)
}

function targetMetadata(connection) {
  return {
    hostname: connection.hostname,
    username: connection.username,
    port: connection.port,
    projectPath: connection.projectPath,
    identityMode: connection.identityFile ? 'identity_file' : 'ssh_agent_or_default_identity',
  }
}

export class RemoteSshProcessAdapter {
  #processRunner
  #sshFinder
  #environment

  constructor(options = {}) {
    this.#processRunner = options.processRunner ?? runProcess
    this.#sshFinder = options.sshFinder ?? discoverSshExecutable
    this.#environment = options.environment ?? process.env
  }

  async execute(connection, payload, options = {}) {
    const sshExecutable = await this.#sshFinder()
    if (!sshExecutable) {
      throw new RemoteSshError(
        'ssh_unavailable',
        'OpenSSH client was not found on this computer. Install or enable ssh and try again.',
        409,
        true,
      )
    }
    const timeoutMs = options.timeoutMs ?? DEFAULT_SSH_TIMEOUT_MS
    const hardTimeoutMs = Object.hasOwn(options, 'hardTimeoutMs')
      ? options.hardTimeoutMs
      : timeoutMs
    const result = await this.#processRunner(
      sshExecutable,
      buildSshArguments(connection),
      {
        env: subscriptionEnvironment(this.#environment),
        input: createRemoteBridgeInput(payload),
        timeoutMs,
        ...(options.inactivityTimeoutMs == null
          ? {}
          : { inactivityTimeoutMs: options.inactivityTimeoutMs }),
        hardTimeoutMs,
        maxCaptureBytes: MAX_BRIDGE_CAPTURE_BYTES,
        signal: options.signal,
      },
    )

    if (result.aborted || options.signal?.aborted) {
      throw new RemoteSshError(
        'run_cancelled',
        'Run stopped by user. The SSH process and its remote command were terminated.',
        499,
        false,
      )
    }
    if (result.timedOut) {
      const message = result.timeoutReason === 'inactivity'
        ? 'The SSH transport produced no verified bridge progress before its inactivity limit and was stopped. The remote project may contain partial work; review it before retrying.'
        : result.timeoutReason === 'hard_limit'
          ? 'The SSH transport reached an explicit run limit and was stopped. The remote project may contain partial work; review it before retrying.'
          : 'The SSH operation reached a run limit and was stopped. The remote project may contain partial work; review it before retrying.'
      throw new RemoteSshError('ssh_timed_out', message, 504)
    }
    if (result.error) {
      throw new RemoteSshError('ssh_start_failed', 'OpenSSH could not be started.', 502, true)
    }
    const envelope = decodeRemoteBridgeEnvelope(result.stdout)
    return { sshExecutable, process: result, envelope }
  }
}

function bridgeFailure(envelope) {
  const code = typeof envelope?.error?.code === 'string'
    ? envelope.error.code
    : 'remote_bridge_failed'
  const safeCodes = new Set([
    'provider_unavailable',
    'provider_not_authenticated',
    'subscription_auth_required',
  ])
  const clientMessages = {
    invalid_remote_project: 'The remote project folder does not exist or cannot be accessed.',
    provider_unavailable: 'The requested provider is not available on the remote machine.',
    provider_not_authenticated: 'The requested provider is not authenticated on the remote machine.',
    subscription_auth_required: 'The remote provider is not using a verified subscription login.',
    unsupported_provider: 'Remote chat supports Codex and Claude Code only.',
    project_isolation_required: 'Remote agent execution requires a verified Git working tree and directly runnable Git installation.',
    project_baseline_unavailable: 'Create an initial remote Git commit before starting an isolated Ensync workspace.',
    shared_checkout_snapshot_failed: 'Git could not safely copy the remote shared checkout into a protected Ensync workspace. The shared checkout was left unchanged.',
    managed_worktree_missing: 'The protected remote Ensync worktree is missing or inaccessible.',
    managed_worktree_mismatch: 'The protected remote Ensync worktree no longer matches its registered branch or repository.',
    managed_worktree_create_failed: 'Git could not create the protected remote Ensync worktree.',
    managed_project_missing: 'The selected project directory is missing from its protected remote worktree.',
  }
  return new RemoteSshError(
    code,
    clientMessages[code] ?? 'The remote Ensync bridge failed.',
    code === 'invalid_remote_project' ? 400 : 409,
    safeCodes.has(code),
  )
}

function parseRemoteChat(provider, stdout) {
  return provider === 'codex' ? parseCodexChatResult(stdout) : parseClaudeChatResult(stdout)
}

function publicProbeResult(result) {
  const git = result?.git && typeof result.git === 'object'
    ? {
        installed: result.git.installed === true,
        executable: typeof result.git.executable === 'string' ? result.git.executable : null,
        version: typeof result.git.version === 'string' ? result.git.version : null,
      }
    : { installed: false, executable: null, version: null }
  const providers = Array.isArray(result?.providers)
    ? result.providers.map((provider) => {
        const authentication = provider.authentication && typeof provider.authentication === 'object'
          ? {
              state: ['authenticated', 'not_authenticated', 'unavailable'].includes(provider.authentication.state)
                ? provider.authentication.state
                : 'unavailable',
              method: typeof provider.authentication.method === 'string'
                ? provider.authentication.method.slice(0, 128)
                : null,
              reason: typeof provider.authentication.reason === 'string'
                ? provider.authentication.reason.slice(0, 400)
                : 'The remote authentication status is unavailable.',
              ...(typeof provider.authentication.exactPlan === 'string'
                ? { exactPlan: provider.authentication.exactPlan.slice(0, 128) }
                : {}),
            }
          : null
        return {
          id: provider.id,
          installed: provider.installed === true,
          command: typeof provider.command === 'string' ? provider.command : '',
          executable: typeof provider.executable === 'string' ? provider.executable : null,
          directlyRunnable: provider.directlyRunnable === true,
          version: typeof provider.version === 'string' ? provider.version.slice(0, 400) : null,
          authentication,
          ...(typeof provider.reason === 'string' ? { reason: provider.reason.slice(0, 400) } : {}),
        }
      })
    : []
  return { ...result, git, providers }
}

function validateRemoteChatRequest(request) {
  requirePlainObject(request, 'The remote chat request')
  if (!['codex', 'claude'].includes(request.provider)) {
    throw new RemoteSshError('unsupported_provider', 'Remote chat supports Codex and Claude Code only.', 422)
  }
  if (typeof request.prompt !== 'string' || !request.prompt.trim()) {
    throw new RemoteSshError('invalid_prompt', 'Enter a message before running remote chat.')
  }
  if (
    typeof request.workspaceKey !== 'string'
    || !request.workspaceKey.trim()
    || request.workspaceKey.length > 512
    || CONTROL_CHARACTER_PATTERN.test(request.workspaceKey)
  ) {
    throw new RemoteSshError(
      'invalid_workspace_key',
      'A stable Ensync conversation workspace key is required for remote agent execution.',
    )
  }
  if (request.prompt.length > MAX_PROMPT_LENGTH) {
    throw new RemoteSshError(
      'invalid_prompt',
      `The message is too large. Ensync Host accepts up to ${MAX_PROMPT_LENGTH.toLocaleString()} characters.`,
      413,
    )
  }
  if (request.attachments != null && (!Array.isArray(request.attachments) || request.attachments.length > 0)) {
    throw new RemoteSshError(
      'remote_attachments_unsupported',
      'Local file attachments cannot be sent to an SSH worker. Remove them or use the local Ensync Host.',
      422,
    )
  }
  if (request.sessionId != null && !SESSION_ID_PATTERN.test(request.sessionId)) {
    throw new RemoteSshError('invalid_session', 'The conversation session ID is invalid.')
  }
  if (request.model != null && !MODEL_PATTERN.test(request.model)) {
    throw new RemoteSshError('invalid_model', 'The requested model name is invalid.')
  }
  if (request.effort != null && !MODEL_EFFORTS.has(request.effort)) {
    throw new RemoteSshError('invalid_effort', 'The requested model effort must be low, medium, high, or max.')
  }
  if (
    request.timeoutMs != null
    && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1_000 || request.timeoutMs > MAX_CHAT_TIMEOUT_MS)
  ) {
    throw new RemoteSshError(
      'invalid_timeout',
      `The timeout must be between 1,000 and ${MAX_CHAT_TIMEOUT_MS.toLocaleString()} milliseconds.`,
    )
  }
}

export class RemoteSshService {
  #adapter
  #inactivityTimeoutMs
  #hardTimeoutMs

  constructor(options = {}) {
    this.#adapter = options.adapter ?? new RemoteSshProcessAdapter(options)
    this.#inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_CHAT_INACTIVITY_TIMEOUT_MS
    this.#hardTimeoutMs = options.hardTimeoutMs ?? null
  }

  async probe(input) {
    const connection = await validateRemoteSshConnection(input)
    const execution = await this.#adapter.execute(
      connection,
      { operation: 'probe', projectPath: connection.projectPath },
      { timeoutMs: DEFAULT_SSH_TIMEOUT_MS },
    )

    if (!execution.envelope) {
      if (execution.process.exitCode === 255) {
        const diagnostic = scrubDiagnostic(execution.process.stderr)
        throw new RemoteSshError(
          'ssh_connection_failed',
          diagnostic
            ? `OpenSSH could not verify or authenticate the remote host: ${diagnostic}`
            : 'OpenSSH could not verify or authenticate the remote host.',
          409,
          true,
        )
      }
      if (remoteNodeUnavailable(execution.process)) {
        return {
          transport: {
            state: 'verified',
            hostKeyVerification: 'strict_known_hosts',
            target: targetMetadata(connection),
          },
          remote: null,
          node: {
            available: false,
            version: null,
            reason: 'SSH connected, but Node.js is unavailable to the non-interactive remote session.',
          },
          project: { requestedPath: connection.projectPath, canonicalPath: null },
          git: { availability: 'unknown', reason: 'Node.js is required for the non-mutating Ensync probe.' },
          providers: [],
          checkedAt: new Date().toISOString(),
        }
      }
      throw new RemoteSshError(
        'invalid_bridge_response',
        'SSH connected, but the remote Node.js bridge returned no verifiable response.',
        502,
      )
    }
    if (!execution.envelope.ok) throw bridgeFailure(execution.envelope)
    return {
      transport: {
        state: 'verified',
        hostKeyVerification: 'strict_known_hosts',
        target: targetMetadata(connection),
      },
      ...publicProbeResult(execution.envelope.result),
    }
  }

  async runChat(request, options = {}) {
    validateRemoteChatRequest(request)
    if (options.signal?.aborted) {
      throw new RemoteSshError('run_cancelled', 'Run stopped by user.', 499, false)
    }
    const connection = await validateRemoteSshConnection(request.connection)
    if (options.signal?.aborted) {
      throw new RemoteSshError('run_cancelled', 'Run stopped by user.', 499, false)
    }
    const hardTimeoutMs = request.timeoutMs ?? this.#hardTimeoutMs
    const inactivityTimeoutMs = hardTimeoutMs == null
      ? this.#inactivityTimeoutMs
      : Math.min(this.#inactivityTimeoutMs, hardTimeoutMs)
    const transportHardTimeoutMs = hardTimeoutMs == null
      ? null
      : hardTimeoutMs + CHAT_TRANSPORT_TIMEOUT_GRACE_MS
    const startedAt = Date.now()
    const execution = await this.#adapter.execute(
      connection,
      {
        operation: 'chat',
        provider: request.provider,
        projectPath: connection.projectPath,
        workspaceKey: request.workspaceKey,
        prompt: request.prompt,
        sessionId: request.sessionId ?? null,
        model: request.model ?? null,
        effort: request.effort ?? null,
        inactivityTimeoutMs,
        hardTimeoutMs,
      },
      {
        timeoutMs: transportHardTimeoutMs ?? DEFAULT_SSH_TIMEOUT_MS,
        inactivityTimeoutMs: inactivityTimeoutMs + CHAT_TRANSPORT_TIMEOUT_GRACE_MS,
        hardTimeoutMs: transportHardTimeoutMs,
        signal: options.signal,
      },
    )

    if (!execution.envelope) {
      if (execution.process.exitCode === 255) {
        throw new RemoteSshError(
          'ssh_connection_failed',
          'OpenSSH could not verify or authenticate the remote host.',
          409,
          true,
        )
      }
      if (remoteNodeUnavailable(execution.process)) {
        throw new RemoteSshError(
          'remote_node_unavailable',
          'Node.js is unavailable to the non-interactive remote SSH session.',
          409,
          true,
        )
      }
      throw new RemoteSshError('invalid_bridge_response', 'Remote chat returned no verifiable bridge response.', 502)
    }
    if (!execution.envelope.ok) throw bridgeFailure(execution.envelope)
    const result = execution.envelope.result
    const workspace = result?.workspace
    if (
      !workspace
      || typeof workspace.path !== 'string'
      || typeof workspace.repositoryPath !== 'string'
      || typeof workspace.branch !== 'string'
      || !workspace.gitBefore
    ) {
      throw new RemoteSshError('invalid_bridge_response', 'Remote chat returned no verified protected workspace.', 502)
    }
    options.onEvent?.({
      type: 'notice',
      code: 'project_workspace_ready',
      message: `Remote protected workspace used on ${workspace.branch} at ${workspace.path}. The shared checkout was not the provider working directory.`,
      workspace: { path: workspace.path, branch: workspace.branch },
      at: new Date().toISOString(),
    })
    const processResult = result?.process
    if (!processResult || typeof processResult.stdout !== 'string' || typeof processResult.stderr !== 'string') {
      throw new RemoteSshError('invalid_bridge_response', 'Remote chat returned an invalid process result.', 502)
    }
    if (processResult.timedOut) {
      const message = processResult.timeoutReason === 'inactivity'
        ? 'The remote provider produced no CLI output or lifecycle progress before Ensync Host\'s inactivity limit and was stopped. Partial work may exist; review the remote project before retrying.'
        : processResult.timeoutReason === 'hard_limit'
          ? 'The remote provider reached an explicit Ensync Host run limit and was stopped. Partial work may exist; review the remote project before retrying.'
          : 'The remote provider reached an Ensync Host run limit and was stopped. Partial work may exist; review the remote project before retrying.'
      throw new RemoteSshError('run_timed_out', message, 504)
    }
    if (processResult.outputExceeded) {
      throw new RemoteSshError('run_output_exceeded', 'The remote provider exceeded the verified output limit.', 502)
    }
    if (processResult.error) {
      throw new RemoteSshError('run_start_failed', 'The remote provider could not be started.', 502, true)
    }
    if (processResult.exitCode !== 0) {
      const safeToRetry = quotaFailureIsSafe(request.provider, processResult.stdout, processResult.stderr)
      throw new RemoteSshError(
        safeToRetry ? 'provider_quota' : 'cli_failed',
        safeToRetry
          ? 'The remote provider reported a quota, rate-limit, or capacity failure before any tool activity.'
          : `${describeProcessExit('The remote provider', processResult)}.`,
        safeToRetry ? 429 : 502,
        safeToRetry,
      )
    }

    let parsed
    try {
      parsed = parseRemoteChat(request.provider, processResult.stdout)
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'invalid_cli_output'
      const message = code === 'provider_quota'
        ? 'The remote provider reported a quota, rate-limit, or capacity failure before any tool activity.'
        : code === 'empty_cli_response'
          ? 'The remote provider finished without a verifiable final response.'
          : code === 'cli_failed'
            ? 'The remote provider reported that the run failed.'
            : 'The remote provider returned invalid structured output.'
      throw new RemoteSshError(
        code,
        message,
        Number.isInteger(error?.status) ? error.status : 502,
        error?.safeToRetry === true,
      )
    }
    return {
      provider: request.provider,
      projectPath: result.projectPath,
      workspace,
      response: parsed.response,
      sessionId: parsed.sessionId ?? request.sessionId ?? null,
      model: parsed.model,
      requestedModel: request.model ?? null,
      requestedEffort: request.effort ?? null,
      usage: parsed.usage,
      outputRecovery: parsed.outputRecovery,
      durationMs: Date.now() - startedAt,
      completedAt: result.completedAt,
      remote: {
        ...result.remote,
        target: {
          hostname: connection.hostname,
          username: connection.username,
          port: connection.port,
        },
        hostKeyVerification: 'strict_known_hosts',
      },
    }
  }
}
