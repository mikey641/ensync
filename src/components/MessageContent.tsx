import { useId, useMemo, useState } from 'react'
import { Check, ChevronDown, ChevronUp, Copy } from 'lucide-react'
import { isLongMessageContent, parseMessageContent } from '../lib/messageContent.mjs'
import './MessageContent.css'

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

export function MessageContent({ content, collapsible = false }: { content: string; collapsible?: boolean }) {
  const blocks = useMemo(() => parseMessageContent(content), [content])
  const [collapsed, setCollapsed] = useState(false)
  const contentId = useId()
  const canCollapse = collapsible && isLongMessageContent(content)
  const isCollapsed = canCollapse && collapsed
  const preview = useMemo(() => {
    if (!canCollapse) return ''
    const plainText = blocks
      .map((block) => block.type === 'code' ? block.code : block.text)
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
          {blocks.map((block, index) => block.type === 'code'
            ? <CodeBlock key={index} code={block.code} language={block.language} />
            : <p key={index} dir="auto">{block.text}</p>)}
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
