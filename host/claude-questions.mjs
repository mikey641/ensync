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
 *    (code 0) once stdin ends, so the channel closes stdin when a turn's
 *    `result` frame arrives, and the run's normal parsing is unchanged.
 *
 * One exception, measured against claude 2.1.267: a background subagent. Plain
 * `claude -p`, whose stdin is closed from the start, keeps running while one is
 * live and gives the parent a follow-up turn when it reports; a background shell
 * it stops at exit. Closing stream-json stdin at the first `result` instead ended
 * the run while a subagent was still working: the subagent was interrupted later
 * and the parent never read its report. So stdin stays open while Claude's
 * `background_tasks_changed` level lists a subagent, and closes at the next
 * `result` once none is live.
 *
 * Background shells, measured against claude 2.1.296: while stream-json stdin
 * stays open, a shell that exits emits `task_notification` and Claude opens a
 * follow-up turn that reads its output, exactly as interactive Claude Code
 * re-invokes the agent. A turn that ends with "I'll report when the watcher
 * finishes" therefore needs stdin open too. A shell may also be a dev server
 * that never exits, so the wait for shells alone is bounded, and the silent
 * wait holds the inactivity watchdog because an idle CLI is expected there.
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

/** Background subagents: headless Claude waits for their report. */
const SUBAGENT_TASK_TYPES = new Set(['local_agent'])

/**
 * Background shells: Claude wakes the parent when one exits, but only while
 * stdin is open, and a dev server never exits, so the wait is bounded.
 */
const SHELL_TASK_TYPES = new Set(['local_bash'])

/**
 * How long a run waits for background shells once no turn and no subagent is
 * running. Long enough for a watcher the agent promised to report on; a shell
 * still running after it is stopped by Claude when stdin closes.
 */
const BACKGROUND_SHELL_WAIT_MS = 30 * 60 * 1_000

/**
 * How long a subagent that has reported may take to wake the parent's follow-up
 * turn. Claude opens it within milliseconds; a report that wakes nothing must not
 * hold stdin open until the inactivity watchdog fails the run.
 */
const BACKGROUND_SETTLE_MS = 30_000

function backgroundTaskCount(tasks, types) {
  // An unreadable level waits for nothing, which is how the channel behaved before.
  if (!Array.isArray(tasks)) return 0
  return tasks.filter((task) => types.has(task?.task_type)).length
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
  // `onHeldResult` receives the text of a turn that ended while a subagent was
  // still working: progress to show, not the run's answer.
  const { write, endInput, onEvent, onHeldResult, now = () => new Date().toISOString() } = options
  const settleMs = options.backgroundSettleMs ?? BACKGROUND_SETTLE_MS
  const shellWaitMs = options.backgroundShellWaitMs ?? BACKGROUND_SHELL_WAIT_MS
  const hold = options.hold ?? (() => {})
  const release = options.release ?? (() => {})
  const registry = options.registry ?? new ProviderQuestionRegistry({ idPrefix: 'claude' })
  // Claude cancels a control request by id when the turn moves on without it.
  const inFlight = new Map()
  let closed = false
  // Live subagents and shells in Claude's latest `background_tasks_changed` level.
  let liveSubagents = 0
  let liveShells = 0
  // The prompt starts the first turn; Claude opens every later one with `init`.
  let turnRunning = true
  // A turn ended while a background task was live, so stdin was left open for it.
  let awaitingBackground = false
  let settleTimer = null
  // Bounds a wait that only shells keep open; it holds the inactivity watchdog.
  let shellWaitTimer = null

  const cancelSettle = () => {
    if (settleTimer) clearTimeout(settleTimer)
    settleTimer = null
  }
  const cancelShellWait = () => {
    if (!shellWaitTimer) return
    clearTimeout(shellWaitTimer)
    shellWaitTimer = null
    release()
  }
  const finishInput = () => {
    cancelSettle()
    cancelShellWait()
    awaitingBackground = false
    endInput()
  }
  // An idle parent waiting only on shells is silent by design, so the watchdog
  // is held and this bound replaces it. A live subagent keeps its own output
  // flowing and needs neither.
  const syncShellWait = () => {
    const shellsOnly = awaitingBackground && !turnRunning && liveSubagents === 0 && liveShells > 0
    if (!shellsOnly) {
      cancelShellWait()
      return
    }
    if (shellWaitTimer) return
    hold()
    shellWaitTimer = setTimeout(() => {
      shellWaitTimer = null
      release()
      if (!closed && awaitingBackground && !turnRunning) finishInput()
    }, shellWaitMs)
    shellWaitTimer.unref?.()
  }
  // The assistant text Claude wrote immediately before the AskUserQuestion call
  // it is about to make. It rides on the question so the renderer can show it as
  // the ordinary agent message it is; see CLAUDE_ASK_PERSON_TOOL in chat.mjs.
  let questionMessage = ''

  const respondToQuestion = async (requestId, input) => {
    // Consumed by the first question that follows it, so a later ask can never
    // inherit words written for an earlier one.
    const message = questionMessage
    questionMessage = ''
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
    onEvent?.(providerQuestionEvent('claude', id, questions, askedAt, message))
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
    /**
     * Records the agent's own words in front of the question it is about to
     * ask. The stream carries them one frame ahead of the control request, so
     * they are held here until that request turns into a question event.
     */
    noteQuestionMessage(text) {
      questionMessage = typeof text === 'string' ? text.trim() : ''
    },
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

      if (message.type === 'system' && message.subtype === 'background_tasks_changed') {
        liveSubagents = backgroundTaskCount(message.tasks, SUBAGENT_TASK_TYPES)
        liveShells = backgroundTaskCount(message.tasks, SHELL_TASK_TYPES)
        const idleAwaiting = awaitingBackground && !turnRunning
        // The last task reported while the parent sat idle. Claude wakes the
        // parent at once; if nothing wakes it, no report is left to wait for.
        if (idleAwaiting && liveSubagents === 0 && liveShells === 0 && !settleTimer) {
          settleTimer = setTimeout(() => {
            settleTimer = null
            if (!closed && awaitingBackground && !turnRunning && liveSubagents === 0 && liveShells === 0) finishInput()
          }, settleMs)
          settleTimer.unref?.()
        }
        syncShellWait()
        return false
      }

      if (message.type === 'system' && message.subtype === 'init') {
        turnRunning = true
        cancelSettle()
        syncShellWait()
        return false
      }

      // The CLI keeps stream-json stdin open indefinitely; a turn's result is the
      // Host's signal that closing it will produce a clean exit — unless a live
      // subagent or shell can still wake the parent, which needs stdin open.
      if (message.type === 'result') {
        turnRunning = false
        if (liveSubagents + liveShells > 0 && message.is_error !== true) {
          awaitingBackground = true
          if (typeof message.result === 'string' && message.result.trim()) onHeldResult?.(message.result.trim())
          syncShellWait()
          return true
        }
        finishInput()
        return true
      }
      return false
    },
    /** Releases every unanswered question so a dead process cannot leave the run blocked. */
    close() {
      closed = true
      cancelSettle()
      if (shellWaitTimer) clearTimeout(shellWaitTimer)
      shellWaitTimer = null
      const cancelled = registry.closeAll()
      inFlight.clear()
      release()
      return cancelled
    },
  }
}
