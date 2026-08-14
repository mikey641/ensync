const LINE_ENDING = /(?:\r\n|\n|\r)$/
const INDENTED_CODE = /^ {4,}/
const DELIMITER_CELL = /^:?-+:?$/
const ATX_HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/
const THEMATIC_BREAK = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/
const BLOCK_QUOTE = /^ {0,3}>[ \t]?/
const BULLET_ITEM = /^( {0,3})([-*+])([ \t]+)(.*)$/
const ORDERED_ITEM = /^( {0,3})(\d{1,9})([.)])([ \t]+)(.*)$/
const CLOSING_HASHES = /[ \t]+#+[ \t]*$/
const PUNCTUATION = /[!-/:-@[-`{-~]/
const BARE_URL = /^https?:\/\/[^\s<>]+/
const TRAILING_URL_PUNCTUATION = /[.,;:!?'")\]}]+$/
// Anchors, in-app paths, and ordinary web/mail destinations only: rendering an
// attacker-authored `javascript:` destination as a link would execute it.
const SAFE_HREF = /^(?:https?:\/\/|mailto:|#|\/)/i

function splitLines(content) {
  return content.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? []
}

function lineOf(lines, index) {
  return (lines[index] ?? '').replace(LINE_ENDING, '')
}

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
  const match = line.match(/^ {0,3}(`+|~+)[ \t]*$/)
  return Boolean(
    match
    && match[1][0] === fence.character
    && match[1].length >= fence.length,
  )
}

function codeFrom(lines, start, fence) {
  let code = ''
  let index = start + 1

  for (; index < lines.length; index += 1) {
    if (closesFence(lineOf(lines, index), fence)) {
      index += 1
      break
    }
    code += lines[index]
  }

  return { block: { type: 'code', code, language: fence.language }, next: index }
}

/** Splits one table line on unescaped pipes, dropping the optional edge pipes. */
function rowCells(line) {
  const cells = []
  let cell = ''

  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '\\' && line[index + 1] === '|') {
      cell += '|'
      index += 1
    } else if (line[index] === '|') {
      cells.push(cell)
      cell = ''
    } else {
      cell += line[index]
    }
  }
  cells.push(cell)

  if (cells.length > 1 && !cells[0].trim() && line.startsWith('|')) cells.shift()
  if (cells.length > 1 && !cells.at(-1).trim() && line.endsWith('|')) cells.pop()

  return cells.map(entry => entry.trim())
}

function alignmentOf(cell) {
  const start = cell.startsWith(':')
  const end = cell.endsWith(':')
  if (start && end) return 'center'
  if (end) return 'right'
  if (start) return 'left'
  return null
}

const LONG_MESSAGE_CHARACTER_LIMIT = 900
const LONG_MESSAGE_LINE_LIMIT = 14

export function isLongMessageContent(value) {
  const content = typeof value === 'string' ? value : String(value ?? '')
  if (Array.from(content).length > LONG_MESSAGE_CHARACTER_LIMIT) return true

  const lineBreaks = content.match(/\r\n|\n|\r/g)?.length ?? 0
  return lineBreaks + 1 > LONG_MESSAGE_LINE_LIMIT
}

/**
 * Reads a GitHub-style table: a header row, a delimiter row with matching cell
 * count, then rows until a blank or pipe-less line.
 */
function tableFrom(lines, start) {
  if (start + 1 >= lines.length) return null

  const headerLine = lineOf(lines, start)
  const delimiterLine = lineOf(lines, start + 1)
  if (INDENTED_CODE.test(headerLine) || INDENTED_CODE.test(delimiterLine)) return null
  if (!delimiterLine.includes('|')) return null

  const header = rowCells(headerLine.trim())
  const delimiters = rowCells(delimiterLine.trim())
  if (header.length < 1 || header.length !== delimiters.length) return null
  if (!delimiters.every(cell => DELIMITER_CELL.test(cell))) return null

  const rows = []
  let index = start + 2
  while (index < lines.length) {
    const line = lineOf(lines, index)
    if (!line.trim() || !line.includes('|') || INDENTED_CODE.test(line)) break

    const cells = rowCells(line.trim())
    rows.push(header.map((_, column) => cells[column] ?? ''))
    index += 1
  }

  return {
    block: { type: 'table', header, alignments: delimiters.map(alignmentOf), rows },
    next: index,
  }
}

function listItemAt(line) {
  if (THEMATIC_BREAK.test(line)) return null

  const bullet = line.match(BULLET_ITEM)
  if (bullet) {
    return {
      ordered: false,
      indent: bullet[1].length,
      contentIndent: bullet[1].length + 1 + bullet[3].length,
      start: null,
      text: bullet[4],
    }
  }

  const ordered = line.match(ORDERED_ITEM)
  if (!ordered) return null
  return {
    ordered: true,
    indent: ordered[1].length,
    contentIndent: ordered[1].length + ordered[2].length + 1 + ordered[4].length,
    start: Number(ordered[2]),
    text: ordered[5],
  }
}

function startsNewBlock(lines, index) {
  const line = lineOf(lines, index)
  return Boolean(
    !line.trim()
    || openingFence(line)
    || ATX_HEADING.test(line)
    || THEMATIC_BREAK.test(line)
    || BLOCK_QUOTE.test(line)
    || listItemAt(line)
    || tableFrom(lines, index),
  )
}

function quoteFrom(lines, start) {
  const collected = []
  let index = start

  while (index < lines.length) {
    const line = lineOf(lines, index)
    if (BLOCK_QUOTE.test(line)) {
      collected.push(line.replace(BLOCK_QUOTE, ''))
      index += 1
      continue
    }
    // A quote absorbs lazy continuation text but stops at anything that opens
    // its own block, so following prose is never pulled inside the quote.
    if (startsNewBlock(lines, index)) break
    collected.push(line)
    index += 1
  }

  return { block: { type: 'quote', blocks: parseBlocks(collected.join('\n')) }, next: index }
}

function listFrom(lines, start) {
  const first = listItemAt(lineOf(lines, start))
  if (!first) return null

  const items = []
  let index = start
  let blank = false

  while (index < lines.length) {
    const line = lineOf(lines, index)

    if (!line.trim()) {
      blank = true
      index += 1
      continue
    }

    const current = items.at(-1)
    const indent = line.match(/^ */)[0].length

    // Content indented to the marker belongs to the open item, so a nested list
    // is recursed into rather than flattened into a sibling.
    if (current && indent >= current.contentIndent) {
      if (blank) current.lines.push('')
      current.lines.push(line.slice(current.contentIndent))
      blank = false
      index += 1
      continue
    }

    const item = listItemAt(line)
    if (item && item.ordered === first.ordered && item.indent <= first.indent + 3) {
      items.push({ contentIndent: item.contentIndent, lines: [item.text] })
      blank = false
      index += 1
      continue
    }

    if (!current) break

    if (!blank && !startsNewBlock(lines, index)) {
      current.lines.push(line.trim())
      index += 1
      continue
    }

    break
  }

  if (!items.length) return null

  return {
    block: {
      type: 'list',
      ordered: first.ordered,
      start: first.ordered ? first.start ?? 1 : null,
      items: items.map(item => parseBlocks(item.lines.join('\n'))),
    },
    next: index,
  }
}

function parseBlocks(content) {
  const lines = splitLines(content)
  const blocks = []
  let paragraph = []
  let index = 0

  const flush = () => {
    const text = paragraph.join('\n').replace(/^\s+|\s+$/g, '')
    paragraph = []
    if (text) blocks.push({ type: 'paragraph', text })
  }

  while (index < lines.length) {
    const line = lineOf(lines, index)

    if (!line.trim()) {
      flush()
      index += 1
      continue
    }

    const fence = openingFence(line)
    if (fence) {
      flush()
      const code = codeFrom(lines, index, fence)
      blocks.push(code.block)
      index = code.next
      continue
    }

    const table = tableFrom(lines, index)
    if (table) {
      flush()
      blocks.push(table.block)
      index = table.next
      continue
    }

    const heading = line.match(ATX_HEADING)
    if (heading) {
      flush()
      blocks.push({
        type: 'heading',
        level: heading[1].length,
        text: (heading[2] ?? '').replace(CLOSING_HASHES, '').trim(),
      })
      index += 1
      continue
    }

    if (THEMATIC_BREAK.test(line)) {
      flush()
      blocks.push({ type: 'rule' })
      index += 1
      continue
    }

    if (BLOCK_QUOTE.test(line)) {
      flush()
      const quote = quoteFrom(lines, index)
      blocks.push(quote.block)
      index = quote.next
      continue
    }

    const list = listFrom(lines, index)
    if (list) {
      flush()
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

/**
 * Splits message Markdown into ordered block structures. The text is never
 * interpreted as HTML; only the Markdown constructs handled here are rendered.
 */
export function parseMessageContent(value) {
  const content = typeof value === 'string' ? value : String(value ?? '')
  if (!content) return []
  return parseBlocks(content)
}

function codeSpanAt(text, start) {
  const open = text.slice(start).match(/^`+/)[0]

  for (let search = start + open.length; search < text.length;) {
    const next = text.indexOf('`', search)
    if (next === -1) break

    const run = text.slice(next).match(/^`+/)[0]
    if (run.length === open.length) {
      let inner = text.slice(start + open.length, next)
      // CommonMark strips one padding space so `` ` `` can hold a backtick.
      if (inner.length > 2 && inner.startsWith(' ') && inner.endsWith(' ') && inner.trim()) {
        inner = inner.slice(1, -1)
      }
      return { text: inner, next: next + run.length }
    }
    search = next + run.length
  }

  return null
}

function linkAt(text, start) {
  let depth = 0
  let index = start

  for (; index < text.length; index += 1) {
    const character = text[index]
    if (character === '\\') {
      index += 1
      continue
    }
    if (character === '`') {
      const span = codeSpanAt(text, index)
      if (span) {
        index = span.next - 1
        continue
      }
    }
    if (character === '[') depth += 1
    else if (character === ']') {
      depth -= 1
      if (!depth) break
    }
  }
  if (depth !== 0 || index >= text.length || text[index + 1] !== '(') return null

  const label = text.slice(start + 1, index)
  let cursor = index + 2
  let parens = 1
  let destination = ''

  for (; cursor < text.length; cursor += 1) {
    const character = text[cursor]
    if (character === '\\') {
      destination += text[cursor + 1] ?? ''
      cursor += 1
      continue
    }
    if (character === '(') parens += 1
    if (character === ')') {
      parens -= 1
      if (!parens) break
    }
    destination += character
  }
  if (parens !== 0) return null

  let href = destination.trim()
  const titled = href.match(/^(\S+)[ \t]+["'(].*$/)
  if (titled) href = titled[1]
  if (href.startsWith('<') && href.endsWith('>')) href = href.slice(1, -1)

  return { label, href, next: cursor + 1 }
}

function flanking(text, start, run, character) {
  const before = text[start - 1] ?? ''
  const after = text[start + run] ?? ''
  const beforeSpace = !before || /\s/.test(before)
  const afterSpace = !after || /\s/.test(after)
  const beforePunctuation = Boolean(before) && PUNCTUATION.test(before)
  const afterPunctuation = Boolean(after) && PUNCTUATION.test(after)

  const left = !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation)
  const right = !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation)

  // Underscores never open or close inside a word, so identifiers such as
  // snake_case_name survive untouched.
  if (character === '_') {
    return {
      canOpen: left && (!right || beforePunctuation),
      canClose: right && (!left || afterPunctuation),
    }
  }
  return { canOpen: left, canClose: right }
}

function tokenizeInline(text) {
  const tokens = []
  let plain = ''
  let index = 0

  const pushPlain = () => {
    if (!plain) return
    tokens.push({ kind: 'text', text: plain })
    plain = ''
  }

  while (index < text.length) {
    const character = text[index]

    if (character === '\\' && PUNCTUATION.test(text[index + 1] ?? '')) {
      plain += text[index + 1]
      index += 2
      continue
    }

    if (character === '`') {
      const span = codeSpanAt(text, index)
      if (span) {
        pushPlain()
        tokens.push({ kind: 'code', text: span.text })
        index = span.next
        continue
      }
    }

    if (character === '<') {
      const wrapped = text.slice(index).match(/^<((?:https?:\/\/|mailto:)[^\s>]+)>/)
      if (wrapped) {
        pushPlain()
        tokens.push({ kind: 'link', href: wrapped[1], label: wrapped[1], literal: true })
        index += wrapped[0].length
        continue
      }
    }

    if (character === '[') {
      const link = linkAt(text, index)
      if (link) {
        pushPlain()
        tokens.push({ kind: 'link', href: link.href, label: link.label })
        index = link.next
        continue
      }
    }

    if ((character === 'h' || character === 'H') && (index === 0 || /[\s([]/.test(text[index - 1]))) {
      const bare = text.slice(index).match(BARE_URL)
      if (bare) {
        const href = bare[0].replace(TRAILING_URL_PUNCTUATION, '')
        if (href) {
          pushPlain()
          tokens.push({ kind: 'link', href, label: href, literal: true })
          index += href.length
          continue
        }
      }
    }

    if (character === '*' || character === '_' || character === '~') {
      const run = text.slice(index).match(new RegExp(`^\\${character}+`))[0].length
      const { canOpen, canClose } = flanking(text, index, run, character)
      pushPlain()
      tokens.push({ kind: 'delim', character, length: run, canOpen, canClose })
      index += run
      continue
    }

    plain += character
    index += 1
  }

  pushPlain()
  return tokens
}

function emphasisNode(character, consumed, children) {
  if (character === '~') return { type: 'strike', children }
  if (consumed === 3) return { type: 'em', children: [{ type: 'strong', children }] }
  return consumed === 2 ? { type: 'strong', children } : { type: 'em', children }
}

function linkNode(token) {
  if (!SAFE_HREF.test(token.href)) {
    return { type: 'text', text: token.literal ? token.label : `[${token.label}](${token.href})` }
  }
  // An autolink's label is its own destination; re-parsing it would rediscover
  // the same autolink forever.
  const children = token.literal
    ? [{ type: 'text', text: token.label }]
    : parseInline(token.label)
  return { type: 'link', href: token.href, children }
}

function finalizeInline(nodes) {
  const finalized = nodes.map((node) => {
    if (node.kind === 'node') return node.node
    if (node.kind === 'delim') return { type: 'text', text: node.character.repeat(node.length) }
    if (node.kind === 'text') return { type: 'text', text: node.text }
    if (node.kind === 'code') return { type: 'code', text: node.text }
    if (node.kind === 'link') return linkNode(node)
    return node
  })

  const merged = []
  for (const node of finalized) {
    const previous = merged.at(-1)
    if (node.type === 'text' && previous?.type === 'text') previous.text += node.text
    else merged.push(node)
  }
  return merged
}

/**
 * Resolves emphasis delimiters into a node tree. Scanning left to right and
 * pairing each closer with the nearest opener resolves innermost spans first.
 */
function buildInline(tokens) {
  const nodes = tokens.map(token => ({ ...token }))
  let position = 0

  while (position < nodes.length) {
    const closer = nodes[position]
    if (closer.kind !== 'delim' || !closer.canClose) {
      position += 1
      continue
    }

    let openerIndex = -1
    for (let scan = position - 1; scan >= 0; scan -= 1) {
      const candidate = nodes[scan]
      if (candidate.kind === 'delim' && candidate.character === closer.character && candidate.canOpen) {
        openerIndex = scan
        break
      }
    }
    if (openerIndex === -1) {
      position += 1
      continue
    }

    const opener = nodes[openerIndex]
    const consumed = closer.character === '~'
      ? 2
      : Math.min(opener.length, closer.length, 3)
    if (closer.character === '~' && (opener.length < 2 || closer.length < 2)) {
      position += 1
      continue
    }

    const children = finalizeInline(nodes.slice(openerIndex + 1, position))
    const replacement = []
    if (opener.length - consumed > 0) {
      replacement.push({ kind: 'text', text: opener.character.repeat(opener.length - consumed) })
    }
    replacement.push({ kind: 'node', node: emphasisNode(closer.character, consumed, children) })
    if (closer.length - consumed > 0) {
      replacement.push({ kind: 'text', text: closer.character.repeat(closer.length - consumed) })
    }

    nodes.splice(openerIndex, position - openerIndex + 1, ...replacement)
    position = openerIndex + replacement.length
  }

  return nodes.map(node => (node.kind === 'node' ? node.node : node))
}

/**
 * Splits inline Markdown into a node tree of text, code spans, links, and
 * emphasis. Unmatched delimiters stay literal.
 */
export function parseInline(value) {
  const text = typeof value === 'string' ? value : String(value ?? '')
  if (!text) return []
  return finalizeInline(buildInline(tokenizeInline(text)))
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

