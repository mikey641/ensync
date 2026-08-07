function continuationHeading(line) {
  return /^#{1,6}[ \t]+Ensync continuation[ \t]*:?[ \t]*$/i.test(line)
}

function fenceMarker(line) {
  const match = line.match(/^[ \t]{0,3}(`{3,}|~{3,})/)
  return match?.[1] ?? null
}

/**
 * Removes Ensync's final provider-handoff section from user-visible response text.
 * The extracted body is retained separately so another provider can receive it.
 */
export function extractEnsyncContinuation(response) {
  if (typeof response !== 'string' || !response) {
    return { visibleResponse: response ?? '', semanticSummary: null }
  }

  const normalizedResponse = response.replace(/\r\n/g, '\n')
  const lines = normalizedResponse.split('\n')
  let offset = 0
  let activeFence = null
  let headingOffset = null
  let headingLength = 0

  for (const line of lines) {
    const marker = fenceMarker(line)
    if (marker) {
      if (!activeFence) activeFence = marker[0]
      else if (marker[0] === activeFence) activeFence = null
    } else if (!activeFence && continuationHeading(line)) {
      headingOffset = offset
      headingLength = line.length
    }
    offset += line.length + 1
  }

  if (headingOffset === null) {
    return { visibleResponse: response, semanticSummary: null }
  }

  const summaryStart = headingOffset + headingLength
  return {
    visibleResponse: normalizedResponse.slice(0, headingOffset).trimEnd(),
    semanticSummary: normalizedResponse.slice(summaryStart).trim(),
  }
}
