function openingFence(line) {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/)
  if (!match) return null

  const marker = match[1]
  const info = match[2].trim()
  if (marker[0] === '`' && info.includes('`')) return null

  return {
    character: marker[0],
    length: marker.length,
    language: info.split(/\s+/, 1)[0]?.slice(0, 64) || null,
  }
}

function closesFence(line, fence) {
  const match = line.match(/^ {0,3}(`+|~+)\s*$/)
  return Boolean(
    match
    && match[1][0] === fence.character
    && match[1].length >= fence.length,
  )
}

function appendTextBlock(blocks, text) {
  if (!text) return
  const previous = blocks.at(-1)
  if (previous?.type === 'text') {
    previous.text += text
  } else {
    blocks.push({ type: 'text', text })
  }
}

/**
 * Splits message Markdown into ordered prose and fenced-code blocks. The text
 * itself is never interpreted as HTML, and non-fence Markdown remains exact.
 */
export function parseMessageContent(value) {
  const content = typeof value === 'string' ? value : String(value ?? '')
  if (!content) return []

  const lines = content.match(/.*(?:\r\n|\n|\r|$)/g)?.filter(Boolean) ?? []
  const blocks = []
  let text = ''
  let code = ''
  let fence = null

  for (const lineWithEnding of lines) {
    const line = lineWithEnding.replace(/(?:\r\n|\n|\r)$/, '')
    if (!fence) {
      const candidate = openingFence(line)
      if (!candidate) {
        text += lineWithEnding
        continue
      }

      appendTextBlock(blocks, text)
      text = ''
      code = ''
      fence = candidate
      continue
    }

    if (closesFence(line, fence)) {
      blocks.push({ type: 'code', code, language: fence.language })
      code = ''
      fence = null
    } else {
      code += lineWithEnding
    }
  }

  if (fence) {
    blocks.push({ type: 'code', code, language: fence.language })
  } else {
    appendTextBlock(blocks, text)
  }

  return blocks
}
