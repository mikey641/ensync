/**
 * Minimal CommonMark/GFM subset used to render agent chat messages: headings,
 * paragraphs, lists, block quotes, thematic breaks, GFM tables, and inline
 * emphasis, code, strike-through, and links.
 *
 * The parser only ever produces plain data. Rendering turns that data into
 * React elements, so message text is never interpreted as HTML.
 *
 * Fenced code blocks are handled earlier by `parseMessageContent`; the text
 * that reaches this module contains no fences.
 */

const ESCAPABLE = /[\\`*_{}[\]()#+\-.!~|>]/
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+([^\n]*?))?[ \t]*$/
const RULE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/
const QUOTE = /^ {0,3}>[ \t]?/
const LIST_ITEM = /^([ \t]*)([-*+]|\d{1,9}[.)])(?:([ \t]+)([^\n]*)|[ \t]*$)/
const DELIMITER_CELL = /^:?-+:?$/

function textNode(value) {
  return { type: 'text', text: value }
}

function pushText(nodes, buffer) {
  if (!buffer) return
  const previous = nodes.at(-1)
  if (previous?.type === 'text') previous.text += buffer
  else nodes.push(textNode(buffer))
}

function isWordCharacter(character) {
  return Boolean(character) && /[A-Za-z0-9]/.test(character)
}

function matchDelimited(rest, marker) {
  // Lazily match `marker ... marker`, requiring non-space just inside both ends
  // so `a * b * c` and stray markers stay literal.
  const escaped = marker.replace(/[*]/g, '\\*')
  const pattern = new RegExp(`^${escaped}(?=[^\\s])([\\s\\S]*?[^\\s])${escaped}`)
  return rest.match(pattern)
}

/**
 * Parses inline Markdown into a flat list of inline nodes.
 */
export function parseInline(value) {
  const source = typeof value === 'string' ? value : String(value ?? '')
  const nodes = []
  let buffer = ''
  let index = 0

  while (index < source.length) {
    const character = source[index]
    const rest = source.slice(index)

    if (character === '\\' && ESCAPABLE.test(source[index + 1] ?? '')) {
      buffer += source[index + 1]
      index += 2
      continue
    }

    if (character === '`') {
      const code = rest.match(/^(`+)([\s\S]*?)\1(?!`)/)
      if (code) {
        pushText(nodes, buffer)
        buffer = ''
        const inner = code[2]
        const trimmed = /^ [\s\S]* $/.test(inner) && inner.trim() ? inner.slice(1, -1) : inner
        nodes.push({ type: 'code', text: trimmed })
        index += code[0].length
        continue
      }
    }

    if (character === '[') {
      const link = rest.match(/^\[([^\]]*)\]\(([^()\s]*)\)/)
      if (link) {
        pushText(nodes, buffer)
        buffer = ''
        nodes.push({ type: 'link', href: link[2], inline: parseInline(link[1]) })
        index += link[0].length
        continue
      }
    }

    if (character === '~' && source[index + 1] === '~') {
      const strike = matchDelimited(rest, '~~')
      if (strike) {
        pushText(nodes, buffer)
        buffer = ''
        nodes.push({ type: 'strike', inline: parseInline(strike[1]) })
        index += strike[0].length
        continue
      }
    }

    if (character === '*' || character === '_') {
      // `_` must not join words, so identifiers like some_long_name stay literal.
      const intraword = character === '_' && isWordCharacter(source[index - 1])
      const double = source[index + 1] === character
      const marker = double ? character + character : character
      const match = intraword ? null : matchDelimited(rest, marker)
      if (match && !(character === '_' && isWordCharacter(source[index + match[0].length]))) {
        pushText(nodes, buffer)
        buffer = ''
        nodes.push({
          type: double ? 'strong' : 'emphasis',
          inline: parseInline(match[1]),
        })
        index += match[0].length
        continue
      }
    }

    buffer += character
    index += 1
  }

  pushText(nodes, buffer)
  return nodes
}

/**
 * Message text comes from a CLI provider, so only navigable schemes become
 * links. Anything else (javascript:, data:, protocol-relative, …) returns null
 * and renders as plain text.
 */
export function safeMarkdownHref(value) {
  const href = typeof value === 'string' ? value.trim() : ''
  if (!href || href.startsWith('//')) return null
  // Strip control characters that can hide a scheme, e.g. "java\nscript:".
  const probe = href.replace(/[\x00-\x20]/g, '').toLowerCase()
  if (/^(https?:|mailto:)/.test(probe)) return href
  return /^[a-z][a-z0-9+.-]*:/.test(probe) ? null : href
}

function splitCells(line) {
  const cells = []
  let current = ''
  let fence = 0

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (character === '\\' && line[index + 1] === '|') {
      current += '|'
      index += 1
      continue
    }
    if (character === '`') {
      let run = 0
      while (line[index + run] === '`') run += 1
      current += '`'.repeat(run)
      if (fence === 0) fence = run
      else if (fence === run) fence = 0
      index += run - 1
      continue
    }
    if (character === '|' && fence === 0) {
      cells.push(current)
      current = ''
      continue
    }
    current += character
  }

  cells.push(current)

  const trimmed = line.trim()
  if (trimmed.startsWith('|')) cells.shift()
  if (trimmed.endsWith('|') && cells.length > 0 && !cells.at(-1)?.trim()) cells.pop()
  return cells.map((cell) => cell.trim())
}

function delimiterAlignments(line) {
  if (!line || !line.includes('-')) return null
  const cells = splitCells(line)
  if (cells.length === 0) return null
  if (!cells.every((cell) => DELIMITER_CELL.test(cell))) return null
  return cells.map((cell) => {
    const left = cell.startsWith(':')
    const right = cell.endsWith(':')
    if (left && right) return 'center'
    if (right) return 'right'
    if (left) return 'left'
    return null
  })
}

function listItemMatch(line) {
  const match = line.match(LIST_ITEM)
  if (!match) return null
  const indent = match[1].length
  const marker = match[2]
  const ordered = /\d/.test(marker)
  const spacing = match[3] ?? ' '
  return {
    indent,
    ordered,
    start: ordered ? Number.parseInt(marker, 10) : 1,
    contentIndent: indent + marker.length + spacing.length,
    text: match[4] ?? '',
  }
}

function startsBlock(lines, index) {
  const line = lines[index]
  if (!line.trim()) return true
  if (HEADING.test(line) || RULE.test(line) || QUOTE.test(line)) return true
  if (listItemMatch(line)) return true
  return Boolean(line.includes('|') && delimiterAlignments(lines[index + 1]))
}

function indentWidth(line) {
  return line.match(/^[ \t]*/)?.[0].length ?? 0
}

function parseListItemContent(lines, index, contentIndent) {
  const collected = [lines[index] === undefined ? '' : listItemMatch(lines[index]).text]
  let cursor = index + 1

  while (cursor < lines.length) {
    const line = lines[cursor]

    if (!line.trim()) {
      let lookahead = cursor
      while (lookahead < lines.length && !lines[lookahead].trim()) lookahead += 1
      if (lookahead >= lines.length || indentWidth(lines[lookahead]) < contentIndent) break
      collected.push('')
      cursor += 1
      continue
    }

    if (indentWidth(line) >= contentIndent) {
      collected.push(line.slice(contentIndent))
      cursor += 1
      continue
    }

    // A less-indented line ends the item unless it is a plain lazy continuation.
    if (listItemMatch(line) || startsBlock(lines, cursor)) break
    collected.push(line.trim())
    cursor += 1
  }

  while (collected.length > 0 && !collected.at(-1)?.trim()) collected.pop()
  return { content: collected.join('\n'), next: cursor }
}

function parseBlocks(lines) {
  const blocks = []
  let index = 0

  while (index < lines.length) {
    const line = lines[index]

    if (!line.trim()) {
      index += 1
      continue
    }

    if (RULE.test(line)) {
      blocks.push({ type: 'rule' })
      index += 1
      continue
    }

    const heading = line.match(HEADING)
    if (heading) {
      const content = (heading[2] ?? '').replace(/[ \t]+#+[ \t]*$/, '')
      blocks.push({ type: 'heading', level: heading[1].length, inline: parseInline(content) })
      index += 1
      continue
    }

    if (QUOTE.test(line)) {
      const quoted = []
      while (index < lines.length && (QUOTE.test(lines[index]) || (quoted.length > 0 && lines[index].trim()))) {
        quoted.push(lines[index].replace(QUOTE, ''))
        index += 1
      }
      blocks.push({ type: 'quote', blocks: parseBlocks(quoted) })
      continue
    }

    const align = line.includes('|') ? delimiterAlignments(lines[index + 1]) : null
    if (align) {
      const header = splitCells(line)
      if (header.length === align.length) {
        const rows = []
        index += 2
        while (index < lines.length && lines[index].trim() && lines[index].includes('|')) {
          const cells = splitCells(lines[index])
          while (cells.length < align.length) cells.push('')
          rows.push(cells.slice(0, align.length).map((cell) => parseInline(cell)))
          index += 1
        }
        blocks.push({
          type: 'table',
          align,
          header: header.map((cell) => parseInline(cell)),
          rows,
        })
        continue
      }
    }

    const item = listItemMatch(line)
    if (item) {
      const items = []
      const { ordered, start, indent } = item
      while (index < lines.length) {
        const candidate = listItemMatch(lines[index])
        if (!candidate || candidate.indent !== indent || candidate.ordered !== ordered) break
        const parsed = parseListItemContent(lines, index, candidate.contentIndent)
        items.push(parseBlocks(parsed.content.split('\n')))
        index = parsed.next
      }
      blocks.push({ type: 'list', ordered, start, items })
      continue
    }

    const paragraph = [line]
    index += 1
    while (index < lines.length && !startsBlock(lines, index)) {
      paragraph.push(lines[index])
      index += 1
    }
    blocks.push({ type: 'paragraph', inline: parseInline(paragraph.join('\n').trim()) })
  }

  return blocks
}

/**
 * Parses Markdown prose into an ordered list of block nodes.
 */
export function parseMarkdown(value) {
  const source = typeof value === 'string' ? value : String(value ?? '')
  if (!source.trim()) return []
  return parseBlocks(source.replace(/\r\n?/g, '\n').split('\n'))
}
