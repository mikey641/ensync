import { Fragment, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { parseInlineSegments, parseMessageContent } from '../lib/messageContent.mjs'
import type { MessageInlineLink } from '../lib/messageContent.mjs'

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

function InlineLink({ segment, onOpenFile }: {
  segment: MessageInlineLink
  onOpenFile?: (path: string) => void
}) {
  if (segment.kind === 'file') {
    // A local path cannot navigate the workspace origin. Ensync displays the
    // file itself, and falls back to the native shell only where no viewer is
    // wired up. Browser mode without either keeps the plain file href.
    const openFile = (event: React.MouseEvent<HTMLAnchorElement>) => {
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

function InlineText({ text, onOpenFile }: { text: string; onOpenFile?: (path: string) => void }) {
  return (
    <>
      {parseInlineSegments(text).map((segment, position) => (segment.type === 'link'
        ? <InlineLink key={position} segment={segment} onOpenFile={onOpenFile} />
        : <Fragment key={position}>{segment.text}</Fragment>))}
    </>
  )
}

export function MessageContent({ content, onOpenFile }: {
  content: string
  onOpenFile?: (path: string) => void
}) {
  const blocks = parseMessageContent(content)

  return (
    <div className="message-content">
      {blocks.map((block, index) => block.type === 'code'
        ? <CodeBlock key={index} code={block.code} language={block.language} />
        : <p key={index} dir="auto"><InlineText text={block.text} onOpenFile={onOpenFile} /></p>)}
    </div>
  )
}
