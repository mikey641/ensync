const ESCAPABLE = new Set('\\`*_{}[]()#+-.!|~<>')
const MAX_BLOCK_DEPTH = 16
const MAX_INLINE_DEPTH = 8

const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)(?:\s+#+)?\s*$/
const RULE_RE = /^ {0,3}([*_-])( *\1){2,} *$/
const QUOTE_RE = /^ {0,3}> ?(.*)$/
const LIST_ITEM_RE = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/
const LINK_RE = /^\[([^\]\n]*)\]\(\s*<?([^\s)>]*)>?(?:\s+"[^"]*")?\s*\)/
const IMAGE_RE = /^!\[([^\]\n]*)\]\(\s*<?([^\s)>]*)>?(?:\s+"[^"]*")?\s*\)/
const AUTOLINK_RE = /^https?:\/\/[^\s<>`]+/i

function pushText(nodes, value) {
  if (!value) return
  const previous = nodes.at(-1)
  if (previous?.type === 'text') previous.text += value
  else nodes.push({ type: 'text', text: value })
}

function isWhitespace(char) {
  return char === undefined || /\s/.test(char)
}

function isWordChar(char) {
  return char !== undefined && /[\p{L}\p{N}_]/u.test(char)
}

function findCodeSpan(text, index) {
  let length = 1
  while (text[index + length] === '`') length += 1
  const marker = '`'.repeat(length)
  let search = index + length
  while (search < text.length) {
    const found = text.indexOf(marker, search)
    if (found === -1) return null
    let runEnd = found + length
    while (text[runEnd] === '`') runEnd += 1
    if (runEnd - found === length) {
      let content = text.slice(index + length, found)
      if (content.length >= 2 && content.startsWith(' ') && content.endsWith(' ') && content.trim()) {
        content = content.slice(1, -1)
      }
      return { node: { type: 'code', text: content }, next: runEnd }
    }
    search = runEnd
  }
  return null
}

function findDelimited(text, index, marker, wordBoundary) {
  const start = index + marker.length
  if (isWhitespace(text[start])) return null
  if (wordBoundary && isWordChar(text[index - 1])) return null
  let search = start
  while (search < text.length) {
    const found = text.indexOf(marker, search)
    if (found === -1) return null
    if (found === start) {
      search = found + marker.length
      continue
    }
    if (isWhitespace(text[found - 1]) || (wordBoundary && isWordChar(text[found + marker.length]))) {
      search = found + 1
      continue
    }
    return { content: text.slice(start, found), next: found + marker.length }
  }
  return null
}

function tryEmphasis(text, index, marker, type, wordBoundary, depth) {
  const closed = findDelimited(text, index, marker, wordBoundary)
  if (!closed) return null
  return {
    node: { type, content: parseInlineInternal(closed.content, depth + 1) },
    next: closed.next,
  }
}

function trimAutolink(url) {
  let result = url
  while (result.length) {
    const last = result.at(-1)
    if ('.,;:!?\'"'.includes(last)) {
      result = result.slice(0, -1)
      continue
    }
    if (last === ')') {
      const opens = (result.match(/\(/g) ?? []).length
      const closes = (result.match(/\)/g) ?? []).length
      if (closes > opens) {
        result = result.slice(0, -1)
        continue
      }
    }
    break
  }
  return result
}

function parseInlineInternal(text, depth) {
  const nodes = []
  let index = 0
  while (index < text.length) {
    const char = text[index]

    if (char === '\\' && ESCAPABLE.has(text[index + 1])) {
      pushText(nodes, text[index + 1])
      index += 2
      continue
    }

    if (char === '`') {
      const span = findCodeSpan(text, index)
      if (span) {
        nodes.push(span.node)
        index = span.next
        continue
      }
    }

    if (depth < MAX_INLINE_DEPTH) {
      if (char === '!' && text[index + 1] === '[') {
        const match = IMAGE_RE.exec(text.slice(index))
        if (match) {
          nodes.push({ type: 'image', src: match[2], alt: match[1] })
          index += match[0].length
          continue
        }
      }

      if (char === '[') {
        const match = LINK_RE.exec(text.slice(index))
        if (match) {
          nodes.push({ type: 'link', href: match[2], content: parseInlineInternal(match[1], depth + 1) })
          index += match[0].length
          continue
        }
      }

      if ((char === 'h' || char === 'H') && !isWordChar(text[index - 1])) {
        const match = AUTOLINK_RE.exec(text.slice(index))
        if (match) {
          const url = trimAutolink(match[0])
          if (url.length > 'https://'.length) {
            nodes.push({ type: 'link', href: url, content: [{ type: 'text', text: url }] })
            index += url.length
            continue
          }
        }
      }

      let emphasis = null
      if (text.startsWith('**', index)) emphasis = tryEmphasis(text, index, '**', 'strong', false, depth)
      else if (text.startsWith('__', index)) emphasis = tryEmphasis(text, index, '__', 'strong', true, depth)
      else if (text.startsWith('~~', index)) emphasis = tryEmphasis(text, index, '~~', 'del', false, depth)
      else if (char === '*') emphasis = tryEmphasis(text, index, '*', 'em', false, depth)
      else if (char === '_') emphasis = tryEmphasis(text, index, '_', 'em', true, depth)
      if (emphasis) {
        nodes.push(emphasis.node)
        index = emphasis.next
        continue
      }
    }

    pushText(nodes, char)
    index += 1
  }
  return nodes
}

function parseInlineModern(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  return parseInlineInternal(text, 0)
}

function splitTableRow(line) {
  let content = line.trim()
  if (content.startsWith('|')) content = content.slice(1)
  if (content.endsWith('|') && !content.endsWith('\\|')) content = content.slice(0, -1)
  const cells = []
  let current = ''
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index]
    if (char === '\\' && content[index + 1] === '|') {
      current += '\\|'
      index += 1
    } else if (char === '|') {
      cells.push(current)
      current = ''
    } else {
      current += char
    }
  }
  cells.push(current)
  return cells
}

function tableAlignment(line) {
  if (!line.includes('-')) return null
  const cells = splitTableRow(line)
  if (!cells.length) return null
  const align = []
  for (const cell of cells) {
    const trimmed = cell.trim()
    if (!/^:?-+:?$/.test(trimmed)) return null
    const left = trimmed.startsWith(':')
    const right = trimmed.endsWith(':')
    align.push(left && right ? 'center' : right ? 'right' : left ? 'left' : null)
  }
  return align
}

function parseTable(lines, index) {
  const align = tableAlignment(lines[index + 1] ?? '')
  if (!align) return null
  const headerCells = splitTableRow(lines[index])
  if (headerCells.length !== align.length) return null
  const header = headerCells.map((cell) => parseInlineModern(cell.trim()))
  const rows = []
  let next = index + 2
  while (next < lines.length) {
    const line = lines[next]
    if (!line.trim() || !line.includes('|')) break
    const cells = splitTableRow(line).map((cell) => parseInlineModern(cell.trim()))
    while (cells.length < align.length) cells.push([])
    rows.push(cells.slice(0, align.length))
    next += 1
  }
  return { block: { type: 'table', align, header, rows }, next }
}

function parseListAt(lines, start) {
  const first = lines[start].match(LIST_ITEM_RE)
  const baseIndent = first[1].length
  const ordered = /^\d/.test(first[2])
  const items = []
  const block = {
    type: 'list',
    ordered,
    start: ordered ? Number.parseInt(first[2], 10) : null,
    items,
  }
  let index = start
  while (index < lines.length) {
    const match = lines[index].match(LIST_ITEM_RE)
    if (!match) break
    const indent = match[1].length
    if (indent >= baseIndent + 2) {
      const nested = parseListAt(lines, index)
      items.at(-1)?.children.push(nested.block)
      index = nested.next
      continue
    }
    if (indent < baseIndent) break
    if (/^\d/.test(match[2]) !== ordered) break
    items.push({ content: parseInlineModern(match[3].trim()), children: [] })
    index += 1
  }
  return { block, next: index }
}

function parseTextBlocks(text, depth) {
  const lines = text.split(/\r\n|\n|\r/)
  const blocks = []
  let paragraph = []

  const flush = () => {
    if (!paragraph.length) return
    blocks.push({ type: 'paragraph', content: parseInlineModern(paragraph.join('\n')) })
    paragraph = []
  }

  let index = 0
  while (index < lines.length) {
    const line = lines[index]

    if (!line.trim()) {
      flush()
      index += 1
      continue
    }

    const heading = line.match(HEADING_RE)
    if (heading?.[2].trim()) {
      flush()
      blocks.push({ type: 'heading', level: heading[1].length, content: parseInlineModern(heading[2].trim()) })
      index += 1
      continue
    }

    if (RULE_RE.test(line)) {
      flush()
      blocks.push({ type: 'rule' })
      index += 1
      continue
    }

    if (QUOTE_RE.test(line) && depth < MAX_BLOCK_DEPTH) {
      flush()
      const quoted = []
      while (index < lines.length) {
        const quote = lines[index].match(QUOTE_RE)
        if (!quote) break
        quoted.push(quote[1])
        index += 1
      }
      blocks.push({ type: 'blockquote', blocks: parseMarkdownInternal(quoted.join('\n'), depth + 1) })
      continue
    }

    if (line.includes('|')) {
      const table = parseTable(lines, index)
      if (table) {
        flush()
        blocks.push(table.block)
        index = table.next
        continue
      }
    }

    if (LIST_ITEM_RE.test(line)) {
      flush()
      const list = parseListAt(lines, index)
      blocks.push(list.block)
      index = list.next
      continue
    }

    paragraph.push(line)
    index += 1
  }

  flush()
  return blocks
}

// --- Fenced-code splitting -------------------------------------------------
// Kept local on purpose: parseMessageContent in messageContent.mjs grew into a
// full block parser, while this module needs only the fence boundaries so code
// is never reinterpreted as Markdown.

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

function appendTextSegment(segments, text) {
  if (!text) return
  const previous = segments.at(-1)
  if (previous?.type === 'text') previous.text += text
  else segments.push({ type: 'text', text })
}

function splitFencedSegments(value) {
  const content = typeof value === 'string' ? value : String(value ?? '')
  if (!content) return []

  const lines = content.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? []
  const segments = []
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

      appendTextSegment(segments, text)
      text = ''
      code = ''
      fence = candidate
      continue
    }

    if (closesFence(line, fence)) {
      segments.push({ type: 'code', code, language: fence.language })
      code = ''
      fence = null
    } else {
      code += lineWithEnding
    }
  }

  if (fence) {
    segments.push({ type: 'code', code, language: fence.language })
  } else {
    appendTextSegment(segments, text)
  }

  return segments
}

function parseMarkdownInternal(value, depth) {
  const blocks = []
  for (const segment of splitFencedSegments(value)) {
    if (segment.type === 'code') blocks.push(segment)
    else blocks.push(...parseTextBlocks(segment.text, depth))
  }
  return blocks
}

/**
 * Splits inline Markdown into emphasis, code spans, links, images, and text.
 * Unmatched delimiters and intraword underscores stay literal.
 */
export function parseInline(value) {
  return parseInlineModern(value)
}

/**
 * Parses message Markdown into renderable blocks. Fenced code is split out
 * first, so code is never reinterpreted; prose that matches no construct stays
 * a paragraph with its line breaks intact. Raw HTML is never parsed — text
 * stays text.
 */
export function parseMarkdown(value) {
  return parseMarkdownInternal(value, 0)
}

/**
 * Sanitises a Markdown link destination for direct anchor rendering. Web and
 * mail schemes plus scheme-less relative targets survive unchanged; script or
 * data schemes (in any casing or whitespace disguise), protocol-relative URLs,
 * and blank values are refused with null.
 */
export function safeMarkdownHref(value) {
  if (typeof value !== 'string' || !value.trim()) return null
  const normalized = value.replace(/[\u0000-\u0020]+/g, '')
  if (normalized.startsWith('//')) return null
  const scheme = normalized.match(/^([A-Za-z][A-Za-z0-9+.-]*):/)
  if (scheme && !/^(?:https?|mailto)$/i.test(scheme[1])) return null
  return value
}

/**
 * Classifies a link destination for the renderer: http(s)/mailto open
 * externally, absolute/home/drive/file paths open through the native shell,
 * and every other scheme (javascript:, data:, relative URLs) renders as text.
 */
export function classifyLinkTarget(href) {
  const value = typeof href === 'string' ? href.trim() : ''
  if (!value) return { kind: 'none' }
  if (/^https?:\/\//i.test(value) || /^mailto:/i.test(value)) return { kind: 'external', url: value }
  if (/^file:\/\//i.test(value)) {
    try {
      let path = decodeURIComponent(new URL(value).pathname)
      if (/^\/[A-Za-z]:\//.test(path)) path = path.slice(1)
      return { kind: 'file', path }
    } catch {
      return { kind: 'none' }
    }
  }
  if (value.startsWith('/') || value === '~' || value.startsWith('~/')) return { kind: 'file', path: value }
  if (/^[A-Za-z]:[\\/]/.test(value)) return { kind: 'file', path: value }
  return { kind: 'none' }
}

/**
 * Detects file references in inline code: absolute, home, or drive paths, or
 * relative paths whose final segment has a file extension, with an optional
 * trailing :line[:column]. Everything else (commands, URLs, JSON-RPC method
 * names like turn/started) returns null.
 */
export function filePathFromText(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text || /[\s`]/.test(text) || text.includes('://')) return null
  const lineMatch = text.match(/:(\d{1,7})(?::\d{1,7})?$/)
  const path = lineMatch ? text.slice(0, lineMatch.index) : text
  const line = lineMatch ? Number.parseInt(lineMatch[1], 10) : null
  if (!path) return null
  if (path.startsWith('/') || path === '~' || path.startsWith('~/') || /^[A-Za-z]:[\\/]/.test(path)) {
    return { path, line }
  }
  if (!path.includes('/') || path.includes('..')) return null
  const segment = path.split('/').at(-1) ?? ''
  if (!/\.[A-Za-z0-9]{1,8}$/.test(segment)) return null
  return { path, line }
}
