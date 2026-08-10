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

function appendTextPart(parts, text) {
  if (!text) return
  const previous = parts.at(-1)
  if (previous?.type === 'text') {
    previous.text += text
  } else {
    parts.push({ type: 'text', text })
  }
}

function safeHttpsTarget(value) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function closingCodeSpan(value, start) {
  let markerLength = 1
  while (value[start + markerLength] === '`') markerLength += 1
  const marker = '`'.repeat(markerLength)
  const closingStart = value.indexOf(marker, start + markerLength)
  return closingStart < 0 ? null : closingStart + markerLength
}

function markdownLinkAt(value, start) {
  if (value[start] !== '[') return null

  let labelEnd = start + 1
  for (; labelEnd < value.length; labelEnd += 1) {
    if (value[labelEnd] === '\n' || value[labelEnd] === '\r') return null
    if (value[labelEnd] === '\\') {
      labelEnd += 1
      continue
    }
    if (value[labelEnd] === ']') break
  }
  if (labelEnd >= value.length || value[labelEnd + 1] !== '(') return null

  const targetStart = labelEnd + 2
  let nestedParentheses = 0
  let targetEnd = targetStart
  for (; targetEnd < value.length; targetEnd += 1) {
    const character = value[targetEnd]
    if (character === '\n' || character === '\r') return null
    if (character === '\\') {
      targetEnd += 1
      continue
    }
    if (character === '(') {
      nestedParentheses += 1
      continue
    }
    if (character !== ')') continue
    if (nestedParentheses > 0) {
      nestedParentheses -= 1
      continue
    }
    break
  }
  if (targetEnd >= value.length) return null

  let target = value.slice(targetStart, targetEnd).trim()
  if (target.startsWith('<') && target.endsWith('>')) target = target.slice(1, -1)
  const label = value
    .slice(start + 1, labelEnd)
    .replace(/\\([\\[\]])/g, '$1')
  const href = target && !/\s/u.test(target)
    ? safeHttpsTarget(target.replace(/\\([\\()])/g, '$1'))
    : null

  return {
    end: targetEnd + 1,
    href,
    label,
    inert: value[start - 1] === '!' || !href || !label,
  }
}

function angleLinkAt(value, start) {
  if (value[start] !== '<' || value.slice(start + 1, start + 9).toLowerCase() !== 'https://') return null
  const end = value.indexOf('>', start + 9)
  if (end < 0) return null
  const label = value.slice(start + 1, end)
  if (/\s/u.test(label)) return null
  const href = safeHttpsTarget(label)
  return href ? { end: end + 1, href, label } : null
}

function trimBareUrlEnd(value, start, candidateEnd) {
  let end = candidateEnd
  while (end > start && /[.,:;!?\]}]/u.test(value[end - 1])) end -= 1

  while (end > start && value[end - 1] === ')') {
    const candidate = value.slice(start, end)
    const openingCount = (candidate.match(/\(/g) ?? []).length
    const closingCount = (candidate.match(/\)/g) ?? []).length
    if (closingCount <= openingCount) break
    end -= 1
  }
  return end
}

function bareLinkAt(value, start) {
  if (value.slice(start, start + 8).toLowerCase() !== 'https://') return null
  if (start > 0 && /[\p{L}\p{N}_]/u.test(value[start - 1])) return null

  let candidateEnd = start + 8
  while (candidateEnd < value.length && !/[\s<>"'`]/u.test(value[candidateEnd])) candidateEnd += 1
  const end = trimBareUrlEnd(value, start, candidateEnd)
  const label = value.slice(start, end)
  const href = safeHttpsTarget(label)
  return href ? { end, href, label } : null
}

/**
 * Turns safe HTTPS destinations in prose into link parts without interpreting
 * HTML or making inline-code spans and unsupported schemes interactive.
 */
export function parseMessageText(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  if (!text) return []

  const parts = []
  let plainStart = 0
  let cursor = 0

  while (cursor < text.length) {
    if (text[cursor] === '`') {
      const codeEnd = closingCodeSpan(text, cursor)
      if (codeEnd !== null) {
        cursor = codeEnd
        continue
      }
    }

    const markdownLink = markdownLinkAt(text, cursor)
    if (markdownLink?.inert) {
      cursor = markdownLink.end
      continue
    }

    const link = markdownLink ?? angleLinkAt(text, cursor) ?? bareLinkAt(text, cursor)
    if (!link) {
      cursor += 1
      continue
    }

    appendTextPart(parts, text.slice(plainStart, cursor))
    parts.push({ type: 'link', text: link.label, href: link.href })
    cursor = link.end
    plainStart = cursor
  }

  appendTextPart(parts, text.slice(plainStart))
  return parts
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
