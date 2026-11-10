// Pure helpers for showing a running turn the way the desktop shows it: the
// provider's latest progress notes and a live "Working (mm:ss)" line. A turn
// can be known two ways: a brokered job this phone submitted (its own events),
// or the `liveTurn` a desktop window or the Host mirrors into the workspace
// document while any turn runs.

import { activeLiveTurn, activeQueuedTurns, LIVE_TURN_NOTE_LIMIT } from '../../src/lib/accountWorkspaceSync.mjs'
import { workingElapsedLabel } from '../../src/lib/workingElapsed.mjs'

const ACTIVE_JOB_STATES = new Set(['sending', 'queued', 'claimed', 'running'])

export { activeLiveTurn }

/** The live turn mirrored into the document for this chat, if it is current. */
export function chatLiveTurn(chat, nowMs = Date.now()) {
  return activeLiveTurn(chat, nowMs)
}

export function jobActive(job) {
  return Boolean(job) && ACTIVE_JOB_STATES.has(job.state) && !job.error
}

/** The latest provider notes a phone-submitted job streamed (never terminal output). */
export function jobNotes(job) {
  return (job?.events ?? [])
    .filter((event) => event && event.type === 'note' && typeof event.text === 'string' && event.text.trim())
    .slice(-LIVE_TURN_NOTE_LIMIT)
    .map((event) => ({ provider: event.provider, text: event.text, redacted: event.redacted === true, at: event.at }))
}

function jobStartedAt(job) {
  const started = (job?.events ?? []).find((event) => event?.type === 'started' && typeof event.at === 'string')
  return started?.at ?? job?.createdAt ?? null
}

/** True when the chat has a running turn from any device. */
export function chatIsRunning(chat, jobs = [], nowMs = Date.now()) {
  return jobs.some(jobActive) || Boolean(chatLiveTurn(chat, nowMs))
}

/**
 * What to render for a running phone job: its own notes, or (when its event
 * stream carried none yet) the notes the Host mirrored into the document.
 */
export function jobProgress(job, chat, nowMs = Date.now()) {
  const live = chatLiveTurn(chat, nowMs)
  const mirrored = live && (live.jobId === job?.jobId || (live.messageId && live.messageId === job?.messageId)) ? live : null
  const own = jobNotes(job)
  return {
    provider: job?.request?.provider ?? mirrored?.provider ?? chat?.provider ?? null,
    startedAt: job?.state === 'running' ? (mirrored?.startedAt ?? jobStartedAt(job)) : null,
    notes: own.length ? own : (mirrored?.notes ?? []),
  }
}

/**
 * The running turn to render below the transcript when no phone job card
 * covers it (a desktop turn, or a phone turn whose job this phone no longer
 * tracks). Returns null when nothing is running.
 */
export function documentProgress(chat, jobs = [], nowMs = Date.now()) {
  const live = chatLiveTurn(chat, nowMs)
  if (!live) return null
  const covered = jobs.some((job) => jobActive(job)
    && (job.jobId === live.jobId || (live.messageId && job.messageId === live.messageId)))
  if (covered) return null
  return { provider: live.provider, startedAt: live.startedAt, notes: live.notes, origin: live.origin }
}

/** The desktop's working label, without its bullet: "Working (1m 22s)". */
export function workingLabel(startedAt, nowMs = Date.now()) {
  const label = workingElapsedLabel({ running: true, startedAt, nowMs })
  return label ? label.replace(/^•\s*/, '') : 'Working…'
}

/** Message ids of this chat that wait for its running turn (any device). */
export function queuedMessageIds(chat, nowMs = Date.now()) {
  const ids = new Set()
  for (const item of activeQueuedTurns(chat, nowMs)) {
    if (item.messageId) ids.add(item.messageId)
    if (item.turnId) {
      const message = (chat?.messages ?? []).find((candidate) => candidate.turnId === item.turnId)
      if (message) ids.add(message.id)
    }
  }
  return ids
}

/** True when the Host holds this phone job until the running turn ends. */
export function jobQueued(job, chat, nowMs = Date.now()) {
  if (!job || !['claimed', 'queued'].includes(job.state)) return false
  return activeQueuedTurns(chat, nowMs).some((item) => item.origin === 'host'
    && (item.jobId === job.jobId || (item.messageId && item.messageId === job.messageId)))
}

/**
 * Who to address to stop or steer the turn running in this chat: the phone's
 * own job (broker command) or, for a desktop/Host-mirrored turn, a control
 * request naming the Host job and the conversation workspace.
 */
export function runningTarget(chat, jobs = [], nowMs = Date.now()) {
  const own = jobs.find((job) => job.submitted && job.state === 'running' && !job.error)
  if (own) return { kind: 'job', jobId: own.jobId, provider: own.request?.provider ?? null }
  const live = chatLiveTurn(chat, nowMs)
  if (!live) return null
  return { kind: 'control', targetJobId: live.jobId ?? null, provider: live.provider }
}

/** Live delivery into a running turn is Codex-only, as on the desktop. */
export function canSteer(target) {
  return target?.provider === 'codex'
}
