function openingFence(line) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/)
  if (!match) return null

  const marker = match[1]
  const info = match[2].trim()
  if (marker[0] === '`' && info.includes('`')) return null

  return {
    character: marker[0],
    length: marker.length,
    language: info.split(/\s+/, 1)[0]?.slice(0, 64) || null,
  }
}

function closesFence(line, fence) {
  const match = line.match(/^ {0,3}(`+|~+)\s*$/)
  return Boolean(
    match
    && match[1][0] === fence.character
    && match[1].length >= fence.length,
  )
}

function appendTextBlock(blocks, text) {
  if (!text) return
  const previous = blocks.at(-1)
  if (previous?.type === 'text') {
    previous.text += text
  } else {
    blocks.push({ type: 'text', text })
  }
}

/**
 * Splits message Markdown into ordered prose and fenced-code blocks. The text
 * itself is never interpreted as HTML, and non-fence Markdown remains exact.
 */
export function parseMessageContent(value) {
  const content = typeof value === 'string' ? value : String(value ?? '')
  if (!content) return []

  const lines = content.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? []
  const blocks = []
  let text = ''
  let code = ''
  let fence = null

  for (const lineWithEnding of lines) {
    const line = lineWithEnding.replace(/(?:\r\n|\n|\r)$/, '')
    if (!fence) {
      const candidate = openingFence(line)
      if (!candidate) {
        text += lineWithEnding
        continue
      }

      appendTextBlock(blocks, text)
      text = ''
      code = ''
      fence = candidate
      continue
    }

    if (closesFence(line, fence)) {
      blocks.push({ type: 'code', code, language: fence.language })
      code = ''
      fence = null
    } else {
      code += lineWithEnding
    }
  }

  if (fence) {
    blocks.push({ type: 'code', code, language: fence.language })
  } else {
    appendTextBlock(blocks, text)
  }

  return blocks
}

const FILE_URL_PREFIX = 'file://'
const HTTPS_URL_PREFIX = 'https://'

// Markdown inline link with an optional <angle-bracketed> destination, a
// Markdown autolink, or a bare https URL. Nothing else becomes clickable, so a
// destination an agent wrote can never resolve to a script-bearing scheme.
const INLINE_LINK_PATTERN = /\[([^\]\n]*)\]\((<[^<>\n]*>|[^\s()]*)\)|<(https:\/\/[^\s<>]+)>|(https:\/\/[^\s<>"'`]+)/g

function encodeFilePathSegment(segment) {
  return segment.replace(
    /[\u0000-\u0020"#%<>?\\^\u0060{|}\u007f]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  )
}

function decodeFilePathSegment(segment) {
  try {
    return decodeURIComponent(segment)
  } catch {
    return segment
  }
}

function fileHrefFromPath(path) {
  const slashed = path.replace(/\\/g, '/')
  const rooted = slashed.startsWith('/') ? slashed : `/${slashed}`
  return `${FILE_URL_PREFIX}${rooted.split('/').map(encodeFilePathSegment).join('/')}`
}

function pathFromFileHref(href) {
  const rest = href.slice(FILE_URL_PREFIX.length)
  const start = rest.startsWith('/') ? rest : rest.slice(rest.indexOf('/'))
  if (!start.startsWith('/')) return null

  const decoded = start.split('/').map(decodeFilePathSegment).join('/')
  return /^\/[A-Za-z]:(?:[/\\]|$)/.test(decoded) ? decoded.slice(1) : decoded
}

function absoluteLocalPath(target) {
  if (target.startsWith('/')) return target
  return /^[A-Za-z]:[\\/]/.test(target) ? target : null
}

function resolveLinkTarget(target) {
  const trimmed = target.trim()
  if (!trimmed) return null

  const lowered = trimmed.toLowerCase()
  if (lowered.startsWith(HTTPS_URL_PREFIX)) {
    return trimmed.length > HTTPS_URL_PREFIX.length ? { kind: 'external', href: trimmed } : null
  }
  if (lowered.startsWith(FILE_URL_PREFIX)) {
    const path = pathFromFileHref(trimmed)
    return path ? { kind: 'file', href: trimmed, path } : null
  }

  const path = absoluteLocalPath(trimmed)
  return path ? { kind: 'file', href: fileHrefFromPath(path), path } : null
}

function trimTrailingUrlPunctuation(url) {
  let end = url.length
  while (end > 0) {
    const character = url[end - 1]
    if ('.,;:!?'.includes(character)) {
      end -= 1
      continue
    }
    if (character === ')') {
      const candidate = url.slice(0, end)
      const opened = candidate.split('(').length
      const closed = candidate.split(')').length
      if (closed > opened) {
        end -= 1
        continue
      }
    }
    break
  }

  return url.slice(0, end)
}

function appendInlineText(segments, text) {
  if (!text) return
  const previous = segments.at(-1)
  if (previous?.type === 'text') {
    previous.text += text
  } else {
    segments.push({ type: 'text', text })
  }
}

/**
 * Splits message prose into plain text and resolved links. Only https targets
 * and absolute local paths become links; every other destination is preserved
 * as the exact text the agent wrote.
 */
export function parseInlineSegments(value) {
  const content = typeof value === 'string' ? value : String(value ?? '')
  if (!content) return []

  const segments = []
  let index = 0
  INLINE_LINK_PATTERN.lastIndex = 0

  for (let match = INLINE_LINK_PATTERN.exec(content); match; match = INLINE_LINK_PATTERN.exec(content)) {
    let consumed = match[0].length
    let label = null
    let target = null

    if (match[2] !== undefined) {
      label = match[1]
      target = match[2].startsWith('<') && match[2].endsWith('>') ? match[2].slice(1, -1) : match[2]
    } else if (match[3] !== undefined) {
      target = match[3]
      label = target
    } else {
      target = trimTrailingUrlPunctuation(match[4])
      label = target
      consumed = target.length
    }

    const link = target ? resolveLinkTarget(target) : null
    // An unsupported destination stays prose, and the scan continues after the
    // whole raw match so a rejected link cannot be rescanned forever.
    if (!link) continue

    appendInlineText(segments, content.slice(index, match.index))
    segments.push(link.kind === 'file'
      ? { type: 'link', label: label || target, kind: 'file', href: link.href, path: link.path }
      : { type: 'link', label: label || target, kind: 'external', href: link.href })
    index = match.index + consumed
    INLINE_LINK_PATTERN.lastIndex = index
  }

  appendInlineText(segments, content.slice(index))
  return segments
}
