import { useState, type CSSProperties, type ReactNode } from 'react'
import { Check, Copy } from 'lucide-react'
import { classifyLinkTarget, filePathFromText, parseMarkdown } from '../lib/markdown.mjs'
import type { InlineNode, MarkdownBlock } from '../lib/markdown.mjs'

const HEADING_TAGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'] as const

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

function renderBlocks(blocks: MarkdownBlock[], projectPath: string | null | undefined): ReactNode[] {
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
        return <blockquote key={key} dir="auto">{renderBlocks(block.blocks, projectPath)}</blockquote>
      case 'list': {
        const items = block.items.map((item, itemKey) => (
          <li key={itemKey} dir="auto">
            {renderInline(item.content, projectPath)}
            {item.children.length > 0 && renderBlocks(item.children, projectPath)}
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

export function MessageContent({ content, projectPath }: { content: string; projectPath?: string | null }) {
  return <div className="message-content">{renderBlocks(parseMarkdown(content), projectPath)}</div>
}
