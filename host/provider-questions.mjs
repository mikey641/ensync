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
      header: text(question.topic),
      question: prompt,
      multiSelect: question.multiSelect === true,
      options: optionList(question.options, (option) => {
        const label = text(option)
        return label ? { label, description: null } : null
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
      header: text(question.header),
      question: prompt,
      multiSelect: question.multiSelect === true,
      options: optionList(question.options, (option) => {
        if (!option || typeof option !== 'object') return null
        const label = text(option.label)
        return label ? { label, description: text(option.description) || null } : null
      }),
    }
  }).filter(Boolean)
  if (questions.length === 0) return null
  return { questions }
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
