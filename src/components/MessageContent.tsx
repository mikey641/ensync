import { createElement, Fragment, useId, useMemo, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronUp, Copy } from 'lucide-react'
import { classifyLinkTarget, filePathFromText, parseMarkdown } from '../lib/markdown.mjs'
import type { InlineNode, MarkdownBlock } from '../lib/markdown.mjs'
import {
  isLongMessageContent,
  parseInline,
  parseInlineSegments,
  parseMessageContent,
} from '../lib/messageContent.mjs'
import type {
  MessageContentBlock,
  MessageInlineLink,
  MessageInlineNode,
  MessageTableAlignment,
} from '../lib/messageContent.mjs'
import './MessageContent.css'

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const
const CELL_ALIGNMENT = { left: 'start', center: 'center', right: 'end' } as const

function CodeBlock({ code, language }: { code: string; language: string | null }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1_500)
    } catch {
      setCopied(false)
    }
  }

  return (
    <div className="message-code-block">
      <div className="message-code-block__header">
        <span>{language ?? 'code'}</span>
        <button type="button" onClick={copy} aria-label={copied ? 'Code copied' : 'Copy code'}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre dir="ltr"><code>{code}</code></pre>
    </div>
  )
}

// --- Rich Markdown rendering (used when a project path is available) --------

function canOpenNatively() {
  return typeof window.ensyncDesktop?.openPath === 'function'
}

function FileChip({ display, path, line, projectPath }: {
  display: string
  path: string
  line: number | null
  projectPath?: string | null
}) {
  const [failed, setFailed] = useState(false)

  const open = async () => {
    let ok: boolean
    try {
      const target = line == null ? path : `${path}:${line}`
      const result = await window.ensyncDesktop?.openPath?.({ path: target, projectPath: projectPath ?? null })
      ok = result?.ok === true
    } catch {
      ok = false
    }
    if (!ok) {
      setFailed(true)
      window.setTimeout(() => setFailed(false), 1_800)
    }
  }

  return (
    <button
      type="button"
      className={failed ? 'message-file-chip message-file-chip--failed' : 'message-file-chip'}
      onClick={open}
      title={failed ? "Couldn't open" : `Open ${path}`}
    >
      <code dir="ltr">{display}</code>
    </button>
  )
}

function inlineText(nodes: InlineNode[]): string {
  return nodes.map((node) => {
    if (node.type === 'text' || node.type === 'code') return node.text
    if (node.type === 'image') return node.alt
    return inlineText(node.content)
  }).join('')
}

function renderInline(nodes: InlineNode[], projectPath: string | null | undefined): ReactNode[] {
  return nodes.map((node, key) => {
    switch (node.type) {
      case 'text':
        return node.text
      case 'strong':
        return <strong key={key}>{renderInline(node.content, projectPath)}</strong>
      case 'em':
        return <em key={key}>{renderInline(node.content, projectPath)}</em>
      case 'del':
        return <del key={key}>{renderInline(node.content, projectPath)}</del>
      case 'code': {
        const file = filePathFromText(node.text)
        if (file && canOpenNatively() && (file.path.startsWith('/') || file.path.startsWith('~') || Boolean(projectPath))) {
          return <FileChip key={key} display={node.text} path={file.path} line={file.line} projectPath={projectPath} />
        }
        return <code key={key} className="message-inline-code" dir="ltr">{node.text}</code>
      }
      case 'link': {
        const target = classifyLinkTarget(node.href)
        if (target.kind === 'external') {
          return <a key={key} href={target.url} target="_blank" rel="noreferrer">{renderInline(node.content, projectPath)}</a>
        }
        if (target.kind === 'file' && canOpenNatively()) {
          const file = filePathFromText(target.path) ?? { path: target.path, line: null }
          return <FileChip key={key} display={inlineText(node.content) || target.path} path={file.path} line={file.line} projectPath={projectPath} />
        }
        return <span key={key}>{renderInline(node.content, projectPath)}</span>
      }
      case 'image': {
        const target = classifyLinkTarget(node.src)
        if (target.kind === 'external' && !/^mailto:/i.test(target.url)) {
          return <img key={key} className="message-content__image" src={target.url} alt={node.alt} loading="lazy" />
        }
        if (target.kind === 'file' && canOpenNatively()) {
          const file = filePathFromText(target.path) ?? { path: target.path, line: null }
          return <FileChip key={key} display={node.alt || target.path} path={file.path} line={file.line} projectPath={projectPath} />
        }
        return node.alt
      }
    }
  })
}

function renderMarkdownBlocks(blocks: MarkdownBlock[], projectPath: string | null | undefined): ReactNode[] {
  return blocks.map((block, key) => {
    switch (block.type) {
      case 'paragraph':
        return <p key={key} dir="auto">{renderInline(block.content, projectPath)}</p>
      case 'heading': {
        const Tag = HEADING_TAGS[block.level - 1] ?? 'h6'
        return <Tag key={key} dir="auto">{renderInline(block.content, projectPath)}</Tag>
      }
      case 'code':
        return <CodeBlock key={key} code={block.code} language={block.language} />
      case 'rule':
        return <hr key={key} />
      case 'blockquote':
        return <blockquote key={key} dir="auto">{renderMarkdownBlocks(block.blocks, projectPath)}</blockquote>
      case 'list': {
        const items = block.items.map((item, itemKey) => (
          <li key={itemKey} dir="auto">
            {renderInline(item.content, projectPath)}
            {item.children.length > 0 && renderMarkdownBlocks(item.children, projectPath)}
          </li>
        ))
        return block.ordered
          ? <ol key={key} start={block.start ?? undefined}>{items}</ol>
          : <ul key={key}>{items}</ul>
      }
      case 'table': {
        const alignStyle = (column: number): CSSProperties | undefined => {
          const align = block.align[column]
          return align ? { textAlign: align } : undefined
        }
        return (
          <div key={key} className="message-content__table">
            <table>
              <thead>
                <tr>
                  {block.header.map((cell, column) => (
                    <th key={column} dir="auto" style={alignStyle(column)}>{renderInline(cell, projectPath)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowKey) => (
                  <tr key={rowKey}>
                    {row.map((cell, column) => (
                      <td key={column} dir="auto" style={alignStyle(column)}>{renderInline(cell, projectPath)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      }
    }
  })
}

// --- Structured rendering (default conversation mode) -----------------------

function InlineLink({ segment, onOpenFile }: {
  segment: MessageInlineLink
  onOpenFile?: (path: string) => void
}) {
  if (segment.kind === 'file') {
    // A local path cannot navigate the workspace origin. Ensync displays the
    // file itself, and falls back to the native shell only where no viewer is
    // wired up. Browser mode without either keeps the plain file href.
    const openFile = (event: MouseEvent<HTMLAnchorElement>) => {
      if (onOpenFile) {
        event.preventDefault()
        onOpenFile(segment.path)
        return
      }

      const openLocalFile = window.ensyncDesktop?.openLocalFile
      if (typeof openLocalFile !== 'function') return
      event.preventDefault()
      void openLocalFile(segment.path)
    }

    return (
      <a className="message-link" href={segment.href} title={segment.path} onClick={openFile} dir="ltr">
        {segment.label}
      </a>
    )
  }

  return (
    <a className="message-link" href={segment.href} title={segment.href} target="_blank" rel="noreferrer">
      {segment.label}
    </a>
  )
}

function MessageInline({ nodes, onOpenFile }: { nodes: MessageInlineNode[]; onOpenFile?: (path: string) => void }) {
  return (
    <>
      {nodes.map((node, position) => {
        switch (node.type) {
          case 'text':
            return <Fragment key={position}>{node.text}</Fragment>
          case 'code':
            return <code key={position} className="message-inline-code" dir="ltr">{node.text}</code>
          case 'link':
            return (
              <a key={position} className="message-link" href={node.href} target="_blank" rel="noreferrer">
                <MessageInline nodes={node.children} onOpenFile={onOpenFile} />
              </a>
            )
          case 'strong':
            return <strong key={position}><MessageInline nodes={node.children} onOpenFile={onOpenFile} /></strong>
          case 'em':
            return <em key={position}><MessageInline nodes={node.children} onOpenFile={onOpenFile} /></em>
          default:
            return <s key={position}><MessageInline nodes={node.children} onOpenFile={onOpenFile} /></s>
        }
      })}
    </>
  )
}

function InlineText({ text, onOpenFile }: { text: string; onOpenFile?: (path: string) => void }) {
  const segments = parseInlineSegments(text)
  if (segments.some((segment) => segment.type === 'link')) {
    return (
      <>
        {segments.map((segment, position) => (segment.type === 'link'
          ? <InlineLink key={position} segment={segment} onOpenFile={onOpenFile} />
          : <Fragment key={position}><MessageInline nodes={parseInline(segment.text)} onOpenFile={onOpenFile} /></Fragment>))}
      </>
    )
  }
  return <MessageInline nodes={parseInline(text)} onOpenFile={onOpenFile} />
}

/** True when prose carries inline Markdown or links the plain path would lose. */
function hasInlineMarkup(text: string): boolean {
  const nodes = parseInline(text)
  if (nodes.length !== 1 || nodes[0].type !== 'text' || nodes[0].text !== text) return true
  return parseInlineSegments(text).some((segment) => segment.type === 'link')
}

function StructuredTable({ header, alignments, rows, onOpenFile }: {
  header: string[]
  alignments: MessageTableAlignment[]
  rows: string[][]
  onOpenFile?: (path: string) => void
}) {
  const align = (column: number) => CELL_ALIGNMENT[alignments[column] ?? 'left']

  return (
    <div className="message-table" role="region" aria-label="Table" tabIndex={0}>
      <table>
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th key={index} scope="col" dir="auto" style={{ textAlign: align(index) }}>
                <InlineText text={cell} onOpenFile={onOpenFile} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index} dir="auto" style={{ textAlign: align(index) }}>
                  <InlineText text={cell} onOpenFile={onOpenFile} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** A single-paragraph item renders inline so tight lists keep their rhythm. */
function StructuredListItem({ blocks, onOpenFile }: {
  blocks: MessageContentBlock[]
  onOpenFile?: (path: string) => void
}) {
  if (blocks.length === 1 && blocks[0].type === 'paragraph') {
    return <li dir="auto"><InlineText text={blocks[0].text} onOpenFile={onOpenFile} /></li>
  }
  return <li dir="auto"><StructuredBlocks blocks={blocks} onOpenFile={onOpenFile} /></li>
}

function StructuredBlocks({ blocks, onOpenFile }: {
  blocks: MessageContentBlock[]
  onOpenFile?: (path: string) => void
}) {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'code':
            return <CodeBlock key={index} code={block.code} language={block.language} />
          case 'heading':
            return createElement(
              HEADING_TAGS[Math.min(6, Math.max(1, block.level)) - 1] ?? 'h6',
              { key: index, className: 'message-heading', dir: 'auto' },
              <InlineText text={block.text} onOpenFile={onOpenFile} />,
            )
          case 'rule':
            return <hr key={index} className="message-rule" />
          case 'quote':
            return (
              <blockquote key={index} className="message-quote">
                <StructuredBlocks blocks={block.blocks} onOpenFile={onOpenFile} />
              </blockquote>
            )
          case 'list': {
            const items = block.items.map((item, position) => (
              <StructuredListItem key={position} blocks={item} onOpenFile={onOpenFile} />
            ))
            return block.ordered
              ? <ol key={index} className="message-list" start={block.start ?? 1}>{items}</ol>
              : <ul key={index} className="message-list">{items}</ul>
          }
          case 'table':
            return (
              <StructuredTable
                key={index}
                header={block.header}
                alignments={block.alignments}
                rows={block.rows}
                onOpenFile={onOpenFile}
              />
            )
          default: {
            if (!hasInlineMarkup(block.text)) {
              return <p key={index} dir="auto">{block.text}</p>
            }
            return <p key={index} dir="auto"><InlineText text={block.text} onOpenFile={onOpenFile} /></p>
          }
        }
      })}
    </>
  )
}

// --- Component ---------------------------------------------------------------

export function MessageContent({ content, collapsible = false, projectPath, onOpenFile }: {
  content: string
  collapsible?: boolean
  projectPath?: string | null
  onOpenFile?: (path: string) => void
}) {
  const richMarkdown = projectPath !== undefined && projectPath !== null
  const blocks = useMemo(() => parseMessageContent(content), [content])
  const markdownBlocks = useMemo(
    () => (richMarkdown ? parseMarkdown(content) : []),
    [content, richMarkdown],
  )
  const [collapsed, setCollapsed] = useState(false)
  const contentId = useId()
  const canCollapse = collapsible && isLongMessageContent(content)
  const isCollapsed = canCollapse && collapsed
  const preview = useMemo(() => {
    if (!canCollapse) return ''
    const plainText = blocks
      .map((block) => {
        if (block.type === 'code') return block.code
        if (block.type === 'paragraph' || block.type === 'heading') return block.text
        return ''
      })
      .join('')
      .trim()
    const characters = Array.from(plainText)
    return characters.length > 540
      ? `${characters.slice(0, 540).join('').trimEnd()}…`
      : plainText
  }, [blocks, canCollapse])

  return (
    <div className="message-content-shell">
      {isCollapsed ? (
        <div id={contentId} className="message-content message-content--preview">
          <p dir="auto">{preview}</p>
        </div>
      ) : (
        <div id={contentId} className="message-content">
          {richMarkdown
            ? renderMarkdownBlocks(markdownBlocks, projectPath)
            : <StructuredBlocks blocks={blocks} onOpenFile={onOpenFile} />}
        </div>
      )}
      {canCollapse && (
        <button
          className="message-collapse-toggle"
          type="button"
          aria-expanded={!isCollapsed}
          aria-controls={contentId}
          onClick={() => setCollapsed((current) => !current)}
        >
          {isCollapsed ? <ChevronDown size={14} /> : <ChevronUp size={14} />}
          {isCollapsed ? 'Expand message' : 'Collapse message'}
        </button>
      )}
    </div>
  )
}
