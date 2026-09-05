import type { ChatExecutionEvent, PendingProviderQuestion, ProviderQuestion } from './ensyncHost'

export type QuestionSelection = Record<number, { options: string[]; text: string }>

export type ProviderQuestionAnswerPayload = {
  questionId: string
  /** `value` accompanies a permission choice: the provider's own outcome, not a label. */
  answers: { index: number; answer: string; value?: string }[]
}

export function isPermissionQuestion(question: ProviderQuestion | null | undefined): boolean
export function isPermissionRequest(pending: PendingProviderQuestion | null | undefined): boolean
export function initialQuestionSelection(pending: PendingProviderQuestion | null | undefined): QuestionSelection
export function toggleQuestionOption(selection: QuestionSelection, question: ProviderQuestion, label: string): QuestionSelection
export function setQuestionText(selection: QuestionSelection, question: ProviderQuestion, text: string): QuestionSelection
export function questionAnswerText(selection: QuestionSelection, question: ProviderQuestion): string
export function questionAnswersReady(pending: PendingProviderQuestion | null | undefined, selection: QuestionSelection): boolean
export function questionAnswerPayload(pending: PendingProviderQuestion | null | undefined, selection: QuestionSelection): ProviderQuestionAnswerPayload | null
export function pendingQuestionsAfterEvent(current: PendingProviderQuestion[], event: ChatExecutionEvent | { type: string }): PendingProviderQuestion[]
export function pendingQuestionsFromEvents(events: ChatExecutionEvent[]): PendingProviderQuestion[]
export type PendingChatQuestion = PendingProviderQuestion & { chatId: string }

export function pendingQuestionsByChat(
  eventsByChat: Record<string, ChatExecutionEvent[]> | null | undefined,
): PendingChatQuestion[]
export function questionsNeedingAlert(
  pending: PendingChatQuestion[],
  announced: Set<string> | Iterable<string> | null | undefined,
): { alerts: PendingChatQuestion[]; announced: Set<string> }
export function questionAnswerSummary(
  pending: PendingProviderQuestion | null | undefined,
  answers: { index: number; answer: string }[],
): string
