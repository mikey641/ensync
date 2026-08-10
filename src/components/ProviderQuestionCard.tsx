import { useEffect, useRef, useState } from 'react'
import { CircleHelp, Send, X } from 'lucide-react'
import type { PendingProviderQuestion } from '../lib/relayHost'
import {
  initialQuestionSelection,
  questionAnswerPayload,
  questionAnswerText,
  questionAnswersReady,
  setQuestionText,
  toggleQuestionOption,
  type ProviderQuestionAnswerPayload,
  type QuestionSelection,
} from '../lib/providerQuestions.mjs'
import './ProviderQuestionCard.css'

const PROVIDER_NAMES: Record<string, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  droid: 'Factory Droid',
}

/**
 * The provider has paused its turn and is waiting on a person. Nothing here
 * answers on their behalf: Send stays disabled until every question has an
 * answer, and Skip sends an explicit "not answered" rather than a made-up one.
 */
export function ProviderQuestionCard({
  pending,
  disabled,
  error,
  onAnswer,
  onSkip,
}: {
  pending: PendingProviderQuestion
  disabled: boolean
  error: string | null
  onAnswer: (payload: ProviderQuestionAnswerPayload) => void
  onSkip: (questionId: string) => void
}) {
  const [selection, setSelection] = useState<QuestionSelection>(() => initialQuestionSelection(pending))
  const firstOptionRef = useRef<HTMLButtonElement>(null)

  // A new question replaces the old one outright; carrying a stale selection
  // across would answer a question the person never saw.
  useEffect(() => {
    setSelection(initialQuestionSelection(pending))
  }, [pending])

  useEffect(() => {
    firstOptionRef.current?.focus()
  }, [pending.questionId])

  const ready = questionAnswersReady(pending, selection)
  const providerName = PROVIDER_NAMES[pending.provider] ?? pending.provider

  const send = () => {
    const payload = questionAnswerPayload(pending, selection)
    if (!payload || disabled) return
    onAnswer(payload)
  }

  return (
    <section className="provider-question" aria-label={`${providerName} is asking a question`}>
      <header className="provider-question__header">
        <CircleHelp size={15} />
        <strong>{providerName} needs an answer</strong>
        <small>The turn is paused here until you reply.</small>
      </header>

      {pending.questions.map((question, questionIndex) => (
        <div className="provider-question__item" key={`${pending.questionId}-${question.index}`}>
          <p className="provider-question__prompt" dir="auto">
            {question.header && <span className="provider-question__chip">{question.header}</span>}
            {question.question}
          </p>
          {question.options.length > 0 && (
            <div
              className="provider-question__options"
              role="group"
              aria-label={question.multiSelect ? 'Choose one or more' : 'Choose one'}
            >
              {question.options.map((option, optionIndex) => {
                const chosen = (selection[question.index]?.options ?? []).includes(option.label)
                return (
                  <button
                    ref={questionIndex === 0 && optionIndex === 0 ? firstOptionRef : undefined}
                    key={option.label}
                    type="button"
                    className={`provider-question__option ${chosen ? 'provider-question__option--chosen' : ''}`}
                    aria-pressed={chosen}
                    disabled={disabled}
                    onClick={() => setSelection((current) => toggleQuestionOption(current, question, option.label))}
                    title={option.description ?? undefined}
                  >
                    <span>{option.label}</span>
                    {option.description && <small dir="auto">{option.description}</small>}
                  </button>
                )
              })}
            </div>
          )}
          <input
            className="provider-question__text"
            type="text"
            dir="auto"
            disabled={disabled}
            value={selection[question.index]?.text ?? ''}
            placeholder={question.options.length > 0 ? 'Or answer in your own words' : 'Type your answer'}
            aria-label={`Your answer to: ${question.question}`}
            onChange={(event) => setSelection((current) => setQuestionText(current, question, event.target.value))}
            onKeyDown={(event) => {
              if (event.key !== 'Enter') return
              event.preventDefault()
              send()
            }}
          />
          {question.multiSelect && question.options.length > 0 && (
            <small className="provider-question__hint">You can choose more than one.</small>
          )}
          <p className="provider-question__preview" aria-live="polite">
            {questionAnswerText(selection, question)
              ? `Sending: ${questionAnswerText(selection, question)}`
              : 'No answer yet'}
          </p>
        </div>
      ))}

      {error && <p className="provider-question__error" role="alert">{error}</p>}

      <div className="provider-question__actions">
        <button
          type="button"
          className="provider-question__skip"
          disabled={disabled}
          onClick={() => onSkip(pending.questionId)}
          title={`Tell ${providerName} that you are not answering`}
        >
          <X size={13} /> Don’t answer
        </button>
        <button
          type="button"
          className="provider-question__send"
          disabled={disabled || !ready}
          onClick={send}
          title={ready ? `Send this answer to ${providerName}` : 'Answer every question first'}
        >
          <Send size={13} /> {disabled ? 'Sending…' : 'Send answer'}
        </button>
      </div>
    </section>
  )
}
