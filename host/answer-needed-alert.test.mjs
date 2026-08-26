import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

import {
  ANSWER_NEEDED_ALERT,
  TASK_FINISHED_ALERT,
  completionAlertPlan,
  normalizeCompletionNotificationSettings,
} from '../src/lib/completionNotificationPreferences.mjs'
import {
  pendingQuestionsByChat,
  questionsNeedingAlert,
} from '../src/lib/providerQuestions.mjs'

// A provider question stops the run until the person answers it. Nothing else
// in Ensync waits on a human that way, so it gets its own alert: the finished
// alert means "come and read this", this one means "come and decide".

const QUESTIONS = [
  {
    index: 0,
    kind: 'question',
    header: 'Colour',
    question: 'Which colour do you prefer?',
    multiSelect: false,
    options: [{ label: 'Red', description: null, value: null }],
  },
]

function asked(questionId, provider = 'claude') {
  return { type: 'question', provider, questionId, questions: QUESTIONS, at: '2026-08-26T00:00:00.000Z' }
}

test('a question alert says its own words and chimes differently from a finished task', () => {
  const spoken = normalizeCompletionNotificationSettings({ mode: 'speech' })
  assert.equal(completionAlertPlan(spoken, ANSWER_NEEDED_ALERT).speechText, 'Your Ensync task needs an answer.')
  assert.equal(completionAlertPlan(spoken, TASK_FINISHED_ALERT).speechText, 'Your Ensync task is finished.')

  const ringtone = normalizeCompletionNotificationSettings({ mode: 'ringtone' })
  assert.equal(completionAlertPlan(ringtone, ANSWER_NEEDED_ALERT).chime, ANSWER_NEEDED_ALERT)
  assert.equal(completionAlertPlan(ringtone, TASK_FINISHED_ALERT).chime, TASK_FINISHED_ALERT)
})

test('question alerts can be turned off without silencing the finished-task alert', () => {
  const settings = normalizeCompletionNotificationSettings({ mode: 'ringtone', answerAlerts: false })
  assert.equal(completionAlertPlan(settings, ANSWER_NEEDED_ALERT).mode, 'off')
  assert.equal(completionAlertPlan(settings, TASK_FINISHED_ALERT).mode, 'ringtone')
})

test('a device with alerts off stays silent for questions too', () => {
  const settings = normalizeCompletionNotificationSettings({ mode: 'off', answerAlerts: true })
  assert.equal(completionAlertPlan(settings, ANSWER_NEEDED_ALERT).mode, 'off')
  assert.equal(completionAlertPlan(settings, TASK_FINISHED_ALERT).mode, 'off')
})

test('the person is alerted about a question waiting in a conversation they are not looking at', () => {
  const pending = pendingQuestionsByChat({
    'chat-visible': [{ type: 'started' }],
    'chat-background': [asked('claude-1')],
  })

  assert.deepEqual(pending.map((item) => [item.chatId, item.questionId]), [['chat-background', 'claude-1']])
  assert.deepEqual(pending[0].questions, QUESTIONS)
})

// The panel rebuilds pending questions from the replayed event buffer about
// once a second while a run is in flight. Alerting on every one of those
// rebuilds would ring for as long as the person takes to decide.
test('one question alerts once, however many times the panel re-renders it', () => {
  const pending = pendingQuestionsByChat({ 'chat-1': [asked('claude-1')] })
  const first = questionsNeedingAlert(pending, new Set())
  assert.deepEqual(first.alerts.map((item) => item.questionId), ['claude-1'])

  const rerendered = questionsNeedingAlert(pendingQuestionsByChat({ 'chat-1': [asked('claude-1')] }), first.announced)
  assert.deepEqual(rerendered.alerts, [])
  assert.deepEqual(rerendered.announced, new Set(['claude-1']))
})

test('a resolved question is forgotten so the next one still alerts', () => {
  const answered = questionsNeedingAlert([], new Set(['claude-1']))
  assert.deepEqual(answered.announced, new Set())

  const next = questionsNeedingAlert(pendingQuestionsByChat({ 'chat-1': [asked('claude-2')] }), answered.announced)
  assert.deepEqual(next.alerts.map((item) => item.questionId), ['claude-2'])
})

test('every window alerts for a question in any conversation, and reopening Ensync mid-question is silent', async () => {
  const [app, notifications] = await Promise.all([
    readFile(new URL('../src/App.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../src/completion-notifications.tsx', import.meta.url), 'utf8'),
  ])

  assert.match(app, /pendingQuestionsByChat\(chatExecutionEvents\)/)
  assert.match(app, /questionsNeedingAlert\(/)
  assert.match(app, /void notifyAnswerNeeded\(\)/)

  const alertStart = app.indexOf('const announcedQuestionsRef')
  const alertEnd = app.indexOf('}, [chatExecutionEvents, notifyAnswerNeeded])', alertStart)
  assert.notEqual(alertStart, -1)
  assert.ok(alertEnd > alertStart)
  // A window that loads while a question is already open records it without
  // ringing: the alert marks an arrival, not a state.
  assert.match(app.slice(alertStart, alertEnd), /hydrated/)

  assert.match(notifications, /export function playAnswerNeededRingtone\(\)/)
  assert.match(notifications, /notifyAnswerNeeded/)
})
