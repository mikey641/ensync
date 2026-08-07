import { useCallback, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Maximize2, X } from 'lucide-react'
import type { Chat } from '../types'
import { storedChatContext } from '../lib/chatContextHeader.mjs'
import './ChatContextHeader.css'

export function ChatContextHeader({ chat }: { chat: Chat }) {
  const context = storedChatContext(chat)
  const [latestMessageOpen, setLatestMessageOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const dialogRef = useRef<HTMLDialogElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const dialogId = `latest-user-message-${chat.id}`
  const dialogTitleId = `${dialogId}-title`
  const dialogBodyId = `${dialogId}-body`

  const closeLatestUserMessage = useCallback(() => {
    setLatestMessageOpen(false)
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }, [])

  useLayoutEffect(() => {
    if (!latestMessageOpen) return
    const dialog = dialogRef.current
    if (!dialog) return
    if (!dialog.open) dialog.showModal()
    closeButtonRef.current?.focus()
  }, [latestMessageOpen])

  return (
    <section className="chat-context-header" aria-label="Conversation context">
      <div className="chat-context-header__content">
        <div className="chat-context-header__identity">
          {context.title && <strong dir="auto" title={context.title}>{context.title}</strong>}
          {context.summary && <span dir="auto" title={context.summary}>{context.summary}</span>}
        </div>
        {context.latestUserMessage && (
          <button
            ref={triggerRef}
            className="chat-context-header__message-trigger"
            type="button"
            aria-label="Read your full latest message"
            aria-haspopup="dialog"
            aria-expanded={latestMessageOpen}
            aria-controls={dialogId}
            onClick={() => setLatestMessageOpen(true)}
          >
            <span className="chat-context-header__message-preview" dir="auto">{context.latestUserMessage}</span>
            <span className="chat-context-header__message-action" aria-hidden="true">
              <Maximize2 size={12} />
              Read full
            </span>
          </button>
        )}
      </div>
      {latestMessageOpen && context.latestUserMessage && typeof document !== 'undefined' && createPortal(
        <dialog
          ref={dialogRef}
          id={dialogId}
          className="chat-context-message-dialog"
          aria-labelledby={dialogTitleId}
          aria-describedby={dialogBodyId}
          onCancel={(event) => {
            event.preventDefault()
            closeLatestUserMessage()
          }}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) closeLatestUserMessage()
          }}
        >
          <section className="chat-context-message-dialog__panel">
            <header>
              <h2 id={dialogTitleId}>Your latest message</h2>
              <button
                ref={closeButtonRef}
                type="button"
                onClick={closeLatestUserMessage}
                aria-label="Close full latest message"
              >
                <X size={18} />
              </button>
            </header>
            <div
              id={dialogBodyId}
              className="chat-context-message-dialog__body"
              dir="auto"
              tabIndex={0}
              aria-label="Full latest message from you"
            >
              {context.latestUserMessage}
            </div>
          </section>
        </dialog>,
        document.body,
      )}
    </section>
  )
}
