import type { ChatExecutionEvent, PendingProviderQuestion, ProviderQuestion } from './relayHost'

export type QuestionSelection = Record<number, { options: string[]; text: string }>

export type ProviderQuestionAnswerPayload = {
  questionId: string
  answers: { index: number; answer: string }[]
}

export function initialQuestionSelection(pending: PendingProviderQuestion | null | undefined): QuestionSelection
export function toggleQuestionOption(selection: QuestionSelection, question: ProviderQuestion, label: string): QuestionSelection
export function setQuestionText(selection: QuestionSelection, question: ProviderQuestion, text: string): QuestionSelection
export function questionAnswerText(selection: QuestionSelection, question: ProviderQuestion): string
export function questionAnswersReady(pending: PendingProviderQuestion | null | undefined, selection: QuestionSelection): boolean
export function questionAnswerPayload(pending: PendingProviderQuestion | null | undefined, selection: QuestionSelection): ProviderQuestionAnswerPayload | null
export function pendingQuestionsAfterEvent(current: PendingProviderQuestion[], event: ChatExecutionEvent | { type: string }): PendingProviderQuestion[]
export function pendingQuestionsFromEvents(events: ChatExecutionEvent[]): PendingProviderQuestion[]
export function questionAnswerSummary(
  pending: PendingProviderQuestion | null | undefined,
  answers: { index: number; answer: string }[],
): string
