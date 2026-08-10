import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { ChatRunService } from './chat.mjs'

import {
  initialQuestionSelection,
  pendingQuestionsAfterEvent,
  pendingQuestionsFromEvents,
  questionAnswerPayload,
  questionAnswerText,
  questionAnswersReady,
  setQuestionText,
  toggleQuestionOption,
} from '../src/lib/providerQuestions.mjs'
import { DroidExecRunner } from './droid-exec.mjs'
import { claudeQuestionArguments, claudeUserMessageLine, createClaudeQuestionChannel } from './claude-questions.mjs'
import {
  CLAUDE_NON_QUESTION_DENIAL,
  ProviderQuestionError,
  ProviderQuestionRegistry,
  claudeAnswerMessage,
  droidAskUserResult,
  normalizeClaudeQuestions,
  normalizeDroidQuestions,
} from './provider-questions.mjs'

const SESSION_ID = '05fff43e-686d-4c7c-9932-705556882455'

// Shapes copied from the published @factory/droid-sdk 0.7.0 type surface.
const DROID_ASK_PARAMS = {
  toolCallId: 'tool-call-1',
  questions: [
    {
      index: 0,
      topic: 'Storage',
      question: 'Which store should the cache use?',
      options: ['SQLite', 'Redis'],
      multiSelect: false,
    },
  ],
}

// Shape captured live from claude 2.1.226 over --permission-prompt-tool stdio.
const CLAUDE_ASK_INPUT = {
  questions: [
    {
      question: 'Which color do you prefer?',
      header: 'Color',
      options: [
        { label: 'Red', description: 'The color red' },
        { label: 'Blue', description: 'The color blue' },
      ],
      multiSelect: false,
    },
  ],
}

function waitFor(predicate) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 2_000
    const poll = () => {
      const value = predicate()
      if (value) return resolve(value)
      if (Date.now() > deadline) return reject(new Error('Timed out waiting for the expected state.'))
      setTimeout(poll, 5)
    }
    poll()
  })
}

test('droid ask_user params normalize into the provider-neutral question shape', () => {
  const normalized = normalizeDroidQuestions(DROID_ASK_PARAMS)
  assert.equal(normalized.toolCallId, 'tool-call-1')
  assert.deepEqual(normalized.questions, [{
    index: 0,
    header: 'Storage',
    question: 'Which store should the cache use?',
    multiSelect: false,
    options: [
      { label: 'SQLite', description: null },
      { label: 'Redis', description: null },
    ],
  }])
})

test('claude AskUserQuestion input normalizes into the same shape with per-option descriptions', () => {
  const normalized = normalizeClaudeQuestions(CLAUDE_ASK_INPUT)
  assert.deepEqual(normalized.questions, [{
    index: 0,
    header: 'Color',
    question: 'Which color do you prefer?',
    multiSelect: false,
    options: [
      { label: 'Red', description: 'The color red' },
      { label: 'Blue', description: 'The color blue' },
    ],
  }])
})

test('a questionnaire with no readable question is not turned into an empty prompt', () => {
  assert.equal(normalizeDroidQuestions({ questions: [{ index: 0, question: '   ', options: [] }] }), null)
  assert.equal(normalizeClaudeQuestions({ questions: [] }), null)
  assert.equal(normalizeClaudeQuestions(null), null)
})

test('every question must be answered before the answer reaches the provider', () => {
  const registry = new ProviderQuestionRegistry()
  const { id } = registry.ask({
    provider: 'droid',
    questions: [
      { index: 0, header: '', question: 'First?', multiSelect: false, options: [] },
      { index: 1, header: '', question: 'Second?', multiSelect: false, options: [] },
    ],
    askedAt: '2026-08-10T00:00:00.000Z',
  })
  assert.throws(
    () => registry.answer(id, { answers: [{ index: 0, answer: 'yes' }] }),
    (error) => error instanceof ProviderQuestionError
      && error.code === 'invalid_question_answer'
      && /1 of 2/.test(error.message),
  )
  assert.throws(() => registry.answer(id, { answers: [{ index: 7, answer: 'yes' }] }), /does not match any question/)
  assert.throws(() => registry.answer(id, { answers: [{ index: 0, answer: '  ' }] }), /empty answer/)
  // The question stays open after each refusal, so nothing is silently lost.
  assert.equal(registry.size, 1)
})

test('an answered question resolves once with the provider’s own question text', async () => {
  const registry = new ProviderQuestionRegistry({ idPrefix: 'droid' })
  const { id, answered } = registry.ask({
    provider: 'droid',
    questions: [{ index: 4, header: 'Storage', question: 'Which store?', multiSelect: false, options: [] }],
    askedAt: '2026-08-10T00:00:00.000Z',
  })
  registry.answer(id, { answers: [{ index: 4, answer: 'Redis' }] })
  const resolution = await answered
  assert.deepEqual(resolution, {
    cancelled: false,
    answers: [{ index: 4, question: 'Which store?', answer: 'Redis' }],
  })
  assert.deepEqual(droidAskUserResult(resolution), {
    cancelled: false,
    answers: [{ index: 4, question: 'Which store?', answer: 'Redis' }],
  })
  assert.throws(() => registry.answer(id, { answers: [{ index: 4, answer: 'again' }] }), /no longer waiting/)
})

test('closing the registry cancels every unanswered question so no runner can hang', async () => {
  const registry = new ProviderQuestionRegistry()
  const { answered } = registry.ask({
    provider: 'claude',
    questions: [{ index: 0, header: '', question: 'Which one?', multiSelect: false, options: [] }],
    askedAt: '2026-08-10T00:00:00.000Z',
  })
  registry.closeAll()
  assert.deepEqual(await answered, { cancelled: true, answers: [] })
  assert.deepEqual(droidAskUserResult({ cancelled: true, answers: [] }), { cancelled: true, answers: [] })
})

test('the claude answer message carries the real answers and never reads as a policy refusal', () => {
  const message = claudeAnswerMessage({
    cancelled: false,
    answers: [{ index: 0, question: 'Which color do you prefer?', answer: 'Blue' }],
  })
  assert.match(message, /Which color do you prefer\?/)
  assert.match(message, /Blue/)
  assert.match(message, /answered your questions/)
  assert.match(claudeAnswerMessage({ cancelled: true, answers: [] }), /did not answer/)
})

test('claude question arguments pair the stdio prompt tool with stream-json input', () => {
  assert.deepEqual(claudeQuestionArguments(), ['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio'])
  const line = claudeUserMessageLine('Ship it')
  assert.equal(line.endsWith('\n'), true)
  assert.deepEqual(JSON.parse(line), {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: 'Ship it' }] },
    parent_tool_use_id: null,
    session_id: 'ensync-host',
  })
})

function claudeChannel() {
  const written = []
  const events = []
  const state = { held: 0, released: 0, ended: 0 }
  const channel = createClaudeQuestionChannel({
    write: (chunk) => written.push(JSON.parse(chunk)),
    endInput: () => { state.ended += 1 },
    hold: () => { state.held += 1 },
    release: () => { state.released += 1 },
    onEvent: (event) => events.push(event),
    now: () => '2026-08-10T00:00:00.000Z',
  })
  return { channel, written, events, state }
}

test('a claude AskUserQuestion control request becomes a question and the answer reaches the model', async () => {
  const { channel, written, events, state } = claudeChannel()

  const owned = channel.handleLine(JSON.stringify({
    type: 'control_request',
    request_id: 'req-1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      input: CLAUDE_ASK_INPUT,
      tool_use_id: 'toolu_1',
      requires_user_interaction: true,
    },
  }))
  assert.equal(owned, true)

  const asked = await waitFor(() => events.find((event) => event.type === 'question'))
  assert.equal(asked.provider, 'claude')
  assert.equal(asked.questions[0].question, 'Which color do you prefer?')
  // The turn is genuinely blocked on a person, so the watchdog is held.
  assert.equal(state.held, 1)
  assert.equal(written.length, 0)

  channel.registry.answer(asked.questionId, { answers: [{ index: 0, answer: 'Blue' }] })

  const response = await waitFor(() => written[0])
  assert.equal(response.type, 'control_response')
  assert.equal(response.response.subtype, 'success')
  assert.equal(response.response.request_id, 'req-1')
  assert.equal(response.response.response.behavior, 'deny')
  assert.match(response.response.response.message, /Blue/)
  assert.equal(state.released, 1)

  const resolved = events.find((event) => event.type === 'question_resolved')
  assert.equal(resolved.cancelled, false)
  assert.deepEqual(resolved.answers, [{ index: 0, question: 'Which color do you prefer?', answer: 'Blue' }])
})

test('claude tool approvals other than a question stay denied exactly as headless claude denies them', () => {
  const { channel, written, events } = claudeChannel()
  channel.handleLine(JSON.stringify({
    type: 'control_request',
    request_id: 'req-2',
    request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm -rf /' }, tool_use_id: 'toolu_2' },
  }))
  assert.deepEqual(written, [{
    type: 'control_response',
    response: {
      subtype: 'success',
      request_id: 'req-2',
      response: { behavior: 'deny', message: CLAUDE_NON_QUESTION_DENIAL },
    },
  }])
  assert.deepEqual(events, [])
})

test('claude closes stdin on the terminal result and leaves ordinary output alone', () => {
  const { channel, written, state } = claudeChannel()
  assert.equal(channel.handleLine('{"type":"assistant","message":{"content":[]}}'), false)
  assert.equal(channel.handleLine('not json at all'), false)
  assert.equal(channel.handleLine(''), false)
  assert.equal(state.ended, 0)
  assert.equal(channel.handleLine('{"type":"result","subtype":"success"}'), true)
  assert.equal(state.ended, 1)
  assert.deepEqual(written, [])
})

test('a claude control request the Host does not implement is refused, never guessed at', () => {
  const { channel, written } = claudeChannel()
  channel.handleLine(JSON.stringify({
    type: 'control_request',
    request_id: 'req-3',
    request: { subtype: 'request_user_dialog', dialog_kind: 'refusal_fallback_prompt', payload: {} },
  }))
  assert.equal(written[0].response.subtype, 'error')
  assert.match(written[0].response.error, /Unsupported/)
})

test('a claude question left unanswered when the run ends resolves as cancelled', async () => {
  const { channel, written, events } = claudeChannel()
  channel.handleLine(JSON.stringify({
    type: 'control_request',
    request_id: 'req-4',
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: CLAUDE_ASK_INPUT, tool_use_id: 'toolu_4' },
  }))
  await waitFor(() => events.find((event) => event.type === 'question'))
  channel.close()
  const response = await waitFor(() => written[0])
  assert.match(response.response.response.message, /did not answer/)
})

test('a question frame flushed after the run ended is ignored instead of thrown at the Host', () => {
  const { channel, written, events } = claudeChannel()
  channel.close()
  const owned = channel.handleLine(JSON.stringify({
    type: 'control_request',
    request_id: 'req-late',
    request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: CLAUDE_ASK_INPUT, tool_use_id: 'toolu_late' },
  }))
  assert.equal(owned, false)
  assert.deepEqual(events, [])
  assert.deepEqual(written, [])
})

test('a closed registry still hands the runner a settled question rather than throwing', async () => {
  const registry = new ProviderQuestionRegistry()
  registry.closeAll()
  const late = registry.ask({
    provider: 'droid',
    questions: [{ index: 0, header: '', question: 'Still there?', multiSelect: false, options: [] }],
    askedAt: '2026-08-10T00:00:00.000Z',
  })
  assert.deepEqual(await late.answered, { cancelled: true, answers: [] })
})

/**
 * Speaks the droid 0.190.0 wire protocol and sends a `droid.ask_user` request
 * the way the CLI does: a server-to-client request in the middle of the turn.
 */
function fakeDroidExec({ askUser = true } = {}) {
  const child = new EventEmitter()
  child.stdin = new PassThrough()
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  child.exitCode = null
  child.signalCode = null
  child.kill = () => {
    child.exitCode = 0
    return true
  }

  const settings = {
    modelId: 'claude-opus-5',
    autonomyLevel: 'medium',
    interactionMode: 'auto',
  }
  const responses = []
  const send = (message) => child.stdout.write(`${JSON.stringify(message)}\n`)
  const notify = (notification) => send({
    jsonrpc: '2.0',
    type: 'notification',
    factoryApiVersion: '1.0.0',
    method: 'droid.session_notification',
    params: { sessionId: SESSION_ID, notification },
  })
  const respond = (id, result) => send({
    jsonrpc: '2.0',
    type: 'response',
    factoryApiVersion: '1.0.0',
    id,
    result,
  })
  const finish = () => {
    notify({
      type: 'create_message',
      message: { id: 'assistant-1', role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    })
    notify({ type: 'agent_turn_completed', reason: 'completed', turnId: 'turn-1' })
  }

  let buffer = ''
  child.stdin.on('data', (chunk) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      const message = JSON.parse(line)
      if (message.type === 'response') {
        responses.push(message)
        // Droid resumes the turn once the client answers the questionnaire.
        finish()
        continue
      }
      if (message.type !== 'request') continue
      if (message.method === 'droid.initialize_session') {
        respond(message.id, { sessionId: SESSION_ID, settings })
      } else if (message.method === 'droid.update_session_settings') {
        respond(message.id, { settings })
      } else if (message.method === 'droid.add_user_message') {
        respond(message.id, {})
        if (!askUser) return finish()
        send({
          jsonrpc: '2.0',
          type: 'request',
          factoryApiVersion: '1.0.0',
          id: 'server-ask-1',
          method: 'droid.ask_user',
          params: DROID_ASK_PARAMS,
        })
      } else if (message.method === 'droid.interrupt_session') {
        respond(message.id, {})
      }
    }
  })

  return { child, responses }
}

function droidInput(id) {
  return {
    ...(id ? { id } : {}),
    executable: '/usr/local/bin/droid',
    projectPath: '/tmp/project',
    prompt: 'Set up the cache',
    env: {},
  }
}

test('a droid questionnaire reaches the person and their answer completes the turn', async () => {
  const server = fakeDroidExec()
  const runner = new DroidExecRunner({ spawnProcess: () => server.child })
  const events = []
  const run = runner.run(droidInput('job-droid-question-0001'), {
    onEvent: (event) => events.push(event),
  })

  const asked = await waitFor(() => events.find((event) => event.type === 'question'))
  assert.equal(asked.provider, 'droid')
  assert.equal(asked.questions[0].question, 'Which store should the cache use?')
  assert.deepEqual(asked.questions[0].options.map((option) => option.label), ['SQLite', 'Redis'])

  runner.answerQuestion('job-droid-question-0001', asked.questionId, {
    answers: [{ index: 0, answer: 'Redis' }],
  })

  const result = await run
  assert.equal(result.response, 'done')
  // The wire result must use Droid's own AskUser result shape, echoing the
  // question text the CLI sent rather than anything the renderer supplied.
  assert.deepEqual(server.responses[0].result, {
    cancelled: false,
    answers: [{ index: 0, question: 'Which store should the cache use?', answer: 'Redis' }],
  })
  const resolved = events.find((event) => event.type === 'question_resolved')
  assert.equal(resolved.cancelled, false)
})

test('a droid run with no retained job still declines questionnaires safely', async () => {
  const server = fakeDroidExec()
  const runner = new DroidExecRunner({ spawnProcess: () => server.child })
  const events = []
  const result = await runner.run(droidInput(null), { onEvent: (event) => events.push(event) })
  assert.equal(result.response, 'done')
  assert.equal(events.some((event) => event.type === 'question'), false)
  assert.deepEqual(server.responses[0].result, { cancelled: true, answers: [] })
  assert.equal(
    events.some((event) => event.type === 'notice' && event.code === 'provider_request_declined'),
    true,
  )
})

test('an answer for a job with no live droid session is refused rather than dropped', () => {
  const runner = new DroidExecRunner({ spawnProcess: () => fakeDroidExec().child })
  assert.throws(
    () => runner.answerQuestion('job-droid-missing-000001', 'droid-1', { answers: [] }),
    (error) => error.code === 'question_not_found',
  )
})

// --- Claude run composition --------------------------------------------------
// Measured against claude 2.1.226: the CLI does not exit while stream-json stdin
// is open, so the terminal `result` frame must reach the channel *while the
// process is alive*. A line splitter that holds the last complete line back
// until the next chunk strands exactly that frame and hangs every run.

function claudeRunService(projectPath, script) {
  const captured = { args: null, input: null, keepStdinOpen: null, endInputCalled: 0 }
  const service = new ChatRunService({
    statusService: {
      async get() {
        return {
          id: 'claude',
          name: 'Claude Code',
          installed: true,
          executable: '/test/bin/claude',
          authentication: { state: 'authenticated', method: 'claude.ai OAuth', reason: 'logged in' },
        }
      },
    },
    environment: { PATH: '/test/bin' },
    processRunner: async (_executable, args, options) => {
      captured.args = args
      captured.input = options.input
      captured.keepStdinOpen = options.keepStdinOpen === true
      const written = []
      options.onSession?.({
        write: (chunk) => { written.push(chunk); return true },
        endInput: () => { captured.endInputCalled += 1; return true },
        holdInactivity: () => {},
        releaseInactivity: () => {},
      })
      const stdout = await script({ onStdout: options.onStdout, written })
      return { exitCode: 0, error: null, timedOut: false, aborted: false, stderr: '', stdout }
    },
  })
  return { service, captured, projectPath }
}

const CLAUDE_RESULT_LINE = JSON.stringify({
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Done',
  session_id: '9f1a8f2e-4c5d-4a2b-8f3e-1c2d3e4f5a6b',
})

test('the terminal claude frame reaches the channel while the process is still alive', async (context) => {
  const projectPath = await mkdtemp(join(tmpdir(), 'ensync-question-run-'))
  context.after(() => rm(projectPath, { recursive: true, force: true }))

  // The whole stream arrives as one chunk that ends with a newline — the exact
  // shape that used to leave the result line stuck in the forwarder's buffer.
  const { service, captured } = claudeRunService(projectPath, async ({ onStdout }) => {
    const stdout = `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } })}\n${CLAUDE_RESULT_LINE}\n`
    onStdout(stdout)
    return stdout
  })

  const result = await service.run(
    { provider: 'claude', projectPath, prompt: 'Ship it' },
    { liveTurnId: 'job-claude-question-0001', onEvent: () => {} },
  )

  assert.equal(result.response, 'Done')
  assert.equal(captured.keepStdinOpen, true)
  assert.deepEqual(captured.args.slice(-4), ['--input-format', 'stream-json', '--permission-prompt-tool', 'stdio'])
  // The prompt still travels as one text block, wrapped with the same Ensync
  // multi-agent contract a plain-text run receives.
  const sent = JSON.parse(captured.input)
  assert.equal(sent.type, 'user')
  assert.equal(sent.message.content.length, 1)
  assert.equal(sent.message.content[0].type, 'text')
  assert.equal(sent.message.content[0].text.endsWith('Ship it'), true)
  assert.equal(captured.endInputCalled, 1)
})

test('a claude run with no retained job keeps its plain non-interactive contract', async (context) => {
  const projectPath = await mkdtemp(join(tmpdir(), 'ensync-question-run-'))
  context.after(() => rm(projectPath, { recursive: true, force: true }))

  const { service, captured } = claudeRunService(projectPath, async ({ onStdout }) => {
    const stdout = `${CLAUDE_RESULT_LINE}\n`
    onStdout(stdout)
    return stdout
  })

  await service.run({ provider: 'claude', projectPath, prompt: 'Ship it' }, { onEvent: () => {} })

  assert.equal(captured.keepStdinOpen, false)
  assert.equal(captured.args.includes('--permission-prompt-tool'), false)
  assert.equal(captured.args.includes('--input-format'), false)
  // The prompt is still delivered as plain text, exactly as before.
  assert.equal(captured.input.includes('Ship it'), true)
  assert.equal(captured.endInputCalled, 0)
})

test('a claude question asked mid-run is answered through the retained job', async (context) => {
  const projectPath = await mkdtemp(join(tmpdir(), 'ensync-question-run-'))
  context.after(() => rm(projectPath, { recursive: true, force: true }))

  const events = []
  let answerService = null
  const { service } = claudeRunService(projectPath, async ({ onStdout, written }) => {
    onStdout(`${JSON.stringify({
      type: 'control_request',
      request_id: 'req-run-1',
      request: {
        subtype: 'can_use_tool',
        tool_name: 'AskUserQuestion',
        input: CLAUDE_ASK_INPUT,
        tool_use_id: 'toolu_run_1',
        requires_user_interaction: true,
      },
    })}\n`)

    const asked = await waitFor(() => events.find((event) => event.type === 'question'))
    answerService.answerQuestion('job-claude-question-0002', {
      questionId: asked.questionId,
      answers: [{ index: 0, answer: 'Blue' }],
    })
    const response = await waitFor(() => written[0])
    assert.equal(JSON.parse(response).response.response.behavior, 'deny')
    assert.match(JSON.parse(response).response.response.message, /Blue/)

    const stdout = `${CLAUDE_RESULT_LINE}\n`
    onStdout(stdout)
    return stdout
  })
  answerService = service

  await service.run(
    { provider: 'claude', projectPath, prompt: 'Ship it' },
    { liveTurnId: 'job-claude-question-0002', onEvent: (event) => events.push(event) },
  )

  assert.equal(events.some((event) => event.type === 'question_resolved' && event.cancelled === false), true)
  // The channel is torn down with the run, so a late answer is refused.
  assert.throws(
    () => service.answerQuestion('job-claude-question-0002', { questionId: 'claude-1', answers: [] }),
    (error) => error.code === 'question_not_found',
  )
})

// --- Renderer contract -------------------------------------------------------
// src/lib/providerQuestions.mjs turns the Host events above into the state the
// question card renders, and turns a person's choices back into an answer.

const PENDING = {
  questionId: 'claude-1',
  provider: 'claude',
  askedAt: '2026-08-10T00:00:00.000Z',
  questions: [
    {
      index: 0,
      header: 'Color',
      question: 'Which color do you prefer?',
      multiSelect: false,
      options: [
        { label: 'Red', description: 'The color red' },
        { label: 'Blue', description: 'The color blue' },
      ],
    },
  ],
}

test('a single-select choice replaces the previous one and clicking it again clears it', () => {
  let selection = initialQuestionSelection(PENDING)
  const question = PENDING.questions[0]
  selection = toggleQuestionOption(selection, question, 'Red')
  assert.deepEqual(selection[0].options, ['Red'])
  selection = toggleQuestionOption(selection, question, 'Blue')
  assert.deepEqual(selection[0].options, ['Blue'])
  selection = toggleQuestionOption(selection, question, 'Blue')
  assert.deepEqual(selection[0].options, [])
})

test('a multi-select question accumulates choices', () => {
  const question = { ...PENDING.questions[0], multiSelect: true }
  let selection = initialQuestionSelection({ questions: [question] })
  selection = toggleQuestionOption(selection, question, 'Red')
  selection = toggleQuestionOption(selection, question, 'Blue')
  assert.equal(questionAnswerText(selection, question), 'Red, Blue')
})

test('typed words are kept alongside a selection instead of replacing it', () => {
  const question = PENDING.questions[0]
  let selection = toggleQuestionOption(initialQuestionSelection(PENDING), question, 'Blue')
  selection = setQuestionText(selection, question, '  but only for the header  ')
  assert.equal(questionAnswerText(selection, question), 'Blue — but only for the header')
})

test('a partly answered questionnaire cannot be sent', () => {
  const pending = {
    ...PENDING,
    questions: [PENDING.questions[0], { ...PENDING.questions[0], index: 1, question: 'And the border?' }],
  }
  const selection = toggleQuestionOption(initialQuestionSelection(pending), pending.questions[0], 'Red')
  assert.equal(questionAnswersReady(pending, selection), false)
  assert.equal(questionAnswerPayload(pending, selection), null)
})

test('a complete answer is sent by question index, never by re-sending question text', () => {
  const selection = toggleQuestionOption(initialQuestionSelection(PENDING), PENDING.questions[0], 'Blue')
  assert.deepEqual(questionAnswerPayload(PENDING, selection), {
    questionId: 'claude-1',
    answers: [{ index: 0, answer: 'Blue' }],
  })
})

test('pending questions are rebuilt from a replayed event buffer and cleared when resolved', () => {
  const asked = { type: 'question', provider: 'droid', questionId: 'droid-1', questions: PENDING.questions, at: PENDING.askedAt }
  const pending = pendingQuestionsFromEvents([{ type: 'started' }, asked, asked])
  assert.equal(pending.length, 1)
  assert.equal(pending[0].questionId, 'droid-1')

  const resolved = pendingQuestionsAfterEvent(pending, {
    type: 'question_resolved',
    provider: 'droid',
    questionId: 'droid-1',
    cancelled: false,
    answers: [{ index: 0, question: 'Which color do you prefer?', answer: 'Blue' }],
  })
  assert.deepEqual(resolved, [])
})

test('a run that ends leaves no question waiting in the renderer', () => {
  const asked = { type: 'question', provider: 'claude', questionId: 'claude-1', questions: PENDING.questions, at: PENDING.askedAt }
  assert.deepEqual(pendingQuestionsFromEvents([asked, { type: 'finished', outcome: 'cancelled' }]), [])
})
