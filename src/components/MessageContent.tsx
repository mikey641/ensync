import { createElement, Fragment, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { parseMessageContent } from '../lib/messageContent.mjs'
import { parseMarkdown, safeMarkdownHref } from '../lib/markdown.mjs'
import type { MarkdownBlock, MarkdownInline } from '../lib/markdown.mjs'

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

function InlineNodes({ nodes }: { nodes: MarkdownInline[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.type) {
          case 'code':
            return <code key={index} className="message-inline-code">{node.text}</code>
          case 'strong':
            return <strong key={index}><InlineNodes nodes={node.inline} /></strong>
          case 'emphasis':
            return <em key={index}><InlineNodes nodes={node.inline} /></em>
          case 'strike':
            return <del key={index}><InlineNodes nodes={node.inline} /></del>
          case 'link': {
            const href = safeMarkdownHref(node.href)
            if (!href) return <InlineNodes key={index} nodes={node.inline} />
            return (
              <a key={index} href={href} target="_blank" rel="noreferrer noopener">
                <InlineNodes nodes={node.inline} />
              </a>
            )
          }
          default:
            return <Fragment key={index}>{node.text}</Fragment>
        }
      })}
    </>
  )
}

function ListItem({ blocks }: { blocks: MarkdownBlock[] }) {
  // A single-paragraph item renders inline so list rows stay tight.
  if (blocks.length === 1 && blocks[0].type === 'paragraph') {
    return <li dir="auto"><InlineNodes nodes={blocks[0].inline} /></li>
  }
  return <li dir="auto"><Blocks blocks={blocks} /></li>
}

function Blocks({ blocks }: { blocks: MarkdownBlock[] }) {
  return (
    <>
      {blocks.map((block, index) => {
        switch (block.type) {
          case 'heading':
            return createElement(
              `h${Math.min(Math.max(block.level, 1), 6)}`,
              { key: index, dir: 'auto' },
              <InlineNodes nodes={block.inline} />,
            )
          case 'rule':
            return <hr key={index} />
          case 'quote':
            return <blockquote key={index} dir="auto"><Blocks blocks={block.blocks} /></blockquote>
          case 'list':
            return block.ordered
              ? (
                <ol key={index} dir="auto" start={block.start}>
                  {block.items.map((item, itemIndex) => <ListItem key={itemIndex} blocks={item} />)}
                </ol>
              )
              : (
                <ul key={index} dir="auto">
                  {block.items.map((item, itemIndex) => <ListItem key={itemIndex} blocks={item} />)}
                </ul>
              )
          case 'table':
            return (
              <div className="message-table" key={index}>
                <table>
                  <thead>
                    <tr>
                      {block.header.map((cell, cellIndex) => (
                        <th key={cellIndex} dir="auto" style={{ textAlign: block.align[cellIndex] ?? undefined }}>
                          <InlineNodes nodes={cell} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {block.rows.map((row, rowIndex) => (
                      <tr key={rowIndex}>
                        {row.map((cell, cellIndex) => (
                          <td key={cellIndex} dir="auto" style={{ textAlign: block.align[cellIndex] ?? undefined }}>
                            <InlineNodes nodes={cell} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          default:
            return <p key={index} dir="auto"><InlineNodes nodes={block.inline} /></p>
        }
      })}
    </>
  )
}

export function MessageContent({ content }: { content: string }) {
  const blocks = parseMessageContent(content)

  return (
    <div className="message-content">
      {blocks.map((block, index) => block.type === 'code'
        ? <CodeBlock key={index} code={block.code} language={block.language} />
        : <Blocks key={index} blocks={parseMarkdown(block.text)} />)}
    </div>
  )
}
