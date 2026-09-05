import { useEffect, useRef, useState } from 'react'
import { CircleHelp, Send, ShieldQuestion, X } from 'lucide-react'
import type { PendingProviderQuestion, ProviderQuestion } from '../lib/ensyncHost'
import {
  initialQuestionSelection,
  isPermissionQuestion,
  isPermissionRequest,
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
 * The question as the provider wrote it, only laid out: the ask on its own line
 * and the exact call being approved kept verbatim underneath it.
 */
function splitPrompt(question: ProviderQuestion) {
  const [ask, ...rest] = question.question.split('\n\n')
  return { ask, detail: rest.join('\n\n') }
}

/**
 * The provider has paused its turn and is waiting on a person. Nothing here
 * answers on their behalf: Send stays disabled until every question has an
 * answer, and Skip sends an explicit "not answered" rather than a made-up one.
 *
 * A permission request is the same card with the typing removed — the provider
 * only accepts one of the outcomes it offered, so an approval is a choice or it
 * is nothing.
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
  // across would answer a question the person never saw. Only the question id
  // may clear a choice: the panel rebuilds this object from the event buffer on
  // every render — once a second while the run's clock ticks — so clearing on
  // the object itself would wipe the person's pick a moment after they made it.
  useEffect(() => {
    setSelection(initialQuestionSelection(pending))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending.questionId])

  useEffect(() => {
    firstOptionRef.current?.focus()
  }, [pending.questionId])

  const ready = questionAnswersReady(pending, selection)
  const providerName = PROVIDER_NAMES[pending.provider] ?? pending.provider
  const permission = isPermissionRequest(pending)

  const send = () => {
    const payload = questionAnswerPayload(pending, selection)
    if (!payload || disabled) return
    onAnswer(payload)
  }

  return (
    <section
      className="provider-question"
      aria-label={permission ? `${providerName} is asking for permission` : `${providerName} is asking a question`}
    >
      <header className="provider-question__header">
        {permission ? <ShieldQuestion size={15} /> : <CircleHelp size={15} />}
        <strong>{providerName} {permission ? 'needs permission' : 'needs an answer'}</strong>
        <small>
          {permission
            ? 'Nothing runs until you decide.'
            : 'The turn is paused here until you reply.'}
        </small>
      </header>

      {/* The questions scroll here rather than off the bottom of the panel:
          nothing above this card scrolls, so a card taller than the room left
          for it would put its own text box and buttons out of reach. */}
      <div className="provider-question__body">
        {pending.questions.map((question, questionIndex) => {
          const prompt = splitPrompt(question)
          const approval = isPermissionQuestion(question)
          const answer = questionAnswerText(selection, question)
          return (
            <div className="provider-question__item" key={`${pending.questionId}-${question.index}`}>
              <p className="provider-question__prompt" dir="auto">
                {question.header && <span className="provider-question__chip">{question.header}</span>}
                {prompt.ask}
              </p>
              {prompt.detail && (
                <pre className="provider-question__detail" dir="auto">{prompt.detail}</pre>
              )}
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
              {/* An approval is one of the provider's own outcomes, so there is
                  nothing here to type: typed words could not be sent as one. */}
              {!approval && (
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
              )}
              {question.multiSelect && question.options.length > 0 && (
                <small className="provider-question__hint">You can choose more than one.</small>
              )}
              <p className="provider-question__preview" aria-live="polite">
                {answer
                  ? `Sending: ${answer}`
                  : approval ? 'No decision yet' : 'No answer yet'}
              </p>
            </div>
          )
        })}
      </div>

      {error && <p className="provider-question__error" role="alert">{error}</p>}

      <div className="provider-question__actions">
        <button
          type="button"
          className="provider-question__skip"
          disabled={disabled}
          onClick={() => onSkip(pending.questionId)}
          title={permission
            ? `Tell ${providerName} not to do this`
            : `Tell ${providerName} that you are not answering`}
        >
          <X size={13} /> {permission ? 'Don’t allow' : 'Don’t answer'}
        </button>
        <button
          type="button"
          className="provider-question__send"
          disabled={disabled || !ready}
          onClick={send}
          title={ready
            ? `Send this ${permission ? 'decision' : 'answer'} to ${providerName}`
            : permission ? 'Choose an option first' : 'Answer every question first'}
        >
          <Send size={13} /> {disabled
            ? 'Sending…'
            : permission ? 'Send decision' : 'Send answer'}
        </button>
      </div>
    </section>
  )
}
