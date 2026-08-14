export const CHAT_AUTO_SCROLL_THRESHOLD = 72

function finiteMetric(value) {
  return Number.isFinite(value) ? Number(value) : 0
}

export function chatScrollDistanceFromBottom({ scrollHeight, scrollTop, clientHeight }) {
  return Math.max(0, finiteMetric(scrollHeight) - finiteMetric(scrollTop) - finiteMetric(clientHeight))
}

export function chatScrollIsNearBottom(metrics, threshold = CHAT_AUTO_SCROLL_THRESHOLD) {
  const safeThreshold = Math.max(0, finiteMetric(threshold))
  return chatScrollDistanceFromBottom(metrics) <= safeThreshold
}

export function initialChatAutoScrollState() {
  return { pinned: true, pendingLatest: false }
}

/**
 * Pure policy for a single conversation pane. The caller owns the DOM node, so
 * one pane can never move another pane's viewport.
 */
export function transitionChatAutoScroll(state, event) {
  if (event.type === 'activate' || event.type === 'jump') {
    return {
      state: { pinned: true, pendingLatest: false },
      scrollToLatest: true,
    }
  }

  if (event.type === 'content') {
    return state.pinned
      ? { state: { pinned: true, pendingLatest: false }, scrollToLatest: true }
      : { state: { pinned: false, pendingLatest: true }, scrollToLatest: false }
  }

  const pinned = chatScrollIsNearBottom(event.metrics, event.threshold)
  return {
    state: {
      pinned,
      pendingLatest: pinned ? false : state.pendingLatest,
    },
    scrollToLatest: false,
  }
}

function hashText(value) {
  const text = typeof value === 'string' ? value : ''
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return `${text.length}:${hash >>> 0}`
}

function executionEventSignature(event) {
  if (!event || typeof event !== 'object') return 'none'
  if (event.type === 'output') return `output:${event.at ?? ''}:${event.stream ?? ''}:${hashText(event.text)}`
  if (event.type === 'note') return `note:${event.at ?? ''}:${event.provider ?? ''}:${hashText(event.text)}`
  if (event.type === 'started') return `started:${event.at ?? ''}:${hashText(event.command)}:${hashText(event.cwd)}`
  return `${event.type ?? 'event'}:${event.at ?? ''}:${event.outcome ?? ''}:${hashText(event.message)}`
}

/** A compact semantic revision; it does not retain a second copy of chat text. */
export function chatAutoScrollContentRevision({
  messages = [],
  executionEvents = [],
  sending = false,
  queuedPrompts = [],
  error = null,
}) {
  const visibleActivity = messages.filter((message) => message?.deliveryStatus !== 'transferred')
  const messageRevision = visibleActivity.map((message) => [
    message?.id ?? '',
    message?.role ?? '',
    message?.deliveryStatus ?? '',
    hashText(message?.content),
  ].join(':')).join('|')
  const queueRevision = queuedPrompts.map((entry) => `${entry?.id ?? ''}:${entry?.turnId ?? ''}`).join('|')
  const latestExecutionEvent = executionEvents.at(-1)

  return [
    `messages=${visibleActivity.length}:${messageRevision}`,
    `execution=${executionEvents.length}:${executionEventSignature(latestExecutionEvent)}`,
    `sending=${sending ? 1 : 0}`,
    `queue=${queuedPrompts.length}:${queueRevision}`,
    `error=${hashText(error)}`,
  ].join(';')
}
