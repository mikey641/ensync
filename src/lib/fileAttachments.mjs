function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function normalizeFileAttachments(value) {
  if (!Array.isArray(value)) return []
  const seen = new Set()
  const normalized = []
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const path = nonEmptyString(item.path)
    const name = nonEmptyString(item.name)
    if (!path || !name || seen.has(path)) continue
    seen.add(path)
    normalized.push({ path, name })
  }
  return normalized
}

export function appendFileAttachments(current, incoming) {
  return normalizeFileAttachments([
    ...normalizeFileAttachments(current),
    ...normalizeFileAttachments(incoming),
  ])
}

export function fileDragContainsFiles(value) {
  try {
    const dataTransfer = value && typeof value === 'object' && !Array.isArray(value)
      && ('types' in value || 'items' in value || 'files' in value)
      ? value
      : null
    const types = dataTransfer?.types ?? value
    if (Array.from(types ?? []).some((type) => String(type).toLowerCase() === 'files')) {
      return true
    }
    if (Array.from(dataTransfer?.items ?? []).some((item) => item?.kind === 'file')) {
      return true
    }
    return Number(dataTransfer?.files?.length ?? 0) > 0
  } catch {
    return false
  }
}

export function droppedFileAttachments(files, pathForFile) {
  const attachments = []
  const unavailable = []
  if (typeof pathForFile !== 'function') {
    return { attachments, unavailable: Array.from(files ?? [], (file) => file?.name ?? 'file') }
  }

  for (const file of Array.from(files ?? [])) {
    const name = nonEmptyString(file?.name) ?? 'file'
    let path = null
    try {
      path = nonEmptyString(pathForFile(file))
    } catch {
      path = null
    }
    if (path) attachments.push({ name, path })
    else unavailable.push(name)
  }
  return { attachments: normalizeFileAttachments(attachments), unavailable }
}

export function messageTextWithAttachments(message, attachments) {
  const text = nonEmptyString(message) ?? ''
  const normalized = normalizeFileAttachments(attachments)
  if (normalized.length === 0) return text
  const references = normalized.map((attachment) => `- ${JSON.stringify(attachment.path)}`).join('\n')
  const attachmentBlock = [
    '[Explicitly attached local files]',
    references,
    'The user explicitly attached these files to this turn. Inspect them as needed for the request.',
  ].join('\n')
  return text ? `${text}\n\n${attachmentBlock}` : attachmentBlock
}

export function visibleMessageText(message, attachments) {
  const text = nonEmptyString(message)
  if (text) return text
  const count = normalizeFileAttachments(attachments).length
  return count === 1 ? 'Attached 1 file.' : `Attached ${count} files.`
}
