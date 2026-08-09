import { Fragment, createElement, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { parseInline, parseMessageContent } from '../lib/messageContent.mjs'
import type { MessageContentBlock, MessageInlineNode, MessageTableAlignment } from '../lib/messageContent.mjs'

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

function InlineNode({ node }: { node: MessageInlineNode }) {
  if (node.type === 'text') return <>{node.text}</>
  if (node.type === 'code') return <code className="message-inline-code">{node.text}</code>
  if (node.type === 'link') {
    return (
      <a className="message-link" href={node.href} target="_blank" rel="noreferrer noopener">
        <Inline nodes={node.children} />
      </a>
    )
  }
  if (node.type === 'strong') return <strong><Inline nodes={node.children} /></strong>
  if (node.type === 'em') return <em><Inline nodes={node.children} /></em>
  return <s><Inline nodes={node.children} /></s>
}

function Inline({ nodes }: { nodes: MessageInlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => <InlineNode key={index} node={node} />)}
    </>
  )
}

function InlineText({ text }: { text: string }) {
  return <Inline nodes={parseInline(text)} />
}

function TableBlock({ header, alignments, rows }: {
  header: string[]
  alignments: MessageTableAlignment[]
  rows: string[][]
}) {
  const align = (column: number) => CELL_ALIGNMENT[alignments[column] ?? 'left']

  return (
    <div className="message-table" role="region" aria-label="Table" tabIndex={0}>
      <table>
        <thead>
          <tr>
            {header.map((cell, index) => (
              <th key={index} scope="col" dir="auto" style={{ textAlign: align(index) }}>
                <InlineText text={cell} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, index) => (
                <td key={index} dir="auto" style={{ textAlign: align(index) }}>
                  <InlineText text={cell} />
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
function ListItem({ blocks }: { blocks: MessageContentBlock[] }) {
  if (blocks.length === 1 && blocks[0].type === 'paragraph') {
    return <li dir="auto"><InlineText text={blocks[0].text} /></li>
  }
  return <li dir="auto"><Blocks blocks={blocks} /></li>
}

function Block({ block }: { block: MessageContentBlock }) {
  if (block.type === 'code') return <CodeBlock code={block.code} language={block.language} />
  if (block.type === 'table') {
    return <TableBlock header={block.header} alignments={block.alignments} rows={block.rows} />
  }
  if (block.type === 'heading') {
    return createElement(
      `h${Math.min(6, Math.max(1, block.level))}`,
      { className: 'message-heading', dir: 'auto' },
      <InlineText text={block.text} />,
    )
  }
  if (block.type === 'rule') return <hr className="message-rule" />
  if (block.type === 'quote') {
    return <blockquote className="message-quote"><Blocks blocks={block.blocks} /></blockquote>
  }
  if (block.type === 'list') {
    return block.ordered
      ? (
        <ol className="message-list" start={block.start ?? 1}>
          {block.items.map((item, index) => <ListItem key={index} blocks={item} />)}
        </ol>
      )
      : (
        <ul className="message-list">
          {block.items.map((item, index) => <ListItem key={index} blocks={item} />)}
        </ul>
      )
  }
  return <p dir="auto"><InlineText text={block.text} /></p>
}

function Blocks({ blocks }: { blocks: MessageContentBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => <Fragment key={index}><Block block={block} /></Fragment>)}
    </>
  )
}

export function MessageContent({ content }: { content: string }) {
  return (
    <div className="message-content">
      <Blocks blocks={parseMessageContent(content)} />
    </div>
  )
}
