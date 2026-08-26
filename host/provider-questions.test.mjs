import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { ChatRunService } from './chat.mjs'

import {
  initialQuestionSelection,
  isPermissionRequest,
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
  droidPermissionResult,
  normalizeClaudeQuestions,
  normalizeDroidPermission,
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

// Captured verbatim from droid 0.191.1 asking to run `git push origin main` at
// the `medium` autonomy level Ensync pins — the exact frame that used to end a
// run with "finished without a verifiable final agent response".
const DROID_PERMISSION_PARAMS = {
  toolUses: [
    {
      toolUse: {
        type: 'tool_use',
        id: 'chatcmpl-tool-f219ef973e1b463281baf045c849b658',
        name: 'Execute',
        input: {
          summary: 'Push main branch to origin',
          command: 'git push origin main',
          riskLevel: 'high',
        },
      },
      confirmationType: 'exec',
      details: {
        type: 'exec',
        fullCommand: 'git push origin main',
        command: 'git push',
        extractedCommands: ['git push'],
        impactLevel: 'high',
        riskLevelReason: 'This git push modifies the remote repository, which could affect other developers and CI/CD pipelines.',
      },
    },
  ],
  options: [
    { label: 'Yes, allow', value: 'proceed_once', selectedColor: '#d78700' },
    { label: 'Yes, and always allow high impact commands (all commands)', value: 'proceed_always', selectedColor: '#d78700' },
    { label: 'No, cancel', value: 'cancel', selectedColor: '#d75f5f', selectedPrefix: '✕ ' },
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
    kind: 'question',
    header: 'Storage',
    question: 'Which store should the cache use?',
    multiSelect: false,
    options: [
      { label: 'SQLite', description: null, value: null },
      { label: 'Redis', description: null, value: null },
    ],
  }])
})

test('claude AskUserQuestion input normalizes into the same shape with per-option descriptions', () => {
  const normalized = normalizeClaudeQuestions(CLAUDE_ASK_INPUT)
  assert.deepEqual(normalized.questions, [{
    index: 0,
    kind: 'question',
    header: 'Color',
    question: 'Which color do you prefer?',
    multiSelect: false,
    options: [
      { label: 'Red', description: 'The color red', value: null },
      { label: 'Blue', description: 'The color blue', value: null },
    ],
  }])
})

test('a droid permission request becomes one decision that shows the real command', () => {
  const normalized = normalizeDroidPermission(DROID_PERMISSION_PARAMS)
  assert.equal(normalized.toolCallId, 'chatcmpl-tool-f219ef973e1b463281baf045c849b658')
  assert.equal(normalized.question.kind, 'permission')
  assert.equal(normalized.question.header, 'Run command')
  assert.equal(normalized.question.multiSelect, false)
  // Droid's `command` is the shortened "git push"; the person must see what
  // actually runs, plus why the model itself called it risky.
  assert.match(normalized.question.question, /Allow Factory Droid to run this command\?/)
  assert.match(normalized.question.question, /git push origin main/)
  assert.match(normalized.question.question, /Impact: high/)
  assert.match(normalized.question.question, /modifies the remote repository/)
  // The command is what the decision rests on, so it leads.
  assert.equal(
    normalized.question.question.indexOf('git push origin main')
      < normalized.question.question.indexOf('Impact: high'),
    true,
  )
})

test('an approval only offers outcomes that decide the call in front of the person', () => {
  const normalized = normalizeDroidPermission(DROID_PERMISSION_PARAMS)
  // "always allow ... (all commands)" writes a rule into the shared Factory
  // config that would pre-approve later runs, including unattended ones, and
  // declining is the card's own action rather than a choice among approvals.
  assert.deepEqual(normalized.question.options, [
    { label: 'Yes, allow', description: null, value: 'proceed_once' },
  ])
})

test('a permission request Ensync cannot present is declined rather than approved', () => {
  // No outcome that decides only this call.
  assert.equal(normalizeDroidPermission({
    ...DROID_PERMISSION_PARAMS,
    options: [
      { label: 'Yes, and always allow', value: 'proceed_always' },
      { label: 'Yes, and auto-run from now on', value: 'proceed_auto_run_high' },
      { label: 'No, cancel', value: 'cancel' },
    ],
  }), null)
  // Nothing the person could read as the thing being permitted.
  assert.equal(normalizeDroidPermission({ ...DROID_PERMISSION_PARAMS, toolUses: [] }), null)
  assert.equal(normalizeDroidPermission({ options: DROID_PERMISSION_PARAMS.options }), null)
  assert.equal(normalizeDroidPermission(null), null)
})

test('every confirmation type is described as the thing being permitted', () => {
  const decision = (toolUse) => normalizeDroidPermission({
    ...DROID_PERMISSION_PARAMS,
    toolUses: [toolUse],
  }).question
  const edit = decision({
    toolUse: { id: 'tool-2', name: 'Edit' },
    confirmationType: 'edit',
    details: { type: 'edit', filePath: '/repo/src/app.ts', fileName: 'app.ts', newContent: 'x'.repeat(5_000) },
  })
  assert.equal(edit.header, 'Edit file')
  assert.match(edit.question, /Allow Factory Droid to edit this file\?\n\n\/repo\/src\/app\.ts/)
  // A decision card is not a diff viewer: file bodies never reach it.
  assert.equal(edit.question.includes('xxxx'), false)

  const mcp = decision({
    toolUse: { id: 'tool-3', name: 'mcp__github__create_pr' },
    confirmationType: 'mcp_tool',
    details: { type: 'mcp_tool', serverName: 'github', toolName: 'create_pr', impactLevel: 'medium' },
  })
  assert.equal(mcp.header, 'MCP tool')
  assert.match(mcp.question, /github · create_pr/)

  // An unknown confirmation type still names the tool instead of asking the
  // person to approve something unnamed.
  const future = decision({
    toolUse: { id: 'tool-4', name: 'SomethingNew' },
    confirmationType: 'invented_later',
    details: { type: 'invented_later' },
  })
  assert.equal(future.header, 'Permission')
  assert.match(future.question, /Allow Factory Droid to use SomethingNew\?/)
})

test('two tool uses in one request are approved as the single decision droid asked for', () => {
  const normalized = normalizeDroidPermission({
    ...DROID_PERMISSION_PARAMS,
    toolUses: [
      DROID_PERMISSION_PARAMS.toolUses[0],
      {
        toolUse: { id: 'tool-5', name: 'Create' },
        confirmationType: 'create',
        details: { type: 'create', filePath: '/repo/NOTES.md', fileName: 'NOTES.md', content: 'hello' },
      },
    ],
  })
  assert.equal(normalized.question.header, 'Permission')
  assert.match(normalized.question.question, /Allow Factory Droid to do all of this\?/)
  assert.match(normalized.question.question, /• run this command\ngit push origin main/)
  assert.match(normalized.question.question, /• create this file\n\/repo\/NOTES\.md/)
})

test('a request too large to show says so instead of quietly clipping it', () => {
  const normalized = normalizeDroidPermission({
    ...DROID_PERMISSION_PARAMS,
    toolUses: Array.from({ length: 8 }, (_, index) => ({
      toolUse: { id: `tool-${index}`, name: 'Execute' },
      confirmationType: 'exec',
      details: { type: 'exec', fullCommand: `rm -rf /tmp/${'x'.repeat(400)}-${index}` },
    })),
  })
  assert.match(normalized.question.question, /could not show all of this request/)
  // The person still gets a way out that does not require seeing the rest.
  assert.deepEqual(normalized.question.options.map((option) => option.value), ['proceed_once'])
})

test('an approval names an outcome droid offered and never a typed sentence', async () => {
  const registry = new ProviderQuestionRegistry({ idPrefix: 'droid' })
  const { question } = normalizeDroidPermission(DROID_PERMISSION_PARAMS)
  const { id, answered } = registry.ask({
    provider: 'droid',
    questions: [question],
    askedAt: '2026-08-10T00:00:00.000Z',
  })
  assert.throws(
    () => registry.answer(id, { answers: [{ index: 0, answer: 'yes go ahead' }] }),
    (error) => error instanceof ProviderQuestionError
      && error.code === 'invalid_question_answer'
      && /Choose one of the options/.test(error.message),
  )
  // An outcome Ensync did not offer is not an approval either, even though
  // Droid itself listed it.
  assert.throws(() => registry.answer(id, { answers: [{ index: 0, value: 'proceed_always' }] }), /Choose one of the options/)
  assert.equal(registry.size, 1)

  registry.answer(id, { answers: [{ index: 0, value: 'proceed_once', answer: 'Yes, allow' }] })
  const resolution = await answered
  assert.deepEqual(resolution.answers, [{
    index: 0,
    question: question.question,
    answer: 'Yes, allow',
    value: 'proceed_once',
  }])
  assert.deepEqual(droidPermissionResult(resolution), { selectedOption: 'proceed_once' })
})

test('anything short of a chosen approval is droid’s own decline', () => {
  assert.deepEqual(droidPermissionResult({ cancelled: true, answers: [] }), { selectedOption: 'cancel' })
  assert.deepEqual(droidPermissionResult({ cancelled: false, answers: [] }), { selectedOption: 'cancel' })
  // A resolution carrying no outcome cannot be turned into one.
  assert.deepEqual(
    droidPermissionResult({ cancelled: false, answers: [{ index: 0, answer: 'Yes, allow' }] }),
    { selectedOption: 'cancel' },
  )
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
 * Speaks the droid 0.190.0 wire protocol and sends a `droid.ask_user` or
 * `droid.request_permission` request the way the CLI does: a server-to-client
 * request in the middle of the turn.
 */
function fakeDroidExec({ askUser = true, permission = null } = {}) {
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
        if (permission) {
          send({
            jsonrpc: '2.0',
            type: 'request',
            factoryApiVersion: '1.0.0',
            id: 'server-permission-1',
            method: 'droid.request_permission',
            params: permission,
          })
          continue
        }
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

test('an unanswered droid question releases the watchdog at its own bound instead of pinning the run', async () => {
  const server = fakeDroidExec()
  const runner = new DroidExecRunner({
    spawnProcess: () => server.child,
    inactivityTimeoutMs: 60_000,
    questionHoldTimeoutMs: 60,
  })
  const events = []
  const run = runner.run(droidInput('job-droid-question-0003'), {
    onEvent: (event) => events.push(event),
  })

  await assert.rejects(run, (error) => {
    assert.equal(error.code, 'run_timed_out')
    assert.match(error.message, /question/i)
    return true
  })
  // Nobody answered on the person's behalf: droid is told the question was cancelled.
  assert.equal(events.find((event) => event.type === 'question_resolved').cancelled, true)
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

test('a droid permission request reaches the person and their approval completes the turn', async () => {
  const server = fakeDroidExec({ permission: DROID_PERMISSION_PARAMS })
  const runner = new DroidExecRunner({ spawnProcess: () => server.child })
  const events = []
  const run = runner.run(droidInput('job-droid-permission-0001'), {
    onEvent: (event) => events.push(event),
  })

  const asked = await waitFor(() => events.find((event) => event.type === 'question'))
  assert.equal(asked.provider, 'droid')
  assert.equal(asked.questions[0].kind, 'permission')
  assert.match(asked.questions[0].question, /git push origin main/)

  runner.answerQuestion('job-droid-permission-0001', asked.questionId, {
    answers: [{ index: 0, value: 'proceed_once' }],
  })

  const result = await run
  assert.equal(result.response, 'done')
  // The wire result is Droid's own permission shape carrying the outcome the
  // person picked — nothing else is a valid answer to this request.
  assert.deepEqual(server.responses[0].result, { selectedOption: 'proceed_once' })
  const resolved = events.find((event) => event.type === 'question_resolved')
  assert.equal(resolved.cancelled, false)
  assert.equal(resolved.answers[0].value, 'proceed_once')
  assert.equal(events.some((event) => event.code === 'provider_request_declined'), false)
})

test('declining a permission sends droid’s documented cancel and the run continues', async () => {
  const server = fakeDroidExec({ permission: DROID_PERMISSION_PARAMS })
  const runner = new DroidExecRunner({ spawnProcess: () => server.child })
  const events = []
  const run = runner.run(droidInput('job-droid-permission-0002'), {
    onEvent: (event) => events.push(event),
  })

  const asked = await waitFor(() => events.find((event) => event.type === 'question'))
  runner.answerQuestion('job-droid-permission-0002', asked.questionId, { cancelled: true })

  await run
  assert.deepEqual(server.responses[0].result, { selectedOption: 'cancel' })
})

test('a permission with no outcome Ensync offers is declined exactly as before', async () => {
  const server = fakeDroidExec({
    permission: {
      ...DROID_PERMISSION_PARAMS,
      options: [
        { label: 'Yes, and always allow high impact commands (all commands)', value: 'proceed_always' },
        { label: 'No, cancel', value: 'cancel' },
      ],
    },
  })
  const runner = new DroidExecRunner({ spawnProcess: () => server.child })
  const events = []
  const result = await runner.run(droidInput('job-droid-permission-0003'), {
    onEvent: (event) => events.push(event),
  })

  assert.equal(result.response, 'done')
  assert.equal(events.some((event) => event.type === 'question'), false)
  assert.deepEqual(server.responses[0].result, { selectedOption: 'cancel' })
  assert.equal(
    events.some((event) => event.code === 'provider_request_declined' && /no approval it could safely offer/.test(event.message)),
    true,
  )
})

test('a droid run with no retained job still declines permission requests safely', async () => {
  const server = fakeDroidExec({ permission: DROID_PERMISSION_PARAMS })
  const runner = new DroidExecRunner({ spawnProcess: () => server.child })
  const events = []
  const result = await runner.run(droidInput(null), { onEvent: (event) => events.push(event) })
  assert.equal(result.response, 'done')
  assert.equal(events.some((event) => event.type === 'question'), false)
  assert.deepEqual(server.responses[0].result, { selectedOption: 'cancel' })
})

test('a permission left open when the run ends is declined, never granted', async () => {
  const server = fakeDroidExec({ permission: DROID_PERMISSION_PARAMS })
  const runner = new DroidExecRunner({ spawnProcess: () => server.child })
  const events = []
  const controller = new AbortController()
  const run = runner.run(droidInput('job-droid-permission-0004'), {
    onEvent: (event) => events.push(event),
    signal: controller.signal,
  })

  await waitFor(() => events.find((event) => event.type === 'question'))
  controller.abort()

  await assert.rejects(run, (error) => error.code === 'run_cancelled')
  const resolved = events.find((event) => event.type === 'question_resolved')
  assert.equal(resolved.cancelled, true)
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
      kind: 'question',
      header: 'Color',
      question: 'Which color do you prefer?',
      multiSelect: false,
      options: [
        { label: 'Red', description: 'The color red', value: null },
        { label: 'Blue', description: 'The color blue', value: null },
      ],
    },
  ],
}

const PENDING_PERMISSION = {
  questionId: 'droid-1',
  provider: 'droid',
  askedAt: '2026-08-10T00:00:00.000Z',
  questions: [normalizeDroidPermission(DROID_PERMISSION_PARAMS).question],
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

test('a permission card sends the provider’s outcome, not the label it displayed', () => {
  const question = PENDING_PERMISSION.questions[0]
  assert.equal(isPermissionRequest(PENDING_PERMISSION), true)
  assert.equal(isPermissionRequest(PENDING), false)

  let selection = initialQuestionSelection(PENDING_PERMISSION)
  assert.equal(questionAnswersReady(PENDING_PERMISSION, selection), false)
  // There is no text input on an approval, so typing cannot make one ready.
  selection = setQuestionText(selection, question, 'yes but only this once')
  assert.equal(questionAnswersReady(PENDING_PERMISSION, selection), false)

  selection = toggleQuestionOption(selection, question, 'Yes, allow')
  assert.equal(questionAnswerText(selection, question), 'Yes, allow')
  assert.deepEqual(questionAnswerPayload(PENDING_PERMISSION, selection), {
    questionId: 'droid-1',
    answers: [{ index: 0, answer: 'Yes, allow', value: 'proceed_once' }],
  })

  // Unchoosing it puts the decision back to nothing rather than leaving a
  // stale approval behind.
  selection = toggleQuestionOption(selection, question, 'Yes, allow')
  assert.equal(questionAnswerPayload(PENDING_PERMISSION, selection), null)
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

// The card renders inside the chat panel, and the panel re-renders about once a
// second for as long as a run is in flight — that is the "• Working (12s)"
// clock. Every one of those renders rebuilds the pending question from the
// replayed event buffer, so the object the card receives is new each time while
// the question itself has not changed. A card that clears its selection
// whenever that object changes throws the person's choice away within a second
// of the click and shows "No answer yet" again, so the choice may only ever be
// cleared when the question id changes.
test('a chosen option survives the panel re-rendering the same question', async () => {
  const asked = { type: 'question', provider: 'claude', questionId: 'claude-1', questions: PENDING.questions, at: PENDING.askedAt }
  const [firstRender] = pendingQuestionsFromEvents([asked])
  const [secondRender] = pendingQuestionsFromEvents([asked])
  assert.notEqual(firstRender, secondRender)
  assert.equal(firstRender.questionId, secondRender.questionId)

  const card = await readFile(new URL('../src/components/ProviderQuestionCard.tsx', import.meta.url), 'utf8')
  assert.match(card, /setSelection\(initialQuestionSelection\(pending\)\)\n(?:\s*\/\/[^\n]*\n)*\s*\}, \[pending\.questionId\]\)/)
  assert.doesNotMatch(card, /\}, \[pending\]\)/)
})

// A question with several long options is taller than the room the chat panel
// has left for it, and nothing above the card scrolls: `#root`, `.conversation`
// and the split pane are all `overflow: hidden`, and the transcript's own
// scroller is a sibling. A card laid out at its full content height therefore
// runs off the bottom edge — its later options, its text box, "Don't answer"
// and "Send answer" become unreachable, and the composer is pushed out with
// them. The card carries the scrolling itself: the questions sit in a bounded
// body that scrolls, while the header and the actions stay pinned to the card.
test('a question taller than the chat panel scrolls inside the card', async () => {
  const [card, css] = await Promise.all([
    readFile(new URL('../src/components/ProviderQuestionCard.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/components/ProviderQuestionCard.css', import.meta.url), 'utf8'),
  ])

  const bodyStart = card.indexOf('provider-question__body')
  const actionsStart = card.indexOf('provider-question__actions')
  assert.ok(bodyStart > 0, 'the questions need a body element of their own to scroll')
  assert.ok(actionsStart > bodyStart, 'Send and Don’t answer stay pinned below the scrolling body')
  const body = card.slice(bodyStart, actionsStart)
  assert.match(body, /pending\.questions\.map\(/)
  assert.match(body, /<\/div>/)

  const rule = (selector) => {
    const match = css.match(new RegExp(`\\${selector}\\s*\\{([^}]*)\\}`))
    assert.ok(match, `${selector} is missing from the card stylesheet`)
    return match[1]
  }
  const shell = rule('.provider-question ')
  assert.match(shell, /max-height:/)
  assert.match(shell, /min-height:\s*0/)
  assert.match(shell, /overflow:\s*hidden/)
  const scroller = rule('.provider-question__body')
  assert.match(scroller, /overflow-y:\s*auto/)
  assert.match(scroller, /min-height:\s*0/)
})

// The Host/renderer contract for the agent's own words in front of an ask.
test('the agent message on a question reaches the renderer as ordinary text', async () => {
  const asked = {
    type: 'question',
    provider: 'claude',
    questionId: 'claude-9',
    questions: PENDING.questions,
    message: 'Confirmed the root cause. Here is the full report.',
    at: PENDING.askedAt,
  }
  const [pending] = pendingQuestionsFromEvents([asked])
  assert.equal(pending.message, 'Confirmed the root cause. Here is the full report.')

  // A Host that never sends one leaves the card with nothing to show rather
  // than an empty block.
  const [plain] = pendingQuestionsFromEvents([{ ...asked, message: undefined }])
  assert.equal(plain.message, null)

  // It is rendered as a message, not as a provider note.
  const app = await readFile(new URL('../src/App.tsx', import.meta.url), 'utf8')
  assert.match(app, /pendingQuestion\?\.message && \(\s*\n\s*<div className="message message--agent"/)
})

test('a claude question carries the text written immediately before it', async () => {
  const { channel, events } = claudeChannel()
  channel.noteQuestionMessage('  Confirmed the root cause.  ')
  channel.handleLine(JSON.stringify({
    type: 'control_request',
    request_id: 'req-msg-1',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      input: CLAUDE_ASK_INPUT,
      tool_use_id: 'toolu_9',
      requires_user_interaction: true,
    },
  }))
  const asked = await waitFor(() => events.find((event) => event.type === 'question'))
  assert.equal(asked.message, 'Confirmed the root cause.')

  // Consumed once: a later ask with nothing in front of it says nothing.
  channel.handleLine(JSON.stringify({
    type: 'control_request',
    request_id: 'req-msg-2',
    request: {
      subtype: 'can_use_tool',
      tool_name: 'AskUserQuestion',
      input: CLAUDE_ASK_INPUT,
      tool_use_id: 'toolu_10',
      requires_user_interaction: true,
    },
  }))
  const second = await waitFor(() => events.filter((event) => event.type === 'question')[1])
  assert.equal(second.message, null)
})
