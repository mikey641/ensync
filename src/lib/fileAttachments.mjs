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

// Drop time is the only moment the renderer can read files the OS hides from
// other processes (macOS screenshot drag temp dirs, for example). Paths the
// host cannot open are copied through the host right away and attached at the
// stored copy's path; everything else stays attached by reference so agents
// can still edit the original file.
export async function resolveDroppedAttachments(files, pathForFile, hostOps) {
  const unavailable = []
  if (typeof pathForFile !== 'function') {
    return { attachments: [], unavailable: Array.from(files ?? [], (file) => file?.name ?? 'file') }
  }

  const resolved = []
  for (const file of Array.from(files ?? [])) {
    const name = nonEmptyString(file?.name) ?? 'file'
    let path = null
    try {
      path = nonEmptyString(pathForFile(file))
    } catch {
      path = null
    }
    if (path) resolved.push({ file, name, path })
    else unavailable.push(name)
  }
  const byReference = () => ({
    attachments: normalizeFileAttachments(resolved),
    unavailable,
  })
  if (resolved.length === 0 || !hostOps) return byReference()

  let unreadable
  try {
    const probe = await hostOps.probeAttachmentPaths(resolved.map((item) => item.path))
    unreadable = new Set((probe?.results ?? [])
      .filter((result) => result?.readable === false)
      .map((result) => result.path))
  } catch {
    // The host is unreachable, so keep today's by-reference behavior; the
    // host re-probes every path at send time and fails with guidance then.
    return byReference()
  }

  const attachments = []
  for (const item of resolved) {
    if (!unreadable.has(item.path)) {
      attachments.push({ name: item.name, path: item.path })
      continue
    }
    try {
      const bytes = await item.file.arrayBuffer()
      const stored = await hostOps.storeChatAttachment(item.name, bytes)
      const storedPath = nonEmptyString(stored?.attachment?.path)
      if (!storedPath) throw new Error('The host did not return a stored attachment path.')
      attachments.push({ name: item.name, path: storedPath })
    } catch {
      unavailable.push(item.name)
    }
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

const PASTE_EXTENSIONS = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/tiff': 'tiff',
  'application/pdf': 'pdf',
}

/** A clipboard image is usually named just "image.png"; give each paste its own name. */
export function pastedAttachmentName(file, now = new Date(), index = 0) {
  const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
  const original = nonEmptyString(file?.name)
  const extension = original?.match(/\.([A-Za-z0-9]{1,8})$/)?.[1]?.toLowerCase()
    ?? PASTE_EXTENSIONS[String(file?.type ?? '').toLowerCase()]
    ?? 'bin'
  const generic = !original || /^image\.[a-z0-9]+$/i.test(original)
  if (!generic) return original
  return `pasted-${stamp}${index > 0 ? `-${index + 1}` : ''}.${extension}`
}

/**
 * Files pasted into a composer. A file copied in Finder still has a path and
 * is attached like a drop; clipboard image data (a screenshot, an image copied
 * from a browser) has no path, so the Host stores its bytes and the agent gets
 * that stored path.
 */
export async function resolvePastedAttachments(files, pathForFile, hostOps, now = new Date()) {
  const list = Array.from(files ?? [])
  const withPath = []
  const withoutPath = []
  for (const file of list) {
    let path = null
    try {
      path = typeof pathForFile === 'function' ? nonEmptyString(pathForFile(file)) : null
    } catch {
      path = null
    }
    if (path) withPath.push(file)
    else withoutPath.push(file)
  }
  const dropped = withPath.length > 0
    ? await resolveDroppedAttachments(withPath, pathForFile, hostOps)
    : { attachments: [], unavailable: [] }
  const attachments = [...dropped.attachments]
  const unavailable = [...dropped.unavailable]
  for (const [index, file] of withoutPath.entries()) {
    const name = pastedAttachmentName(file, now, index)
    if (!hostOps) {
      unavailable.push(name)
      continue
    }
    try {
      const stored = await hostOps.storeChatAttachment(name, await file.arrayBuffer())
      const storedPath = nonEmptyString(stored?.attachment?.path)
      if (!storedPath) throw new Error('The host did not return a stored attachment path.')
      attachments.push({ name, path: storedPath })
    } catch {
      unavailable.push(name)
    }
  }
  return { attachments: normalizeFileAttachments(attachments), unavailable }
}
