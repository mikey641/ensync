import { useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { parseMessageContent, parseMessageText } from '../lib/messageContent.mjs'

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

function Prose({ text }: { text: string }) {
  return (
    <p dir="auto">
      {parseMessageText(text).map((part, index) => part.type === 'link'
        ? (
            <a key={index} href={part.href} target="_blank" rel="noopener noreferrer">
              {part.text}
            </a>
          )
        : part.text)}
    </p>
  )
}

export function MessageContent({ content }: { content: string }) {
  const blocks = parseMessageContent(content)

  return (
    <div className="message-content">
      {blocks.map((block, index) => block.type === 'code'
        ? <CodeBlock key={index} code={block.code} language={block.language} />
        : <Prose key={index} text={block.text} />)}
    </div>
  )
}
