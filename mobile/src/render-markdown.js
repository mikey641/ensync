// Renders message Markdown with the desktop parser into DOM nodes (never
// innerHTML), isolating opposite-direction runs in <bdi> exactly like the
// desktop's MessageContent so Hebrew and English mix in the written order.

import { characterDirection, createBidiCursor } from '../../src/lib/bidiText.mjs'
import { parseMarkdown, safeMarkdownHref } from '../../src/lib/markdown.mjs'

function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attributes)) {
    if (value !== undefined && value !== null) node.setAttribute(key, value)
  }
  for (const child of children) if (child) node.append(child)
  return node
}

function directional(text, cursor) {
  const fragment = document.createDocumentFragment()
  for (const run of cursor.split(text)) {
    fragment.append(run.isolate ? el('bdi', {}, [run.text]) : document.createTextNode(run.text))
  }
  return fragment
}

function inline(nodes, cursor) {
  const fragment = document.createDocumentFragment()
  for (const node of nodes ?? []) {
    switch (node.type) {
      case 'text': fragment.append(directional(node.text, cursor)); break
      case 'code': fragment.append(el('code', { dir: 'ltr' }, [node.text])); break
      case 'strong': fragment.append(el('strong', {}, [inline(node.content, cursor)])); break
      case 'em': fragment.append(el('em', {}, [inline(node.content, cursor)])); break
      case 'del': fragment.append(el('del', {}, [inline(node.content, cursor)])); break
      case 'link': {
        const href = safeMarkdownHref(node.href)
        const external = href && /^(https?:|mailto:)/i.test(href)
        fragment.append(external
          ? el('a', { href, target: '_blank', rel: 'noopener noreferrer' }, [inline(node.content, cursor)])
          : el('span', { class: 'md-path' }, [inline(node.content, cursor)]))
        break
      }
      case 'image': fragment.append(el('span', { class: 'md-image' }, [`[${node.alt || 'image'}]`])); break
      default:
        if (Array.isArray(node.content)) fragment.append(inline(node.content, cursor))
        else if (typeof node.text === 'string') fragment.append(directional(node.text, cursor))
    }
  }
  return fragment
}

// The base direction of a block comes from its prose, not from inline code:
// a Hebrew sentence that opens with `src/file.ts` is still a right-to-left line.
function proseDirection(nodes) {
  for (const node of nodes ?? []) {
    if (node.type === 'code') continue
    if (typeof node.text === 'string') {
      for (const character of node.text) {
        const direction = characterDirection(character)
        if (direction) return direction
      }
    }
    const nested = Array.isArray(node.content) ? proseDirection(node.content) : null
    if (nested) return nested
  }
  return null
}

function dirOf(nodes) {
  return proseDirection(nodes) ?? 'auto'
}

function block(item, depth = 0) {
  const cursor = createBidiCursor()
  switch (item.type) {
    case 'heading': return el(`h${Math.min(6, Math.max(3, item.level + 2))}`, { dir: dirOf(item.content) }, [inline(item.content, cursor)])
    case 'paragraph': return el('p', { dir: dirOf(item.content) }, [inline(item.content, cursor)])
    case 'code': {
      const pre = el('pre', { dir: 'ltr' }, [el('code', {}, [item.code.replace(/\n$/, '')])])
      return el('div', { class: 'md-code' }, [item.language ? el('span', { class: 'md-code-lang' }, [item.language]) : null, pre])
    }
    case 'blockquote': return el('blockquote', { dir: 'auto' }, (item.blocks ?? []).map((child) => block(child, depth + 1)))
    case 'rule': return el('hr')
    case 'list': {
      const directions = (item.items ?? []).map((entry) => dirOf(entry.content))
      const listDir = directions.find((direction) => direction !== 'auto') ?? 'auto'
      const mixed = directions.some((direction) => direction !== 'auto' && direction !== listDir)
      const list = el(item.ordered ? 'ol' : 'ul', { dir: listDir, class: mixed ? 'mixed' : null, ...(item.ordered && item.start ? { start: String(item.start) } : {}) })
      for (const [index, entry] of (item.items ?? []).entries()) {
        const li = el('li', { dir: directions[index] }, [inline(entry.content, createBidiCursor())])
        for (const child of entry.children ?? []) li.append(block(child, depth + 1))
        list.append(li)
      }
      return list
    }
    case 'table': {
      const table = el('table')
      const head = el('tr', {}, (item.header ?? []).map((cell) => el('th', { dir: 'auto' }, [inline(cell, createBidiCursor())])))
      table.append(el('thead', {}, [head]))
      const bodyRows = (item.rows ?? []).map((row) => el('tr', {}, row.map((cell) => el('td', { dir: 'auto' }, [inline(cell, createBidiCursor())]))))
      table.append(el('tbody', {}, bodyRows))
      return el('div', { class: 'md-table' }, [table])
    }
    default:
      return el('p', { dir: 'auto' }, [String(item.text ?? '')])
  }
}

export function renderMarkdown(text) {
  const container = el('div', { class: 'md' })
  let blocks
  try {
    blocks = parseMarkdown(String(text ?? ''))
  } catch {
    blocks = [{ type: 'paragraph', content: [{ type: 'text', text: String(text ?? '') }] }]
  }
  for (const item of blocks) container.append(block(item))
  return container
}

/** Plain text with bidi isolation only (titles, previews, user messages). */
export function renderPlain(text) {
  const span = el('span', { dir: 'auto' })
  span.append(directional(String(text ?? ''), createBidiCursor()))
  return span
}
