import { useEffect, useMemo, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import { parseMessageContent, parseMessageText } from '../lib/messageContent.mjs'

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]/i

function isLocalImagePath(path: string) {
  const value = path.trim()
  if (!value || value.startsWith('//') || value.startsWith('#')) return false
  if (WINDOWS_ABSOLUTE_PATH.test(value) || value.startsWith('\\\\')) return true
  if (!URL_SCHEME.test(value)) return true
  return value.toLowerCase().startsWith('file:')
}

function localImageUrl(workspacePath: string, imagePath: string) {
  const search = new URLSearchParams({ workspacePath, path: imagePath })
  return `/api/chat/image?${search}`
}

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

function LocalMarkdownImage({
  alt,
  path,
  markdown,
  workspacePath,
}: {
  alt: string
  path: string
  markdown: string
  workspacePath: string | null
}) {
  const source = useMemo(
    () => workspacePath && isLocalImagePath(path) ? localImageUrl(workspacePath, path) : null,
    [path, workspacePath],
  )
  const [failed, setFailed] = useState(false)
  useEffect(() => setFailed(false), [source])

  if (!source) return <p dir="auto">{markdown}</p>
  if (failed) {
    return (
      <div className="message-local-image message-local-image--unavailable" role="status">
        <strong>{alt || 'Local image'}</strong>
        <span>The file is missing, unsupported, or outside this conversation workspace.</span>
      </div>
    )
  }
  return (
    <figure className="message-local-image">
      <img src={source} alt={alt} loading="lazy" decoding="async" onError={() => setFailed(true)} />
    </figure>
  )
}

export function MessageContent({ content, workspacePath = null }: { content: string; workspacePath?: string | null }) {
  const blocks = parseMessageContent(content)

  return (
    <div className="message-content">
      {blocks.map((block, index) => block.type === 'code'
        ? <CodeBlock key={index} code={block.code} language={block.language} />
        : block.type === 'image'
          ? <LocalMarkdownImage key={index} {...block} workspacePath={workspacePath} />
          : <p key={index} dir="auto">{block.text}</p>)}
    </div>
  )
}
