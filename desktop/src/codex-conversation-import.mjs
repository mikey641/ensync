import { createHash } from 'node:crypto'
import {
  closeSync,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
  statSync,
} from 'node:fs'
import { basename, parse } from 'node:path'

export const CODEX_CONVERSATION_IMPORT_CHANNEL = 'ensync:workspace:get-codex-conversation-import'
export const CODEX_CONVERSATION_IMPORT_CONFIRMATION = 'IMPORT CODEX'
export const MAX_CODEX_TRANSCRIPT_BYTES = 128 * 1024 * 1024
export const MAX_CODEX_HISTORY_BYTES = 16 * 1024 * 1024
export const MAX_IMPORTED_VISIBLE_CHARACTERS = 8 * 1024 * 1024
export const MAX_IMPORTED_MESSAGES = 20_000

const WORKSPACE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const SHA256_PATTERN = /^[0-9a-f]{64}$/i

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function snapshotFile(filePath, maximumBytes, dependencies = {}) {
  const openFile = dependencies.openFile ?? openSync
  const fileStat = dependencies.fileStat ?? fstatSync
  const readFile = dependencies.readFile ?? readSync
  const closeFile = dependencies.closeFile ?? closeSync
  const descriptor = openFile(filePath, 'r')
  try {
    const stat = fileStat(descriptor)
    if (!stat.isFile() || stat.size <= 0 || stat.size > maximumBytes) {
      throw new Error(`The selected ${basename(filePath)} file is empty or exceeds the import size limit.`)
    }
    const bytes = Buffer.allocUnsafe(stat.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readFile(descriptor, bytes, offset, bytes.length - offset, offset)
      if (!Number.isSafeInteger(count) || count <= 0) {
        throw new Error(`The selected ${basename(filePath)} file changed before its bounded snapshot was complete.`)
      }
      offset += count
    }
    return Object.freeze({
      bytes,
      byteLength: bytes.length,
      sha256: sha256(bytes),
    })
  } finally {
    closeFile(descriptor)
  }
}

function jsonLines(snapshot, label) {
  const text = snapshot.bytes.toString('utf8')
  const lines = text.split('\n')
  const hasTerminatingNewline = text.endsWith('\n')
  const entries = []
  let incompleteTailExcluded = false

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    if (!line.trim()) continue
    try {
      entries.push({ lineNumber: index + 1, value: JSON.parse(line) })
    } catch (error) {
      if (index === lines.length - 1 && !hasTerminatingNewline) {
        incompleteTailExcluded = true
        continue
      }
      throw new Error(`${label} contains invalid JSON on complete line ${index + 1}.`, { cause: error })
    }
  }
  return { entries, lineCount: lines.length - (hasTerminatingNewline ? 1 : 0), incompleteTailExcluded }
}

function timestamp(value) {
  if (typeof value !== 'string' || !value) return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function historyTimestamp(value) {
  if (!Number.isFinite(value)) return null
  const date = new Date(value * 1_000)
  return Number.isNaN(date.getTime()) ? null : date.toISOString()
}

function redactCredentials(input) {
  let redactions = 0
  const replace = (pattern, replacement) => {
    input = input.replace(pattern, (...arguments_) => {
      redactions += 1
      return typeof replacement === 'function' ? replacement(...arguments_) : replacement
    })
  }

  replace(
    /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/g,
    '[REDACTED PRIVATE KEY]',
  )
  replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [REDACTED]')
  replace(/\b(?:sk-[A-Za-z0-9_-]{16,}|github_pat_[A-Za-z0-9_]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{12,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{16})\b/g, '[REDACTED CREDENTIAL]')
  replace(/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, '[REDACTED TOKEN]')
  replace(
    /(^|[\s([{,;])((?:api[_-]?key|access[_-]?token|auth(?:orization)?|password|passwd|secret)\s*[:=]\s*)(["']?)([^\s"',;)}\]]{8,})\3/gim,
    (_match, prefix, label, quote) => `${prefix}${label}${quote}[REDACTED]${quote}`,
  )
  return { text: input, redactions }
}

function sourceMessageId(sessionId, source, lineNumber, rawTimestamp, rawText) {
  const identity = sha256(`${sessionId}\0${source}\0${lineNumber}\0${rawTimestamp ?? ''}\0${sha256(rawText)}`)
  return `codex-import-message-${identity.slice(0, 32)}`
}

function displayTime(value) {
  return value ?? 'Timestamp not provided'
}

function internalCategory(entry) {
  const value = entry.value
  const type = typeof value?.type === 'string' ? value.type : 'unknown'
  const payloadType = typeof value?.payload?.type === 'string' ? value.payload.type : ''
  const role = typeof value?.payload?.role === 'string' ? value.payload.role : ''
  return [type, payloadType, role].filter(Boolean).join('/')
}

function projectId(projectPath) {
  return `local-${sha256(projectPath).slice(0, 16)}`
}

function importGroup(startedAt, now = new Date()) {
  if (!startedAt) return 'Previous 7 days'
  const start = new Date(startedAt)
  if (Number.isNaN(start.getTime())) return 'Previous 7 days'
  const localDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const distance = Math.round((localDay(now) - localDay(start)) / 86_400_000)
  return distance <= 0 ? 'Today' : distance === 1 ? 'Yesterday' : 'Previous 7 days'
}

function configuredProject(projectPath, dependencies = {}) {
  const canonicalPath = (dependencies.realpath ?? realpathSync)(projectPath)
  const stat = (dependencies.pathStat ?? statSync)(canonicalPath)
  if (!stat.isDirectory() || parse(canonicalPath).root === canonicalPath) {
    throw new Error('The Codex conversation import project must be an existing non-root directory.')
  }
  return {
    id: projectId(canonicalPath),
    name: basename(canonicalPath),
    path: canonicalPath,
    host: 'local',
    context: {
      relayDirectory: false,
      files: [],
      featureFiles: [],
      truncated: false,
      error: null,
      instructionAdapters: [],
    },
    inspectedAt: '',
  }
}

/**
 * Snapshots an append-only Codex rollout/history pair and extracts only text
 * that was visible in the user-facing conversation. The source files are
 * opened read-only and bytes written after fstat are intentionally ignored.
 */
export function parseCodexConversationImport({
  transcriptPath,
  historyPath,
  projectPath,
  now,
} = {}, dependencies = {}) {
  if (![transcriptPath, historyPath, projectPath].every((value) => typeof value === 'string' && value)) {
    throw new TypeError('Transcript, history, and target project paths are required.')
  }
  const transcript = snapshotFile(transcriptPath, MAX_CODEX_TRANSCRIPT_BYTES, dependencies)
  const history = snapshotFile(historyPath, MAX_CODEX_HISTORY_BYTES, dependencies)
  const transcriptLines = jsonLines(transcript, 'The Codex rollout')
  const historyLines = jsonLines(history, 'The Codex history')
  const project = configuredProject(projectPath, dependencies)
  const sessionRecords = transcriptLines.entries.filter((entry) => entry.value?.type === 'session_meta')
  if (sessionRecords.length !== 1 || typeof sessionRecords[0].value?.payload?.id !== 'string') {
    throw new Error('The Codex rollout must contain exactly one session identity.')
  }
  const session = sessionRecords[0].value.payload
  const sessionId = session.id
  const startedAt = timestamp(session.timestamp)
  const imported = []
  const excludedCategories = new Map()
  let redactionCount = 0
  let visibleCharacterCount = 0

  for (const entry of historyLines.entries) {
    const value = entry.value
    if (value?.session_id !== sessionId || typeof value.text !== 'string' || !value.text) continue
    const sanitized = redactCredentials(value.text)
    redactionCount += sanitized.redactions
    visibleCharacterCount += sanitized.text.length
    const occurredAt = historyTimestamp(value.ts)
    imported.push({
      id: sourceMessageId(sessionId, 'history-user', entry.lineNumber, occurredAt, value.text),
      role: 'user',
      content: sanitized.text,
      time: displayTime(occurredAt),
      timestamp: occurredAt,
      sourceOrder: entry.lineNumber,
      sortTime: occurredAt ? Date.parse(occurredAt) : Number.MAX_SAFE_INTEGER,
      sortPriority: 0,
    })
  }

  for (const entry of transcriptLines.entries) {
    const value = entry.value
    const isVisibleAssistant = value?.type === 'response_item'
      && value.payload?.type === 'message'
      && value.payload?.role === 'assistant'
    const rawText = isVisibleAssistant && Array.isArray(value.payload.content)
      ? value.payload.content
        .filter((part) => part?.type === 'output_text' && typeof part.text === 'string')
        .map((part) => part.text)
        .join('')
      : ''
    if (!rawText) {
      const category = internalCategory(entry)
      excludedCategories.set(category, (excludedCategories.get(category) ?? 0) + 1)
      continue
    }
    const sanitized = redactCredentials(rawText)
    redactionCount += sanitized.redactions
    visibleCharacterCount += sanitized.text.length
    const occurredAt = timestamp(value.timestamp)
    imported.push({
      id: sourceMessageId(sessionId, 'rollout-assistant', entry.lineNumber, occurredAt, rawText),
      role: 'agent',
      provider: 'codex',
      content: sanitized.text,
      time: displayTime(occurredAt),
      timestamp: occurredAt,
      sourceOrder: entry.lineNumber,
      sortTime: occurredAt ? Date.parse(occurredAt) : Number.MAX_SAFE_INTEGER,
      sortPriority: 1,
    })
  }

  if (imported.length === 0) throw new Error('The selected Codex session has no importable visible messages.')
  if (imported.length > MAX_IMPORTED_MESSAGES || visibleCharacterCount > MAX_IMPORTED_VISIBLE_CHARACTERS) {
    throw new Error('The visible Codex conversation exceeds the bounded Ensync import limit.')
  }
  imported.sort((left, right) => left.sortTime - right.sortTime
    || left.sortPriority - right.sortPriority
    || left.sourceOrder - right.sourceOrder)
  // eslint-disable-next-line no-unused-vars -- rest-sibling omit: the sort keys are internal ordering state that must not leak into the imported message.
  const messages = imported.map(({ sortTime: _sortTime, sortPriority: _sortPriority, sourceOrder: _sourceOrder, ...message }) => message)
  const userMessages = messages.filter((message) => message.role === 'user').length
  const assistantMessages = messages.filter((message) => message.role === 'agent').length
  const sourceFingerprint = sha256(JSON.stringify({
    kind: 'codex_session',
    sessionId,
    transcriptSha256: transcript.sha256,
    transcriptBytes: transcript.byteLength,
    historySha256: history.sha256,
    historyBytes: history.byteLength,
    projectPath: project.path,
  }))
  const chatIdentity = sha256(`codex_session\0${sessionId}\0${project.path}`).slice(0, 32)
  const messageIds = messages.map((message) => message.id)
  const lastVisibleAt = [...messages].reverse().find((message) => message.timestamp)?.timestamp ?? startedAt
  const capturedAt = typeof now === 'function' ? now() : new Date().toISOString()

  return Object.freeze({
    id: sourceFingerprint,
    project,
    chat: {
      id: `chat-codex-import-${chatIdentity}`,
      projectId: project.id,
      title: `Codex conversation · ${sessionId.slice(-12)}`,
      subtitle: `Imported from Codex CLI · ${messages.length} visible messages`,
      group: importGroup(startedAt, new Date(capturedAt)),
      provider: 'codex',
      providerMode: 'fixed',
      model: null,
      sizeTier: null,
      messages,
      importSource: {
        kind: 'codex_session',
        sessionId,
        projectPath: project.path,
        sourceFingerprint,
        transcriptSha256: transcript.sha256,
        transcriptBytes: transcript.byteLength,
        historySha256: history.sha256,
        historyBytes: history.byteLength,
        messageIds,
        startedAt,
        lastVisibleAt,
      },
    },
    tab: {
      id: `tab-codex-import-${chatIdentity}`,
      chatId: `chat-codex-import-${chatIdentity}`,
    },
    report: {
      sessionId,
      transcriptBytes: transcript.byteLength,
      transcriptSha256: transcript.sha256,
      transcriptLines: transcriptLines.lineCount,
      transcriptIncompleteTailExcluded: transcriptLines.incompleteTailExcluded,
      historyBytes: history.byteLength,
      historySha256: history.sha256,
      historyLines: historyLines.lineCount,
      historyIncompleteTailExcluded: historyLines.incompleteTailExcluded,
      userMessages,
      assistantMessages,
      visibleCharacterCount,
      redactionCount,
      startedAt,
      lastVisibleAt,
      excludedCategories: Object.fromEntries([...excludedCategories.entries()].sort()),
    },
  })
}

/** Returns a candidate only to the exact operator-selected native workspace. */
export function createCodexConversationImportHandler({
  isAuthorized,
  identityForWebContents,
  transcriptPath,
  historyPath,
  projectPath,
  targetWorkspaceId,
  confirmation,
  parseImport = parseCodexConversationImport,
} = {}) {
  if (typeof isAuthorized !== 'function' || typeof identityForWebContents !== 'function') {
    throw new TypeError('Codex conversation import authorization is required.')
  }
  const configured = [transcriptPath, historyPath, projectPath, targetWorkspaceId, confirmation]
    .some((value) => typeof value === 'string' && value)
  if (!configured) return async () => null
  if (![transcriptPath, historyPath, projectPath, targetWorkspaceId].every((value) => typeof value === 'string' && value)
    || !WORKSPACE_ID_PATTERN.test(targetWorkspaceId)
    || confirmation !== CODEX_CONVERSATION_IMPORT_CONFIRMATION) {
    throw new Error('Codex conversation import requires complete paths, an exact target workspace UUID, and explicit IMPORT CODEX confirmation.')
  }
  const normalizedTarget = targetWorkspaceId.toLowerCase()
  let candidate = null
  return async (event) => {
    if (!isAuthorized(event)) return null
    const identity = identityForWebContents(event.sender)
    if (identity?.id?.toLowerCase() !== normalizedTarget) return null
    candidate ??= parseImport({ transcriptPath, historyPath, projectPath })
    if (!candidate || !SHA256_PATTERN.test(candidate.id)) {
      throw new Error('The Codex conversation import candidate is invalid.')
    }
    return candidate
  }
}
