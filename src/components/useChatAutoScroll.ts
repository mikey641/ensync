import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  initialChatAutoScrollState,
  transitionChatAutoScroll,
  type ChatAutoScrollEvent,
  type ChatAutoScrollState,
} from '../lib/chatAutoScroll.mjs'

type UseChatAutoScrollInput = {
  chatId: string
  isActive: boolean
  contentRevision: string
}

function scrollViewportToLatest(viewport: HTMLDivElement, behavior: ScrollBehavior) {
  if (typeof viewport.scrollTo === 'function') {
    viewport.scrollTo({ top: viewport.scrollHeight, behavior })
    return
  }
  viewport.scrollTop = viewport.scrollHeight
}

export function useChatAutoScroll({ chatId, isActive, contentRevision }: UseChatAutoScrollInput) {
  const viewportRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const policyRef = useRef<ChatAutoScrollState>(initialChatAutoScrollState())
  const identityRef = useRef<string | null>(null)
  const activeRef = useRef(false)
  const contentRevisionRef = useRef(contentRevision)
  const [pendingLatest, setPendingLatest] = useState(false)

  const applyPolicyEvent = useCallback((event: ChatAutoScrollEvent, behavior: ScrollBehavior = 'auto') => {
    const transition = transitionChatAutoScroll(policyRef.current, event)
    policyRef.current = transition.state
    setPendingLatest(transition.state.pendingLatest)
    if (transition.scrollToLatest && viewportRef.current) {
      scrollViewportToLatest(viewportRef.current, behavior)
    }
  }, [])

  const onScroll = useCallback(() => {
    const viewport = viewportRef.current
    if (!viewport) return
    applyPolicyEvent({
      type: 'scroll',
      metrics: {
        scrollHeight: viewport.scrollHeight,
        scrollTop: viewport.scrollTop,
        clientHeight: viewport.clientHeight,
      },
    })
  }, [applyPolicyEvent])

  const jumpToLatest = useCallback(() => {
    applyPolicyEvent({ type: 'jump' }, 'smooth')
  }, [applyPolicyEvent])

  useLayoutEffect(() => {
    const changedChat = identityRef.current !== chatId
    const becameActive = isActive && !activeRef.current
    identityRef.current = chatId
    activeRef.current = isActive

    if (changedChat || becameActive) applyPolicyEvent({ type: 'activate' })
  }, [applyPolicyEvent, chatId, isActive])

  useLayoutEffect(() => {
    if (contentRevisionRef.current === contentRevision) return
    contentRevisionRef.current = contentRevision
    applyPolicyEvent({ type: 'content' })
  }, [applyPolicyEvent, contentRevision])

  useLayoutEffect(() => {
    const viewport = viewportRef.current
    const content = contentRef.current
    if (!viewport || typeof ResizeObserver === 'undefined') return undefined

    const observer = new ResizeObserver(() => {
      if (policyRef.current.pinned) scrollViewportToLatest(viewport, 'auto')
    })
    observer.observe(viewport)
    if (content) observer.observe(content)
    return () => observer.disconnect()
  }, [])

  return {
    viewportRef,
    contentRef,
    pendingLatest,
    onScroll,
    jumpToLatest,
  }
}
