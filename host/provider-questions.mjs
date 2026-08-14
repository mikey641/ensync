/**
 * Provider-neutral interactive questions.
 *
 * Two Ensync runners can pause a turn to ask the person a question. Both wire
 * formats are pinned from verified sources, not guessed:
 *
 * Factory Droid — `droid.ask_user`, a server-to-client JSON-RPC request over
 * `droid exec --input-format stream-jsonrpc`. Schema read from the published
 * `@factory/droid-sdk` 0.7.0 type surface (`AskUserRequestParamsSchema`,
 * `AskUserResultSchema`):
 *   params: { toolCallId: string,
 *             questions: [{ index: number, topic: string, question: string,
 *                           options: string[], multiSelect?: boolean }] }
 *   result: { cancelled?: boolean,
 *             answers: [{ index: number, question: string, answer: string }] }
 * The answer echoes the question text back, so the Host must answer from the
 * question it was given rather than from anything the renderer re-sends.
 *
 * Claude Code — the `AskUserQuestion` tool, surfaced in `--print` mode only
 * when the Host passes `--permission-prompt-tool stdio` together with
 * `--input-format stream-json`. Verified live against claude 2.1.226:
 *   {"type":"control_request","request_id":"…","request":{
 *      "subtype":"can_use_tool","tool_name":"AskUserQuestion",
 *      "input":{"questions":[{"question":…,"header":…,
 *                             "options":[{"label":…,"description":…}],
 *                             "multiSelect":false}]},
 *      "tool_use_id":"…","requires_user_interaction":true}}
 * Headless Claude has no channel that returns a *successful* AskUserQuestion
 * result: answering the control request with `{behavior:"allow"}` runs the tool
 * with no dialog attached and it reports "The user did not answer the
 * questions", and `updatedInput` is schema-checked against the tool's own input
 * (questions), so it cannot carry answers. The one verified way to deliver the
 * person's words to the model is the denial message, which reaches the model
 * verbatim as the tool result. Measured end to end: Claude read the answer and
 * continued the turn with it. The cost is that the tool result is flagged
 * `is_error` and the call is listed in `permission_denials`; that is a Claude
 * headless limitation, not an Ensync choice, and it is never presented to the
 * user as a failure.
 */

const MAX_QUESTIONS = 8
const MAX_OPTIONS = 16
const MAX_TEXT_CHARACTERS = 2_000
const MAX_ANSWER_CHARACTERS = 4_000
const MAX_PERMISSION_TOOL_USES = 8

/**
 * Factory Droid asks the client to approve a tool call with
 * `droid.request_permission`. Schema pinned from the published
 * `@factory/droid-sdk` 0.7.0 type surface (`RequestPermissionRequestParamsSchema`,
 * `RequestPermissionResultSchema`) and captured live from droid 0.191.1 asking
 * to run `git push origin main` at the pinned `medium` autonomy level:
 *   params: { toolUses: [{ toolUse: { type, id, name, input },
 *                          confirmationType,
 *                          details: <discriminated union on `type`> }],
 *             options: [{ value: ToolConfirmationOutcome, label, selectedColor?,
 *                         selectedPrefix? }],
 *             associatedSessionIds?: string[] }
 *   result: { selectedOption: ToolConfirmationOutcome,
 *             comment?: string, editedSpecContent?: string }
 * The outcome must be one Droid itself offered — anything else is treated as a
 * failed handler and cancelled — so Ensync only ever answers with a value it
 * read out of that `options` list.
 */
export const DROID_DECLINE_OUTCOME = 'cancel'
/**
 * The only outcome Ensync offers as approval, and it is an allow-list on
 * purpose. Every other `ToolConfirmationOutcome` Droid lists decides more than
 * the call in front of the person:
 *
 * - `proceed_always*` (live label: "Yes, and always allow high impact commands
 *   (all commands)") persists an allow rule in the shared Factory config, so it
 *   would pre-approve later runs — including the unattended ones that have no
 *   question channel at all and decline everything today.
 * - `proceed_auto_run*` and `proceed_new_session*` raise autonomy for the rest
 *   of the session, which would quietly falsify the pinned level the Host
 *   verifies before it sends a prompt (`#assertContainmentPinned`).
 * - `proceed_edit` is refused by Droid's own result schema unless the client
 *   also sends `editedSpecContent`, which Ensync has no surface to collect.
 *
 * Declining is never listed either: it is the card's own "Don't allow" action,
 * which resolves to `cancel` — the same outcome Ensync has always sent.
 */
const DROID_OFFERED_OUTCOMES = new Set(['proceed_once'])

// One line per `ToolConfirmationType`, phrased as the thing being permitted.
const PERMISSION_ACTIONS = {
  exec: 'run this command',
  edit: 'edit this file',
  create: 'create this file',
  apply_patch: 'apply this patch',
  mcp_tool: 'call this MCP tool',
  sandbox_violation: 'do this, which the sandbox blocked',
  droid_shield_violation: 'run this command, which Droid Shield flagged',
  exit_spec_mode: 'leave spec mode and start building',
  propose_mission: 'start this mission',
  start_mission_run: 'start another mission run',
  ask_user: 'ask you a question',
}
const PERMISSION_HEADERS = {
  exec: 'Run command',
  edit: 'Edit file',
  create: 'Create file',
  apply_patch: 'Apply patch',
  mcp_tool: 'MCP tool',
  sandbox_violation: 'Sandbox rule',
  droid_shield_violation: 'Droid Shield',
  exit_spec_mode: 'Spec mode',
  propose_mission: 'Mission',
  start_mission_run: 'Mission run',
  ask_user: 'Question',
}

/** Ensync never invents an approval: an unanswered question is a refusal to answer, not consent. */
export const CLAUDE_NON_QUESTION_DENIAL =
  'Ensync runs Claude Code non-interactively and only relays AskUserQuestion prompts to the person. This tool needs an approval Ensync cannot grant, so it was not run. Continue with an approach that does not require it, or explain what you need.'

export class ProviderQuestionError extends Error {
  constructor(code, message, status = 400, safeToRetry = false) {
    super(message)
    this.name = 'ProviderQuestionError'
    this.code = code
    this.status = status
    this.safeToRetry = safeToRetry
  }
}

function text(value, fallback = '') {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  if (!trimmed) return fallback
  return trimmed.length > MAX_TEXT_CHARACTERS ? trimmed.slice(0, MAX_TEXT_CHARACTERS) : trimmed
}

function optionList(options, toOption) {
  if (!Array.isArray(options)) return []
  return options
    .slice(0, MAX_OPTIONS)
    .map(toOption)
    .filter((option) => option !== null)
}

/**
 * Droid sends its own `index` per question and expects it back. Claude sends no
 * index at all, so the Host assigns array position. Either way the renderer
 * answers by index and never by re-sending question text, which keeps a
 * renderer from rewording what the provider asked.
 */
export function normalizeDroidQuestions(params) {
  if (!params || typeof params !== 'object') return null
  const source = Array.isArray(params.questions) ? params.questions : []
  const questions = source.slice(0, MAX_QUESTIONS).map((question, position) => {
    if (!question || typeof question !== 'object') return null
    const prompt = text(question.question)
    if (!prompt) return null
    return {
      index: Number.isSafeInteger(question.index) ? question.index : position,
      kind: 'question',
      header: text(question.topic),
      question: prompt,
      multiSelect: question.multiSelect === true,
      options: optionList(question.options, (option) => {
        const label = text(option)
        return label ? { label, description: null, value: null } : null
      }),
    }
  }).filter(Boolean)
  if (questions.length === 0) return null
  return {
    toolCallId: text(params.toolCallId) || null,
    questions,
  }
}

export function normalizeClaudeQuestions(input) {
  if (!input || typeof input !== 'object') return null
  const source = Array.isArray(input.questions) ? input.questions : []
  const questions = source.slice(0, MAX_QUESTIONS).map((question, position) => {
    if (!question || typeof question !== 'object') return null
    const prompt = text(question.question)
    if (!prompt) return null
    return {
      index: position,
      kind: 'question',
      header: text(question.header),
      question: prompt,
      multiSelect: question.multiSelect === true,
      options: optionList(question.options, (option) => {
        if (!option || typeof option !== 'object') return null
        const label = text(option.label)
        return label ? { label, description: text(option.description) || null, value: null } : null
      }),
    }
  }).filter(Boolean)
  if (questions.length === 0) return null
  return { questions }
}

/**
 * What is actually being permitted, in the person's terms. Only fields that
 * describe the call are used: patch bodies and file contents are left out
 * because a decision card is not a diff viewer, and the full command is
 * preferred over Droid's shortened `command` ("git push" for a live
 * `git push origin main`).
 */
function permissionDetail(details, toolUse) {
  if (!details || typeof details !== 'object') return text(toolUse?.name)
  const lines = (...values) => values.map((value) => text(value)).filter(Boolean).join('\n')
  switch (details.type) {
    case 'exec':
      // The command first and on its own line: it is the one part of this
      // payload that is always exact. `impactLevel` is Droid's own enum, and
      // `riskLevelReason` is model prose that has been observed arriving with
      // its spaces collapsed, so neither is what the decision rests on.
      return lines(
        details.fullCommand || details.command,
        details.impactLevel ? `Impact: ${text(details.impactLevel)}` : '',
        details.riskLevelReason,
      )
    case 'edit':
    case 'create':
    case 'apply_patch':
      return lines(details.filePath || details.fileName)
    case 'mcp_tool':
      return lines(
        [text(details.serverName), text(details.actualToolName) || text(details.toolName)].filter(Boolean).join(' · '),
        details.impactLevel ? `Impact: ${text(details.impactLevel)}` : '',
      )
    case 'sandbox_violation':
      return lines(
        [text(details.violatingToolName), text(details.target)].filter(Boolean).join(' → '),
        details.reason,
      )
    case 'droid_shield_violation':
      return lines(details.command, details.reason)
    case 'exit_spec_mode':
      return lines(details.title || details.plan)
    case 'propose_mission':
      return lines(details.title || details.proposal)
    case 'start_mission_run':
      return Number.isSafeInteger(details.runningMissionCount)
        ? `${details.runningMissionCount} mission run${details.runningMissionCount === 1 ? '' : 's'} already active`
        : ''
    case 'ask_user':
      return lines(details.questionnaire)
    default:
      return text(toolUse?.name)
  }
}

function permissionEntry(entry) {
  if (!entry || typeof entry !== 'object') return null
  const type = text(entry.details?.type) || text(entry.confirmationType)
  if (!type) return null
  return {
    header: PERMISSION_HEADERS[type] ?? 'Permission',
    action: PERMISSION_ACTIONS[type] ?? `use ${text(entry.toolUse?.name) || 'a tool'}`,
    detail: permissionDetail(entry.details, entry.toolUse),
  }
}

function permissionOptions(options) {
  if (!Array.isArray(options)) return []
  const seen = new Set()
  const offered = []
  for (const option of options.slice(0, MAX_OPTIONS)) {
    if (!option || typeof option !== 'object') continue
    const value = text(option.value)
    if (!value || seen.has(value) || !DROID_OFFERED_OUTCOMES.has(value)) continue
    seen.add(value)
    offered.push({ label: text(option.label) || value, description: null, value })
  }
  return offered
}

/**
 * A `droid.request_permission` request as one provider-neutral question: the
 * approval is a single decision over the whole request, because Droid's result
 * is a single `selectedOption` for every tool use it listed.
 *
 * Returns null — meaning "decline it the way Ensync always has" — when the
 * request names no tool use Ensync can describe, or when Droid offered no
 * outcome Ensync is willing to present. Never approving something the person
 * cannot see is the point: an unreadable request is not consent material.
 */
export function normalizeDroidPermission(params) {
  if (!params || typeof params !== 'object') return null
  const options = permissionOptions(params.options)
  if (options.length === 0) return null
  const source = Array.isArray(params.toolUses) ? params.toolUses.slice(0, MAX_PERMISSION_TOOL_USES) : []
  const entries = source.map(permissionEntry).filter(Boolean)
  if (entries.length === 0) return null
  const body = entries.length === 1
    ? `Allow Factory Droid to ${entries[0].action}?${entries[0].detail ? `\n\n${entries[0].detail}` : ''}`
    : `Allow Factory Droid to do all of this?\n\n${entries
      .map((entry) => `• ${entry.action}${entry.detail ? `\n${entry.detail}` : ''}`)
      .join('\n\n')}`
  // A card that silently cut off half the request would be asking for consent
  // to something the person cannot see, so a clipped description says so.
  const shown = text(body)
  const complete = shown.length >= body.trim().length
  return {
    toolCallId: text(source[0]?.toolUse?.id) || null,
    question: {
      index: 0,
      kind: 'permission',
      header: entries.length === 1 ? entries[0].header : 'Permission',
      question: complete
        ? shown
        : `${shown}\n\n… Ensync could not show all of this request. Decline it if you cannot see what you would be approving.`,
      multiSelect: false,
      options,
    },
  }
}

/**
 * The `droid.request_permission` result. Anything other than a chosen approval
 * is the documented decline, so a cancelled, malformed, or run-ended question
 * lands on exactly the outcome Ensync sent before this surface existed.
 */
export function droidPermissionResult(resolution) {
  const chosen = resolution?.cancelled === true
    ? null
    : (resolution?.answers ?? []).find((answer) => typeof answer?.value === 'string' && answer.value)
  return { selectedOption: chosen ? chosen.value : DROID_DECLINE_OUTCOME }
}

/** The exact `droid.ask_user` result shape, built from the questions Droid asked. */
export function droidAskUserResult(resolution) {
  if (resolution.cancelled) return { cancelled: true, answers: [] }
  return {
    cancelled: false,
    answers: resolution.answers.map((answer) => ({
      index: answer.index,
      question: answer.question,
      answer: answer.answer,
    })),
  }
}

/**
 * The person's words, formatted for the one channel headless Claude has. The
 * text is deliberately explicit that these are answers rather than a policy
 * refusal, so the model treats the denial as the reply it was waiting for.
 */
export function claudeAnswerMessage(resolution) {
  if (resolution.cancelled) {
    return 'The person did not answer these questions in Ensync. Do not ask again; continue with your best judgement, or explain what is blocked and stop.'
  }
  const answers = resolution.answers
    .map((answer) => `${answer.question}\n${answer.answer}`)
    .join('\n\n')
  return `The person answered your questions in Ensync. These are their real answers — treat them as the AskUserQuestion result and do not ask again.\n\n${answers}\n\nContinue the task with these answers.`
}

/**
 * An approval is an enum, not prose: the provider only accepts an outcome it
 * offered, so a typed sentence can never be turned into one. The chosen option
 * is matched by its value, or by an exact label match for a client that only
 * has the label.
 */
function matchPermissionOption(question, entry) {
  const value = typeof entry.value === 'string' ? entry.value.trim() : ''
  const label = typeof entry.answer === 'string' ? entry.answer.trim() : ''
  const chosen = question.options.find((option) => (value ? option.value === value : option.label === label))
  if (!chosen) {
    throw new ProviderQuestionError(
      'invalid_question_answer',
      'Choose one of the options the provider offered, or decline the request.',
      400,
      true,
    )
  }
  return { index: question.index, question: question.question, answer: chosen.label, value: chosen.value }
}

function normalizeAnswers(questions, input) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ProviderQuestionError('invalid_question_answer', 'Answer every question before sending it to the provider.', 400, true)
  }
  const byIndex = new Map(questions.map((question) => [question.index, question]))
  const answers = new Map()
  for (const entry of input) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new ProviderQuestionError('invalid_question_answer', 'Each answer must name the question it answers.', 400, true)
    }
    const question = byIndex.get(entry.index)
    if (!question) {
      throw new ProviderQuestionError('invalid_question_answer', 'That answer does not match any question the provider asked.', 400, true)
    }
    if (question.kind === 'permission') {
      answers.set(question.index, matchPermissionOption(question, entry))
      continue
    }
    const answer = typeof entry.answer === 'string' ? entry.answer.trim() : ''
    if (!answer) {
      throw new ProviderQuestionError('invalid_question_answer', 'An empty answer is not an answer. Enter a response or cancel the question.', 400, true)
    }
    if (answer.length > MAX_ANSWER_CHARACTERS) {
      throw new ProviderQuestionError(
        'invalid_question_answer',
        `That answer is too long. Ensync accepts up to ${MAX_ANSWER_CHARACTERS.toLocaleString()} characters.`,
        413,
        true,
      )
    }
    answers.set(question.index, { index: question.index, question: question.question, answer })
  }
  const missing = questions.filter((question) => !answers.has(question.index))
  if (missing.length > 0) {
    throw new ProviderQuestionError(
      'invalid_question_answer',
      `Answer every question first: ${missing.length} of ${questions.length} ${missing.length === 1 ? 'is' : 'are'} still unanswered.`,
      400,
      true,
    )
  }
  return questions.map((question) => answers.get(question.index))
}

/**
 * The single shape every runner emits, so the renderer never has to know which
 * provider paused the turn.
 */
export function providerQuestionEvent(provider, id, questions, askedAt) {
  return {
    type: 'question',
    provider,
    questionId: id,
    questions,
    at: askedAt,
  }
}

export function providerQuestionResolvedEvent(provider, id, resolution, resolvedAt) {
  return {
    type: 'question_resolved',
    provider,
    questionId: id,
    cancelled: resolution.cancelled === true,
    answers: resolution.cancelled === true ? [] : resolution.answers,
    at: resolvedAt,
  }
}

/**
 * Holds the questions one provider run is waiting on. The provider process is
 * blocked while a question is pending, so the registry is also what tells the
 * runner to stop counting that silence against its inactivity watchdog.
 */
export class ProviderQuestionRegistry {
  #pending = new Map()
  #counter = 0
  #idPrefix
  #closed = false

  constructor(options = {}) {
    this.#idPrefix = typeof options.idPrefix === 'string' && options.idPrefix ? options.idPrefix : 'question'
  }

  get size() {
    return this.#pending.size
  }

  /**
   * Registers a question and returns the record plus the promise the runner
   * awaits. The promise settles exactly once: an answer, an explicit
   * cancellation, or the run ending underneath it.
   */
  ask(question) {
    const id = `${this.#idPrefix}-${++this.#counter}`
    // A frame that arrives after the run ended still needs a settled promise:
    // the runner must be able to answer the CLI rather than throw at it from
    // inside a stream handler.
    if (this.#closed) {
      return { id, questions: question.questions, answered: Promise.resolve({ cancelled: true, answers: [] }) }
    }
    const questions = question.questions
    let settle
    const answered = new Promise((resolve) => { settle = resolve })
    this.#pending.set(id, {
      id,
      provider: question.provider,
      toolCallId: question.toolCallId ?? null,
      questions,
      askedAt: question.askedAt,
      settle,
    })
    return { id, questions, answered }
  }

  answer(id, input) {
    const record = this.#pending.get(id)
    if (!record) {
      throw new ProviderQuestionError(
        'question_not_found',
        'That question is no longer waiting for an answer. The provider either moved on or the run ended.',
        409,
        false,
      )
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      throw new ProviderQuestionError('invalid_question_answer', 'An answer payload is required.', 400, true)
    }
    const resolution = input.cancelled === true
      ? { cancelled: true, answers: [] }
      : { cancelled: false, answers: normalizeAnswers(record.questions, input.answers) }
    this.#pending.delete(id)
    record.settle(resolution)
    return { id, ...resolution }
  }

  /** Every unanswered question resolves as cancelled so no runner can hang on a dead process. */
  closeAll() {
    this.#closed = true
    const pending = [...this.#pending.values()]
    this.#pending.clear()
    for (const record of pending) record.settle({ cancelled: true, answers: [] })
    return pending.map((record) => record.id)
  }

  list() {
    return [...this.#pending.values()].map((record) => ({
      id: record.id,
      provider: record.provider,
      questions: record.questions,
      askedAt: record.askedAt,
    }))
  }
}
