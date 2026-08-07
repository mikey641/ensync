export const DEFAULT_EXECUTION_PANEL_OPEN: false

export function normalizeExecutionPanelOpenByChat(value: unknown): Record<string, boolean>
export function executionPanelOpenForChat(preferences: Readonly<Record<string, boolean>>, chatId: string): boolean
export function setExecutionPanelOpenForChat(
  preferences: Readonly<Record<string, boolean>>,
  chatId: string,
  open: boolean,
): Record<string, boolean>
