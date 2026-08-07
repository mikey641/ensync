function isAgentMessage(item) {
  return item?.type === 'agent_message' || item?.type === 'agentMessage'
}

/**
 * Selects user-visible Codex answer items without leaking commentary. Newer
 * Codex versions label final-answer items; older versions are kept compatible
 * by using their last unphased message, which was the previous Ensync behavior.
 */
export function finalCodexResponse(items) {
  const messages = []
  const indexesById = new Map()

  for (const item of items ?? []) {
    if (!isAgentMessage(item) || typeof item.text !== 'string' || !item.text.trim()) continue
    const message = {
      text: item.text.trim(),
      phase: item.phase ?? null,
    }
    if (typeof item.id === 'string' && item.id) {
      const existingIndex = indexesById.get(item.id)
      if (existingIndex !== undefined) {
        messages[existingIndex] = message
        continue
      }
      indexesById.set(item.id, messages.length)
    }
    messages.push(message)
  }

  const finalParts = messages
    .filter((message) => message.phase === 'final_answer')
    .map((message) => message.text)
  if (finalParts.length > 0) return finalParts.join('\n\n')

  return messages.filter((message) => message.phase === null).at(-1)?.text ?? null
}
