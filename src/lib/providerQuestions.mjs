/**
 * Renderer state for the questions a provider run is blocked on.
 *
 * A question only ever leaves this module as the person's own words: the
 * selected option labels and anything they typed. The renderer never rewords a
 * question and never answers on their behalf — an unanswered question stays
 * open until they answer it, cancel it, or the run ends.
 *
 * host/provider-questions.test.mjs is the executable Host/renderer contract for
 * the wire shapes these helpers consume and produce.
 */

/**
 * An approval, not a question: the provider only accepts one of the outcomes it
 * offered, so there is nothing to type and nothing to reword.
 */
export function isPermissionQuestion(question) {
  return question?.kind === 'permission'
}

/** True when the run is blocked on a permission decision rather than a questionnaire. */
export function isPermissionRequest(pending) {
  return (pending?.questions ?? []).some(isPermissionQuestion)
}

/** Empty selection for one pending question: nothing chosen, nothing typed. */
export function initialQuestionSelection(pending) {
  const selection = {}
  for (const question of pending?.questions ?? []) {
    selection[question.index] = { options: [], text: '' }
  }
  return selection
}

function entryFor(selection, index) {
  return selection?.[index] ?? { options: [], text: '' }
}

/** Single-select replaces; multi-select toggles. Re-clicking a single choice clears it. */
export function toggleQuestionOption(selection, question, label) {
  const entry = entryFor(selection, question.index)
  const chosen = entry.options.includes(label)
  const options = question.multiSelect
    ? chosen ? entry.options.filter((option) => option !== label) : [...entry.options, label]
    : chosen ? [] : [label]
  return { ...selection, [question.index]: { ...entry, options } }
}

export function setQuestionText(selection, question, text) {
  return { ...selection, [question.index]: { ...entryFor(selection, question.index), text } }
}

/**
 * The exact answer string sent to the provider. Typed words are kept alongside
 * a selection rather than silently replacing it, because both are things the
 * person actually said.
 */
export function questionAnswerText(selection, question) {
  const entry = entryFor(selection, question.index)
  const chosen = entry.options.join(', ')
  // A permission answer is the chosen outcome and nothing else: free words
  // cannot be turned into an approval the provider would accept.
  if (isPermissionQuestion(question)) return chosen
  const typed = typeof entry.text === 'string' ? entry.text.trim() : ''
  return [chosen, typed].filter(Boolean).join(' — ')
}

export function questionAnswersReady(pending, selection) {
  const questions = pending?.questions ?? []
  if (questions.length === 0) return false
  return questions.every((question) => Boolean(questionAnswerText(selection, question)))
}

/** Null until every question has an answer, so a partial reply can never be sent. */
export function questionAnswerPayload(pending, selection) {
  if (!questionAnswersReady(pending, selection)) return null
  return {
    questionId: pending.questionId,
    answers: pending.questions.map((question) => {
      const answer = questionAnswerText(selection, question)
      // An approval also names the provider's own outcome value, so the Host
      // never has to infer an enum member from a label.
      const chosen = isPermissionQuestion(question)
        ? question.options.find((option) => option.label === answer)
        : null
      return chosen
        ? { index: question.index, answer, value: chosen.value }
        : { index: question.index, answer }
    }),
  }
}

function samePending(left, right) {
  return left.questionId === right.questionId
}

/**
 * Applies only Host-authored question transitions. A run that ends with a
 * question still open drops it: the Host already resolved it as cancelled.
 */
export function pendingQuestionsAfterEvent(current, event) {
  const pending = Array.isArray(current) ? current : []
  if (event?.type === 'question') {
    const asked = {
      questionId: event.questionId,
      provider: event.provider,
      questions: event.questions,
      askedAt: event.at,
    }
    return pending.some((item) => samePending(item, asked)) ? pending : [...pending, asked]
  }
  if (event?.type === 'question_resolved') {
    return pending.filter((item) => item.questionId !== event.questionId)
  }
  if (event?.type === 'finished' || event?.type === 'completed' || event?.type === 'error' || event?.type === 'cancelled') {
    return []
  }
  return pending
}

/** Rebuilds pending questions from a replayed event buffer after a reconnect. */
export function pendingQuestionsFromEvents(events) {
  return (Array.isArray(events) ? events : []).reduce(pendingQuestionsAfterEvent, [])
}

/** One-line transcript of an answered question, for the chat's own record. */
export function questionAnswerSummary(pending, answers) {
  const questions = pending?.questions ?? []
  return questions
    .map((question) => {
      const answer = (answers ?? []).find((item) => item.index === question.index)
      return answer ? `${question.question} ${answer.answer}` : null
    })
    .filter(Boolean)
    .join('\n')
}
