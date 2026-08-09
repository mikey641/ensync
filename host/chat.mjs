import { realpath, stat } from 'node:fs/promises'
import { dirname, extname, isAbsolute, relative } from 'node:path'
import { describeProcessExit, runProcess, subscriptionEnvironment } from './command.mjs'
import { CodexLiveTurnError, CodexLiveTurnRunner } from './codex-live-turn.mjs'
import { finalCodexResponse } from './codex-response.mjs'
import { decodeJsonEventStream } from './json-event-repair.mjs'

const SUPPORTED_CHAT_PROVIDERS = new Set(['codex', 'claude'])
// Verified containment levels per the catalog capability contract. A provider
// with no record here is refused as runnable regardless of SUPPORTED_CHAT_PROVIDERS.
const CHAT_PROVIDER_CONTAINMENT = {
  codex: { level: 'os_sandbox' },
  // permission_config gap (verified via `claude --help`): in `-p`/`--print` mode, settings
  // files that fail validation are silently ignored (no error dialog is shown) — a malformed
  // --settings payload fails open rather than blocking the run. Also, Bash is governed by
  // command-prefix rules, not the file-pattern rules our deny list uses, so Write(...)/Edit(...)
  // deny rules do not constrain shell commands run through the Bash tool.
  claude: { level: 'permission_config' },
}
const DEFAULT_INACTIVITY_TIMEOUT_MS = 15 * 60 * 1_000
const DEFAULT_HARD_TIMEOUT_MS = 2 * 60 * 60 * 1_000
const MAX_TIMEOUT_MS = 10 * 60 * 1_000
const MAX_PROMPT_LENGTH = 100_000
const MAX_CHAT_OUTPUT_BYTES = 4 * 1024 * 1024
const MAX_ATTACHMENT_COUNT = 64
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const MODEL_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/
const MODEL_EFFORTS = new Set(['low', 'medium', 'high', 'max'])
const CODEX_IMAGE_EXTENSIONS = new Set(['.gif', '.jpeg', '.jpg', '.png', '.webp'])
const QUOTA_PATTERN = /(?:usage|spending|rate)[\s_-]*limit|quota|capacity|overloaded|too many requests|out of credits|insufficient credits|credit balance/i
const TERMINAL_EVENT_TEXT_LIMIT = 256 * 1024
const CLAUDE_PENDING_NOTE_MESSAGES = 8
const SECRET_PATTERNS = [
  /\b(?:sk-(?:proj-|live-)?|ghp_|github_pat_|glpat-|xox[baprs]-)[a-zA-Z0-9_-]{12,}\b/g,
  /\bBearer\s+[a-zA-Z0-9._~+\/-]{12,}/gi,
  /\b[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\b/g,
  /\b(api[_-]?key|access[_-]?token|auth[_-]?token|password|secret|authorization)\b(\s*[:=]\s*["']?)([^\s"',}]{8,})/gi,
]

export class ChatRunError extends Error {
  constructor(code, message, status = 400, safeToRetry = false) {
    super(message)
    this.name = 'ChatRunError'
    this.code = code
    this.status = status
    this.safeToRetry = safeToRetry
  }
}

function cancelledRunError() {
  return new ChatRunError(
    'run_cancelled',
    'Run stopped by user. The provider process was terminated.',
    499,
    false,
  )
}

function throwIfCancelled(signal) {
  if (signal?.aborted) throw cancelledRunError()
}

function combinedAbortSignal(...signals) {
  const active = signals.filter(Boolean)
  if (active.length === 0) return { signal: undefined, dispose() {} }
  if (active.length === 1) return { signal: active[0], dispose() {} }
  const controller = new AbortController()
  const abort = (event) => controller.abort(event?.target?.reason)
  for (const signal of active) {
    if (signal.aborted) controller.abort(signal.reason)
    else signal.addEventListener('abort', abort, { once: true })
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const signal of active) signal.removeEventListener('abort', abort)
    },
  }
}

function isolatedPrompt(prompt, workspace) {
  if (!workspace) return prompt
  return `[ENSYNC HOST WORKSPACE ISOLATION]
This run is bound to the protected Git worktree that is the current working directory.
Treat the current working directory as the only writable project for this task. Do not access or modify another checkout or worktree of the same repository, even if earlier conversation context names a canonical project path.
Protected branch: ${workspace.branch}
Verified worktree state before this run: ${workspace.gitBefore.dirty ? `${workspace.gitBefore.changedFiles} changed files` : 'clean'} at ${workspace.gitBefore.head}.

${prompt}`
}

function timeoutMessage(providerName, timeoutReason) {
  if (timeoutReason === 'inactivity') {
    return `${providerName} produced no CLI output or lifecycle progress before Ensync Host's inactivity limit and was stopped. Partial work may exist; review the project before retrying.`
  }
  if (timeoutReason === 'hard_limit') {
    return `${providerName} reached Ensync Host's hard run limit and was stopped. Partial work may exist; review the project before retrying.`
  }
  return `${providerName} reached an Ensync Host run limit and was stopped. Partial work may exist; review the project before retrying.`
}

export function redactTerminalText(value) {
  let text = typeof value === 'string' ? value : String(value ?? '')
  let redacted = false
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (...parts) => {
      redacted = true
      if (parts.length > 4 && typeof parts[1] === 'string' && typeof parts[2] === 'string') {
        return `${parts[1]}${parts[2]}[REDACTED]`
      }
      return '[REDACTED]'
    })
  }
  if (text.length > TERMINAL_EVENT_TEXT_LIMIT) {
    text = `${text.slice(0, TERMINAL_EVENT_TEXT_LIMIT)}\n[OUTPUT TRUNCATED BY ENSYNC HOST]`
    redacted = true
  }
  return { text, redacted }
}

function quoteTerminalArgument(argument) {
  if (/^[a-zA-Z0-9_./:=+-]+$/.test(argument)) return argument
  return `'${argument.replaceAll("'", "'\\''")}'`
}

function visibleArguments(request, attachmentPaths, containment = null) {
  const imagePaths = new Set(codexImagePaths(attachmentPaths))
  return argumentsFor(request, attachmentPaths, containment).map((argument, index, argumentsList) => {
    if (request.sessionId && argument === request.sessionId) return '<session-id>'
    if (index > 0 && argumentsList[index - 1] === '--resume') return '<session-id>'
    if (imagePaths.has(argument)) return '<attached-image>'
    return argument
  })
}

function assistantTextBlocks(content) {
  return content
    .filter((block) => block && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join('\n\n')
}

/**
 * Claude has no commentary/final phase marker. Only surface assistant text when
 * the same message also starts provider work; a text-only assistant message is
 * the final response and must not briefly appear as a note.
 *
 * Claude Code streams one assistant event per content block, so that message's
 * text and its tool call arrive as separate events sharing `message.id`. Text is
 * therefore held until the same message ID starts tool work, and dropped when it
 * never does. Older combined-content events still resolve within one event.
 */
function claudeNoteExtractor() {
  const pending = new Map()

  const remember = (id, text) => {
    const held = pending.get(id) ?? { text: '', toolStarted: false }
    if (text) held.text = held.text ? `${held.text}\n\n${text}` : text
    if (held.text.length > TERMINAL_EVENT_TEXT_LIMIT) held.text = held.text.slice(0, TERMINAL_EVENT_TEXT_LIMIT)
    pending.set(id, held)
    // Blocks of one message stream contiguously; a small bound keeps interleaved
    // subagent messages working without retaining a whole run's commentary.
    while (pending.size > CLAUDE_PENDING_NOTE_MESSAGES) pending.delete(pending.keys().next().value)
    return held
  }

  return (event) => {
    if (event.type !== 'assistant') return null
    const content = event.message?.content ?? event.content
    if (!Array.isArray(content)) return null
    const text = assistantTextBlocks(content)
    const startsToolWork = content.some((block) => block && typeof block === 'object' && block.type === 'tool_use')
    const id = typeof event.message?.id === 'string' && event.message.id ? event.message.id : null
    if (!id) return startsToolWork ? text || null : null

    const held = remember(id, text)
    if (!startsToolWork && !held.toolStarted) return null
    held.toolStarted = true
    const note = held.text
    held.text = ''
    return note || null
  }
}

function providerNoteExtractor(provider) {
  if (provider === 'claude') return claudeNoteExtractor()
  return (event) => {
    if (
      provider === 'codex'
      && event.type === 'item.completed'
      && event.item?.type === 'agent_message'
      && event.item.phase === 'commentary'
      && typeof event.item.text === 'string'
      && event.item.text.trim()
    ) {
      return event.item.text.trim()
    }
    return null
  }
}

function outputForwarder(onEvent, provider) {
  if (typeof onEvent !== 'function') {
    return { stdout() {}, stderr() {}, flush() {} }
  }
  const buffers = { stdout: '', stderr: '' }
  const noteFromEvent = providerNoteExtractor(provider)
  const emit = (stream, text) => {
    if (!text) return
    const safe = redactTerminalText(text)
    onEvent({
      type: 'output',
      stream,
      text: safe.text,
      redacted: safe.redacted,
      at: new Date().toISOString(),
    })
    if (stream !== 'stdout') return
    let structured
    try {
      structured = JSON.parse(text)
    } catch {
      return
    }
    if (!structured || typeof structured !== 'object' || Array.isArray(structured)) return
    const note = noteFromEvent(structured)
    if (!note) return
    const safeNote = redactTerminalText(note)
    onEvent({
      type: 'note',
      provider,
      text: safeNote.text,
      redacted: safeNote.redacted,
      at: new Date().toISOString(),
    })
  }
  const append = (stream, chunk) => {
    buffers[stream] += chunk
    const lines = buffers[stream].split(/(?<=\n)/)
    buffers[stream] = lines.pop() ?? ''
    for (const line of lines) emit(stream, line)
  }
  return {
    stdout: (chunk) => append('stdout', chunk),
    stderr: (chunk) => append('stderr', chunk),
    flush() {
      emit('stdout', buffers.stdout)
      emit('stderr', buffers.stderr)
      buffers.stdout = ''
      buffers.stderr = ''
    },
  }
}

function asChatRunError(error, code, fallbackMessage, status = 400) {
  if (error instanceof ChatRunError) return error
  return new ChatRunError(code, fallbackMessage, status)
}

function pathIsWithin(candidate, root) {
  const pathFromRoot = relative(root, candidate)
  return pathFromRoot === '' || (!pathFromRoot.startsWith('..') && !isAbsolute(pathFromRoot))
}

export async function validateProjectPath(projectPath, options = {}) {
  if (typeof projectPath !== 'string' || !projectPath.trim()) {
    throw new ChatRunError('invalid_project', 'Select a project folder before running a chat.')
  }
  if (!isAbsolute(projectPath)) {
    throw new ChatRunError('invalid_project', 'The project path must be an absolute path.')
  }

  let resolvedPath
  try {
    resolvedPath = await realpath(projectPath)
    const projectStat = await stat(resolvedPath)
    if (!projectStat.isDirectory()) {
      throw new ChatRunError('invalid_project', 'The selected project path is not a directory.')
    }
  } catch (error) {
    throw asChatRunError(
      error,
      'invalid_project',
      'The selected project folder does not exist or cannot be accessed.',
    )
  }

  if (dirname(resolvedPath) === resolvedPath) {
    throw new ChatRunError('invalid_project', 'A filesystem root cannot be used as an Ensync project.')
  }

  if (Array.isArray(options.allowedRoots) && options.allowedRoots.length > 0) {
    const allowedRoots = await Promise.all(options.allowedRoots.map(async (root) => realpath(root)))
    if (!allowedRoots.some((root) => pathIsWithin(resolvedPath, root))) {
      throw new ChatRunError(
        'project_not_allowed',
        'The selected folder is outside the project roots allowed by this Ensync Host.',
        403,
      )
    }
  }

  return resolvedPath
}

export async function validateAttachmentPaths(value) {
  if (value == null) return []
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENT_COUNT) {
    throw new ChatRunError(
      'invalid_attachments',
      `Attach no more than ${MAX_ATTACHMENT_COUNT} local files to one turn.`,
      413,
    )
  }

  const resolvedPaths = []
  const seen = new Set()
  for (const attachmentPath of value) {
    if (typeof attachmentPath !== 'string' || !attachmentPath.trim() || !isAbsolute(attachmentPath)) {
      throw new ChatRunError('invalid_attachment', 'Every attached file must have an absolute local path.')
    }
    let resolvedPath
    try {
      resolvedPath = await realpath(attachmentPath)
      const attachmentStat = await stat(resolvedPath)
      if (!attachmentStat.isFile()) {
        throw new ChatRunError('invalid_attachment', 'Only files can be attached to a chat turn.')
      }
    } catch (error) {
      throw asChatRunError(
        error,
        'invalid_attachment',
        'An attached file no longer exists or cannot be accessed.',
      )
    }
    if (!seen.has(resolvedPath)) {
      seen.add(resolvedPath)
      resolvedPaths.push(resolvedPath)
    }
  }
  return resolvedPaths
}

function validateRequest(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new ChatRunError('invalid_request', 'The chat run request must be a JSON object.')
  }
  if (typeof request.provider !== 'string' || !request.provider) {
    throw new ChatRunError('invalid_provider', 'A provider is required.')
  }
  if (!SUPPORTED_CHAT_PROVIDERS.has(request.provider)) {
    throw new ChatRunError(
      'unsupported_provider',
      `${request.provider} chat execution is not supported by Ensync Host yet. Use Codex or Claude Code.`,
      422,
    )
  }
  if (!CHAT_PROVIDER_CONTAINMENT[request.provider]) {
    throw new ChatRunError(
      'provider_containment_unrecorded',
      `${request.provider} has no verified workspace-containment record and cannot run.`,
      409,
      false,
    )
  }
  if (typeof request.prompt !== 'string' || !request.prompt.trim()) {
    throw new ChatRunError('invalid_prompt', 'Enter a message before running the chat.')
  }
  if (request.prompt.length > MAX_PROMPT_LENGTH) {
    throw new ChatRunError(
      'invalid_prompt',
      `The message is too large. Ensync Host accepts up to ${MAX_PROMPT_LENGTH.toLocaleString()} characters.`,
      413,
    )
  }
  if (request.sessionId != null && !SESSION_ID_PATTERN.test(request.sessionId)) {
    throw new ChatRunError('invalid_session', 'The conversation session ID is invalid.')
  }
  if (request.model != null && !MODEL_PATTERN.test(request.model)) {
    throw new ChatRunError('invalid_model', 'The requested model name is invalid.')
  }
  if (request.effort != null && !MODEL_EFFORTS.has(request.effort)) {
    throw new ChatRunError('invalid_effort', 'The requested model effort must be low, medium, high, or max.')
  }
  if (request.attachments != null && !Array.isArray(request.attachments)) {
    throw new ChatRunError('invalid_attachments', 'Attached files must be provided as a list.')
  }
  if (
    request.timeoutMs != null
    && (!Number.isInteger(request.timeoutMs) || request.timeoutMs < 1_000 || request.timeoutMs > MAX_TIMEOUT_MS)
  ) {
    throw new ChatRunError(
      'invalid_timeout',
      `The timeout must be between 1,000 and ${MAX_TIMEOUT_MS.toLocaleString()} milliseconds.`,
    )
  }
}

function subscriptionAuthenticationAllowed(provider) {
  const method = provider.authentication?.method?.toLowerCase() ?? ''
  if (provider.id === 'codex') return method.includes('chatgpt')
  if (provider.id === 'claude') {
    return ['claude.ai', 'oauth', 'subscription'].some((signal) => method.includes(signal))
  }
  return false
}

function integerOrNull(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null
}

function usageFrom(value) {
  if (!value || typeof value !== 'object') return null
  const inputTokens = integerOrNull(value.input_tokens ?? value.inputTokens)
  const outputTokens = integerOrNull(value.output_tokens ?? value.outputTokens)
  const cachedInputTokens = integerOrNull(
    value.cached_input_tokens
      ?? value.cachedInputTokens
      ?? value.cache_read_input_tokens
      ?? value.cacheReadInputTokens,
  )
  if (inputTokens === null && outputTokens === null && cachedInputTokens === null) return null
  return {
    source: 'cli',
    inputTokens,
    outputTokens,
    cachedInputTokens,
  }
}

function structuredEvents(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  try {
    const { events } = decodeJsonEventStream(value)
    return events.length ? events : null
  } catch {
    return null
  }
}

function codexEventsProveNoActivity(events) {
  const terminal = events.at(-1)
  if (!terminal || !['turn.failed', 'error'].includes(terminal.type)) return false
  const knownLifecycleEvents = new Set(['thread.started', 'turn.started', 'turn.failed', 'error'])
  const itemEvents = new Set(['item.started', 'item.updated', 'item.completed'])

  return !events.some((event) => {
    if (knownLifecycleEvents.has(event.type)) return false
    if (!itemEvents.has(event.type)) return true
    const itemType = event.item?.type
    return typeof itemType !== 'string' || !['reasoning', 'agent_message'].includes(itemType)
  })
}

function claudeEventsProveNoActivity(events) {
  const terminal = events.at(-1)
  if (!terminal || terminal.type !== 'result' || terminal.is_error !== true) return false
  const knownNonWorkEvents = new Set(['system', 'result', 'rate_limit_event'])

  return !events.some((event) => {
    if (knownNonWorkEvents.has(event.type)) return false
    if (!['assistant', 'user'].includes(event.type)) return true
    const content = event.message?.content ?? event.content
    if (!Array.isArray(content)) return true
    return content.some((block) =>
      !block
      || typeof block !== 'object'
      || !['text', 'thinking', 'redacted_thinking'].includes(block.type))
  })
}

export function quotaFailureIsSafe(provider, stdout, stderr = '') {
  if (!QUOTA_PATTERN.test(`${stdout}\n${stderr}`)) return false
  const events = structuredEvents(stdout)
  if (!events) return false
  return provider === 'codex'
    ? codexEventsProveNoActivity(events)
    : provider === 'claude' && claudeEventsProveNoActivity(events)
}

function quotaError(provider, safeToRetry) {
  const name = provider === 'codex' ? 'Codex' : 'Claude Code'
  return new ChatRunError(
    'provider_quota',
    `${name} reported a quota, rate-limit, or capacity failure before any tool activity.`,
    429,
    safeToRetry,
  )
}

export function parseCodexChatResult(stdout) {
  let decoded
  try {
    decoded = decodeJsonEventStream(stdout, { allowRepair: true })
  } catch {
    throw new ChatRunError(
      'invalid_cli_output',
      'Ensync Host tried a bounded repair of Codex output but could not verify it as JSON events. The task was not replayed because partial work may exist.',
      502,
    )
  }
  const { events, recovery } = decoded
  if (events.length === 0) {
    throw new ChatRunError(
      'invalid_cli_output',
      'Ensync Host tried a bounded repair of Codex output but found no verifiable JSON events. The task was not replayed because partial work may exist.',
      502,
    )
  }
  const agentMessages = []
  let sessionId = null
  let usage = null
  let model = null
  let completed = false
  let failed = false

  for (const event of events) {
    if (event.type === 'thread.started' && typeof event.thread_id === 'string') {
      sessionId = event.thread_id
    }
    if (
      event.type === 'item.completed'
      && event.item?.type === 'agent_message'
      && typeof event.item.text === 'string'
      && event.item.text.trim()
    ) {
      agentMessages.push(event.item)
    }
    if (event.type === 'turn.completed') {
      completed = true
      usage = usageFrom(event.usage) ?? usage
    }
    if (event.type === 'turn.failed' || event.type === 'error') failed = true
    if (typeof event.model === 'string' && event.model.trim()) model = event.model.trim()
  }

  if (failed) {
    if (quotaFailureIsSafe('codex', stdout)) throw quotaError('codex', true)
    throw new ChatRunError('cli_failed', 'Codex reported that the run failed.', 502)
  }
  if (!completed) {
    throw new ChatRunError(
      'invalid_cli_output',
      recovery
        ? 'Ensync Host repaired part of Codex output, but no verified terminal completion event remained. The task was not replayed because partial work may exist.'
        : 'Codex returned no verified terminal completion event.',
      502,
    )
  }
  const response = finalCodexResponse(agentMessages)
  if (!response) {
    throw new ChatRunError(
      'empty_cli_response',
      'Codex finished without a verifiable final agent response.',
      502,
    )
  }
  return { response, sessionId, model, usage, outputRecovery: recovery }
}

export function parseClaudeChatResult(stdout) {
  let decoded
  try {
    decoded = decodeJsonEventStream(stdout, { allowRepair: true })
  } catch {
    throw new ChatRunError(
      'invalid_cli_output',
      'Ensync Host tried a bounded repair of Claude Code output but could not verify it as JSON events. The task was not replayed because partial work may exist.',
      502,
    )
  }
  const { events, recovery } = decoded
  if (events.length === 0) {
    throw new ChatRunError(
      'invalid_cli_output',
      'Ensync Host tried a bounded repair of Claude Code output but found no verifiable JSON events. The task was not replayed because partial work may exist.',
      502,
    )
  }

  const result = [...events].reverse().find((event) => event.type === 'result')
    ?? (events.length === 1 ? events[0] : null)

  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new ChatRunError('invalid_cli_output', 'Claude Code returned an invalid result.', 502)
  }
  if (result.is_error === true) {
    if (quotaFailureIsSafe('claude', stdout)) throw quotaError('claude', true)
    throw new ChatRunError(
      'cli_failed',
      typeof result.result === 'string' && result.result.trim()
        ? `Claude Code reported an error: ${redactTerminalText(result.result.trim()).text}`
        : 'Claude Code reported that the run failed.',
      502,
    )
  }
  if (result.is_error !== false) {
    throw new ChatRunError(
      'invalid_cli_output',
      'Claude Code returned no verified success state.',
      502,
    )
  }
  if (typeof result.result !== 'string' || !result.result.trim()) {
    throw new ChatRunError(
      'empty_cli_response',
      'Claude Code finished without a verifiable final agent response.',
      502,
    )
  }

  const modelUsage = result.modelUsage && typeof result.modelUsage === 'object'
    ? Object.keys(result.modelUsage)
    : []
  const initModel = events.find((event) =>
    event.type === 'system'
    && event.subtype === 'init'
    && typeof event.model === 'string')?.model
  const initSessionId = events.find((event) =>
    event.type === 'system'
    && event.subtype === 'init'
    && typeof event.session_id === 'string')?.session_id
  return {
    response: result.result.trim(),
    sessionId: typeof result.session_id === 'string' ? result.session_id : initSessionId ?? null,
    model: modelUsage.length === 1 ? modelUsage[0] : initModel ?? null,
    usage: usageFrom(result.usage),
    outputRecovery: recovery,
  }
}

function codexImagePaths(attachmentPaths = []) {
  return attachmentPaths.filter((attachmentPath) => CODEX_IMAGE_EXTENSIONS.has(extname(attachmentPath).toLowerCase()))
}

// Pinned per Step 0 verification against the installed Codex CLI (codex-cli 0.146.0):
// `codex exec --help` documents `-s/--sandbox <SANDBOX_MODE>` with `workspace-write` as a
// possible value; `-c` accepts dotted-path TOML overrides, and `sandbox_workspace_write.writable_roots`
// is a documented config key ("Additional writable roots when sandbox_mode = \"workspace-write\"").
// Host, not the renderer, chooses these flags — they are not user- or renderer-selectable.
//
// `codex exec resume` does NOT accept `--sandbox` — verified against the installed binary:
// `codex exec resume --sandbox workspace-write ...` -> `error: unexpected argument '--sandbox'
// found` (exit 2, argv parse failure, before any session lookup). On resume the sandbox must be
// expressed purely as `-c` config overrides instead; verified this parses and passes
// `--strict-config` (the invocation proceeds to a real `thread/resume` session lookup rather
// than an argv error).
function codexContainmentArguments(containment, { resume = false } = {}) {
  if (!containment) return []
  const writableRootsArgs = ['-c', `sandbox_workspace_write.writable_roots=[${JSON.stringify(containment.worktreePath)}]`]
  if (resume) {
    return ['-c', 'sandbox_mode="workspace-write"', ...writableRootsArgs]
  }
  return ['--sandbox', 'workspace-write', ...writableRootsArgs]
}

function codexArguments(request, attachmentPaths = [], containment = null) {
  const modelArgs = request.model ? ['--model', request.model] : []
  const effortArgs = request.effort ? ['-c', `model_reasoning_effort="${request.effort}"`] : []
  const imagePaths = codexImagePaths(attachmentPaths)
  const imageArgs = imagePaths.length > 0 ? ['--image', ...imagePaths] : []
  if (request.sessionId) {
    const containmentArgs = codexContainmentArguments(containment, { resume: true })
    return ['exec', 'resume', ...imageArgs, ...containmentArgs, '--json', '--skip-git-repo-check', ...modelArgs, ...effortArgs, request.sessionId, '-']
  }
  const containmentArgs = codexContainmentArguments(containment)
  return ['exec', ...imageArgs, ...containmentArgs, '--json', '--color', 'never', '--skip-git-repo-check', ...modelArgs, ...effortArgs, '-']
}

// Pinned per Step 0 verification against the installed Claude Code CLI (2.1.226): `claude --help`
// documents `--settings <file-or-json>`; the bundled settings schema documents `permissions.deny`
// as a string array, and the CLI's own permission-rule validator documents `Tool(specifier)` glob
// syntax with examples including `Edit(docs/**)`, with "Write", "Edit", and "NotebookEdit" all in
// its `filePatternTools` list. Host, not the renderer, chooses these flags. This is a fail-open
// gap, not a sandbox: see the CHAT_PROVIDER_CONTAINMENT claude record for the `-p` mode
// silent-validation-failure and Bash-is-unconstrained caveats.
function claudeContainmentArguments(containment) {
  if (!containment) return []
  const settings = {
    permissions: {
      deny: [
        `Write(${containment.canonicalRepositoryPath}/**)`,
        `Edit(${containment.canonicalRepositoryPath}/**)`,
        `NotebookEdit(${containment.canonicalRepositoryPath}/**)`,
      ],
    },
  }
  return ['--settings', JSON.stringify(settings)]
}

function claudeArguments(request, containment = null) {
  const args = ['--print', '--verbose', '--output-format', 'stream-json']
  if (request.model) args.push('--model', request.model)
  if (request.effort) args.push('--effort', request.effort)
  if (request.sessionId) args.push('--resume', request.sessionId)
  args.push(...claudeContainmentArguments(containment))
  return args
}

export function argumentsFor(request, attachmentPaths = [], containment = null) {
  return request.provider === 'codex'
    ? codexArguments(request, attachmentPaths, containment)
    : claudeArguments(request, containment)
}

function parseResult(provider, stdout) {
  return provider === 'codex' ? parseCodexChatResult(stdout) : parseClaudeChatResult(stdout)
}

export class ChatRunService {
  #statusService
  #processRunner
  #allowedRoots
  #environment
  #inactivityTimeoutMs
  #hardTimeoutMs
  #codexLiveTurns
  #projectIsolation
  #activeRuns = 0

  constructor(options = {}) {
    if (!options.statusService) throw new TypeError('ChatRunService requires a provider status service.')
    this.#statusService = options.statusService
    this.#processRunner = options.processRunner ?? runProcess
    this.#allowedRoots = options.allowedRoots
    this.#environment = options.environment ?? process.env
    this.#inactivityTimeoutMs = options.inactivityTimeoutMs ?? DEFAULT_INACTIVITY_TIMEOUT_MS
    this.#hardTimeoutMs = options.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS
    this.#projectIsolation = options.projectIsolation ?? null
    this.#codexLiveTurns = options.codexLiveTurnRunner ?? new CodexLiveTurnRunner({
      inactivityTimeoutMs: this.#inactivityTimeoutMs,
      hardTimeoutMs: this.#hardTimeoutMs,
    })
  }

  async run(request, options = {}) {
    validateRequest(request)
    throwIfCancelled(options.signal)
    const projectPath = await validateProjectPath(request.projectPath, {
      allowedRoots: this.#allowedRoots,
    })
    throwIfCancelled(options.signal)
    const attachmentPaths = await validateAttachmentPaths(request.attachments)
    throwIfCancelled(options.signal)
    const provider = await this.#statusService.get(request.provider, { refresh: true })
    throwIfCancelled(options.signal)

    if (!provider?.installed || !provider.executable) {
      throw new ChatRunError(
        'provider_unavailable',
        `${request.provider === 'codex' ? 'Codex' : 'Claude Code'} is not installed or is not available on PATH.`,
        409,
        true,
      )
    }
    if (provider.authentication?.state !== 'authenticated') {
      throw new ChatRunError(
        'provider_not_authenticated',
        provider.authentication?.reason
          ?? `${provider.name} is not authenticated. Connect it before running a chat.`,
        409,
        true,
      )
    }
    if (!subscriptionAuthenticationAllowed(provider)) {
      throw new ChatRunError(
        'subscription_auth_required',
        `${provider.name} must be connected through a subscription login. Ensync Host will not run chat through API-key, Bedrock, Vertex, or Foundry credentials.`,
        409,
        true,
      )
    }

    let workspaceLease = null
    let workspace = null
    let combinedSignal = { signal: options.signal, dispose() {} }
    if (this.#projectIsolation) {
      try {
        workspaceLease = await this.#projectIsolation.acquire(projectPath, request.workspaceKey, {
          signal: options.signal,
          onWait: () => options.onEvent?.({
            type: 'notice',
            code: 'workspace_write_lock_waiting',
            message: 'Waiting for this conversation’s protected workspace to become available. Another run in this same chat is using it; other chats can run concurrently. No provider process has started.',
            at: new Date().toISOString(),
          }),
        })
        workspace = workspaceLease.workspace
        combinedSignal = combinedAbortSignal(options.signal, workspaceLease.signal)
        options.onEvent?.({
          type: 'notice',
          code: 'project_workspace_ready',
          message: `Protected workspace ready on ${workspace.branch} at ${workspace.projectPath}. The shared checkout will not be used as the provider working directory.`,
          workspace: { path: workspace.projectPath, branch: workspace.branch },
          at: new Date().toISOString(),
        })
      } catch (error) {
        if (error instanceof ChatRunError) throw error
        throw new ChatRunError(
          typeof error?.code === 'string' ? error.code : 'project_isolation_failed',
          error instanceof Error ? error.message : 'Ensync Host could not prepare a protected project workspace.',
          Number.isInteger(error?.status) ? error.status : 409,
          false,
        )
      }
    }
    const executionProjectPath = workspace?.projectPath ?? projectPath
    const executionRequest = workspace ? { ...request, prompt: isolatedPrompt(request.prompt, workspace) } : request
    const publicWorkspace = workspace ? {
      path: workspace.projectPath,
      repositoryPath: workspace.repositoryPath,
      branch: workspace.branch,
      reused: workspace.reused,
      gitBefore: workspace.gitBefore,
    } : null
    // workspace.repositoryPath is the writable worktree; workspace.shared.repositoryPath is the
    // canonical shared checkout that provider processes must not write to directly.
    const containment = workspace ? {
      worktreePath: workspace.repositoryPath,
      canonicalRepositoryPath: workspace.shared.repositoryPath,
    } : null

    let runOutcome = 'failed'
    try {
    if (request.provider === 'codex' && typeof options.liveTurnId === 'string' && options.liveTurnId) {
      this.#activeRuns += 1
      try {
        // Live-turn containment is pinned in codex-live-turn session configuration; verify
        // separately before enabling sandbox there. Step 0 verification for this task found a
        // `sandboxPolicy` field on `TurnStartParams` in the app-server v2 protocol schema, but
        // could not confirm it applies under the non-experimental `initialize` handshake this
        // runner uses (no `experimentalApi: true`), so it was not pinned here. Do not guess.
        const result = await this.#codexLiveTurns.run({
          id: options.liveTurnId,
          executable: provider.executable,
          projectPath: executionProjectPath,
          prompt: executionRequest.prompt,
          attachmentPaths,
          sessionId: request.sessionId ?? null,
          model: request.model ?? null,
          effort: request.effort ?? null,
          env: subscriptionEnvironment(this.#environment),
        }, {
          signal: combinedSignal.signal,
          onEvent: (event) => {
            if (!['output', 'note'].includes(event?.type)) return options.onEvent?.(event)
            const safe = redactTerminalText(event.text)
            options.onEvent?.({ ...event, text: safe.text, redacted: safe.redacted })
          },
        })
        workspaceLease?.assertHeld()
        runOutcome = 'succeeded'
        return { ...result, projectPath, workspace: publicWorkspace }
      } catch (error) {
        if (workspaceLease?.signal.aborted && !options.signal?.aborted) {
          const reason = workspaceLease.signal.reason
          throw new ChatRunError(
            'workspace_write_lock_lost',
            reason instanceof Error ? reason.message : 'Ensync Host lost the protected workspace write lease. Partial work may exist in the protected worktree.',
            409,
            false,
          )
        }
        if (error instanceof CodexLiveTurnError) {
          throw new ChatRunError(error.code, error.message, error.status, error.safeToRetry)
        }
        throw error
      } finally {
        this.#activeRuns -= 1
        this.#statusService.invalidate?.()
      }
    }

    const startedAt = Date.now()
    const hardTimeoutMs = request.timeoutMs ?? this.#hardTimeoutMs
    const inactivityTimeoutMs = Math.min(this.#inactivityTimeoutMs, hardTimeoutMs)
    const args = argumentsFor(executionRequest, attachmentPaths, containment)
    const forwarder = outputForwarder(options.onEvent, request.provider)
    this.#activeRuns += 1
    let processResult
    try {
      options.onEvent?.({
        type: 'started',
        provider: request.provider,
        cwd: executionProjectPath,
        command: [provider.executable, ...visibleArguments(executionRequest, attachmentPaths, containment)].map(quoteTerminalArgument).join(' '),
        at: new Date(startedAt).toISOString(),
      })
      processResult = await this.#processRunner(
        provider.executable,
        args,
        {
          cwd: executionProjectPath,
          env: subscriptionEnvironment(this.#environment),
          input: executionRequest.prompt,
          inactivityTimeoutMs,
          hardTimeoutMs,
          maxCaptureBytes: MAX_CHAT_OUTPUT_BYTES,
          onStdout: forwarder.stdout,
          onStderr: forwarder.stderr,
          signal: combinedSignal.signal,
        },
      )
    } finally {
      this.#activeRuns -= 1
      forwarder.flush()
      // A completed, failed, or cancelled CLI process may have changed the account's real
      // usage window. Drop the shared Host cache so every renderer's next non-forced read
      // observes a fresh provider probe without each window forcing its own subprocesses.
      this.#statusService.invalidate?.()
    }

    if (workspaceLease?.signal.aborted && !options.signal?.aborted) {
      const reason = workspaceLease.signal.reason
      throw new ChatRunError(
        'workspace_write_lock_lost',
        reason instanceof Error ? reason.message : 'Ensync Host lost the protected workspace write lease. Partial work may exist in the protected worktree.',
        409,
        false,
      )
    }
    if (processResult.aborted || options.signal?.aborted) throw cancelledRunError()
    if (processResult.timedOut) {
      throw new ChatRunError(
        'run_timed_out',
        timeoutMessage(provider.name, processResult.timeoutReason),
        504,
      )
    }
    if (processResult.error) {
      throw new ChatRunError(
        'run_start_failed',
        `${provider.name} could not be started by Ensync Host.`,
        502,
        true,
      )
    }
    if (processResult.exitCode !== 0) {
      if (quotaFailureIsSafe(request.provider, processResult.stdout, processResult.stderr)) {
        throw quotaError(request.provider, true)
      }
      const output = processResult.stderr || processResult.stdout
      const reason = output ? ` ${redactTerminalText(output.slice(0, 500)).text}` : ''
      throw new ChatRunError(
        'cli_failed',
        `${describeProcessExit(provider.name, processResult)}.${reason}`,
        502,
      )
    }

    const parsed = parseResult(request.provider, processResult.stdout)
    workspaceLease?.assertHeld()
    runOutcome = 'succeeded'
    return {
      provider: request.provider,
      projectPath,
      workspace: publicWorkspace,
      response: parsed.response,
      sessionId: parsed.sessionId ?? request.sessionId ?? null,
      model: parsed.model,
      requestedModel: request.model ?? null,
      requestedEffort: request.effort ?? null,
      usage: parsed.usage,
      outputRecovery: parsed.outputRecovery,
      durationMs: Date.now() - startedAt,
      completedAt: new Date().toISOString(),
    }
    } catch (error) {
      if (error?.code === 'run_cancelled') runOutcome = 'cancelled'
      else if (error?.code === 'run_timed_out') runOutcome = 'timed_out'
      throw error
    } finally {
      combinedSignal.dispose()
      if (workspace && this.#projectIsolation && !workspaceLease?.signal.aborted) {
        try {
          const workCommit = await this.#projectIsolation.commitAgentWork(workspace, {
            outcome: runOutcome,
            provider: request.provider,
            jobId: typeof options.jobId === 'string' ? options.jobId : (typeof options.liveTurnId === 'string' ? options.liveTurnId : null),
          })
          if (workCommit.committed) {
            options.onEvent?.({
              type: 'notice',
              code: 'agent_work_committed',
              message: `Saved ${workCommit.changedFiles} changed file${workCommit.changedFiles === 1 ? '' : 's'} to ${workspace.branch} (run ${runOutcome}).`,
              at: new Date().toISOString(),
            })
          }
        } catch (commitError) {
          options.onEvent?.({
            type: 'notice',
            code: 'agent_work_commit_failed',
            message: `Ensync could not save this run's work to ${workspace.branch}: ${commitError instanceof Error ? commitError.message : 'unknown error'}. The changes remain in the protected worktree and need review.`,
            at: new Date().toISOString(),
          })
        }
        try {
          const sharedCheck = await this.#projectIsolation.checkSharedCheckout(workspace)
          if (sharedCheck.available && sharedCheck.changed) {
            const message = sharedCheck.destructive
              ? `Previously modified files in the shared checkout at ${workspace.shared.repositoryPath} were reverted while this run was active, with no commit containing those changes. Ensync did not change the shared checkout. Review it before relying on its state.`
              : sharedCheck.landed
                ? `Explicit Ensync land merges arrived on ${workspace.shared.repositoryPath} while this run was active, and its uncommitted state also changed. Ensync changed it only through the explicit land; you may have edited concurrently.`
                : `The shared checkout at ${workspace.shared.repositoryPath} changed while this run was active. Ensync did not change it; you may have edited or committed concurrently.`
            options.onEvent?.({
              type: 'notice',
              code: sharedCheck.destructive ? 'shared_checkout_reverted' : 'shared_checkout_changed',
              message,
              at: new Date().toISOString(),
            })
          }
        } catch {
          // Shared-checkout detection is best-effort; never let it mask the run's own outcome or skip lease release.
        }
      }
      await workspaceLease?.release()
    }
  }

  hasRunningRuns() {
    return this.#activeRuns > 0
  }

  async steer(liveTurnId, input) {
    if (typeof liveTurnId !== 'string' || !liveTurnId) {
      throw new ChatRunError('invalid_chat_job', 'A retained chat job ID is required.', 400, true)
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ChatRunError('invalid_request', 'A live instruction is required.', 400, true)
    }
    if (typeof input.prompt !== 'string' || !input.prompt.trim()) {
      throw new ChatRunError('invalid_prompt', 'Enter a message before steering the active turn.', 400, true)
    }
    if (input.prompt.length > MAX_PROMPT_LENGTH) {
      throw new ChatRunError(
        'invalid_prompt',
        `The message is too large. Ensync Host accepts up to ${MAX_PROMPT_LENGTH.toLocaleString()} characters.`,
        413,
        true,
      )
    }
    const attachmentPaths = await validateAttachmentPaths(input.attachments)
    try {
      return await this.#codexLiveTurns.steer(liveTurnId, input.prompt.trim(), attachmentPaths)
    } catch (error) {
      if (error instanceof CodexLiveTurnError) {
        throw new ChatRunError(error.code, error.message, error.status, error.safeToRetry)
      }
      throw error
    }
  }
}
