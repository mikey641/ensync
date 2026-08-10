import {
  CLAUDE_NON_QUESTION_DENIAL,
  ProviderQuestionRegistry,
  claudeAnswerMessage,
  normalizeClaudeQuestions,
  providerQuestionEvent,
  providerQuestionResolvedEvent,
} from './provider-questions.mjs'

/**
 * Claude Code's interactive-question channel for `--print` runs.
 *
 * Pinned per live verification against claude 2.1.226. `--permission-prompt-tool
 * stdio` is the value the official Agent SDK passes when a client supplies a
 * `canUseTool` callback; with `--input-format stream-json` the CLI then writes
 * `control_request` frames to stdout and reads `control_response` frames from a
 * stdin that stays open.
 *
 * Two measured facts shape this module:
 *
 * 1. Taking over the prompt channel does not widen or narrow what Claude may
 *    do. A run that executed Bash and Read produced no control request at all:
 *    the CLI consults the prompt tool only for a call that would otherwise have
 *    to ask a human. So every non-AskUserQuestion request is denied here, which
 *    reproduces exactly what headless Claude already did on its own before
 *    Ensync attached to the channel.
 * 2. The CLI does not exit while stream-json stdin is open. It exits cleanly
 *    (code 0) once stdin ends, so the channel closes stdin the moment the
 *    terminal `result` frame arrives, and the run's normal parsing is unchanged.
 */
export function claudeQuestionArguments() {
  return ['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio']
}

/** The stream-json equivalent of the plain-text prompt Ensync writes today. */
export function claudeUserMessageLine(prompt) {
  return `${JSON.stringify({
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: prompt }] },
    parent_tool_use_id: null,
    session_id: 'ensync-host',
  })}\n`
}

function controlSuccess(requestId, response) {
  return `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'success', request_id: requestId, response },
  })}\n`
}

function controlError(requestId, error) {
  return `${JSON.stringify({
    type: 'control_response',
    response: { subtype: 'error', request_id: requestId, error },
  })}\n`
}

/**
 * Reads Claude's stdout frames and answers the ones that need a client.
 *
 * `write` and `endInput` come from the process runner so this module never owns
 * the child process; `hold`/`release` pause the inactivity watchdog, because a
 * person thinking about a question is not a hung CLI.
 */
export function createClaudeQuestionChannel(options = {}) {
  const { write, endInput, onEvent, now = () => new Date().toISOString() } = options
  const hold = options.hold ?? (() => {})
  const release = options.release ?? (() => {})
  const registry = options.registry ?? new ProviderQuestionRegistry({ idPrefix: 'claude' })
  // Claude cancels a control request by id when the turn moves on without it.
  const inFlight = new Map()
  let closed = false

  const respondToQuestion = async (requestId, input) => {
    const normalized = normalizeClaudeQuestions(input)
    if (!normalized) {
      write(controlSuccess(requestId, {
        behavior: 'deny',
        message: 'Ensync could not read the questions in that AskUserQuestion call. Ask again with clearly worded questions and options.',
      }))
      return
    }
    const askedAt = now()
    const { id, questions, answered } = registry.ask({
      provider: 'claude',
      questions: normalized.questions,
      askedAt,
    })
    inFlight.set(requestId, id)
    onEvent?.(providerQuestionEvent('claude', id, questions, askedAt))
    hold()
    let resolution
    try {
      resolution = await answered
    } finally {
      inFlight.delete(requestId)
      release()
    }
    onEvent?.(providerQuestionResolvedEvent('claude', id, resolution, now()))
    // The denial message is the only verified way to hand a real answer back to
    // a headless Claude turn; see provider-questions.mjs for the measurement.
    write(controlSuccess(requestId, {
      behavior: 'deny',
      message: claudeAnswerMessage(resolution),
    }))
  }

  return {
    registry,
    /** Feeds one stdout line; returns true when the line was a protocol frame this channel owns. */
    handleLine(line) {
      // A trailing frame flushed after the process ended has nothing left to
      // answer, and must never start a question nobody can resolve.
      if (closed) return false
      if (typeof line !== 'string' || !line.trim()) return false
      let message
      try {
        message = JSON.parse(line)
      } catch {
        // Claude's own result parsing owns malformed output; the channel only
        // acts on frames it can fully verify.
        return false
      }
      if (!message || typeof message !== 'object' || Array.isArray(message)) return false

      if (message.type === 'control_cancel_request') {
        const questionId = inFlight.get(message.request_id)
        if (questionId) registry.answer(questionId, { cancelled: true })
        return true
      }

      if (message.type === 'control_request' && typeof message.request_id === 'string') {
        const request = message.request
        if (request?.subtype !== 'can_use_tool') {
          write(controlError(message.request_id, 'Unsupported Ensync client control request.'))
          return true
        }
        if (request.tool_name !== 'AskUserQuestion') {
          write(controlSuccess(message.request_id, { behavior: 'deny', message: CLAUDE_NON_QUESTION_DENIAL }))
          return true
        }
        // A question failing here must not become an unhandled rejection in the
        // Host: the CLI is told the question went unanswered instead.
        void respondToQuestion(message.request_id, request.input).catch(() => {
          write(controlSuccess(message.request_id, {
            behavior: 'deny',
            message: 'Ensync could not put that question to the person. Continue without an answer or explain what is blocked.',
          }))
        })
        return true
      }

      // The CLI keeps stream-json stdin open indefinitely; the terminal result
      // is the Host's signal that closing it will produce a clean exit.
      if (message.type === 'result') {
        endInput()
        return true
      }
      return false
    },
    /** Releases every unanswered question so a dead process cannot leave the run blocked. */
    close() {
      closed = true
      const cancelled = registry.closeAll()
      inFlight.clear()
      release()
      return cancelled
    },
  }
}
