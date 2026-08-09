function displayTimeZone(requestedTimeZone) {
  const timeZone = typeof requestedTimeZone === 'string' && requestedTimeZone.trim()
    ? requestedTimeZone.trim()
    : new Intl.DateTimeFormat().resolvedOptions().timeZone

  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(0)
    return timeZone
  } catch {
    return 'UTC'
  }
}

function absoluteResetLabel(value, requestedTimeZone) {
  const resetAt = new Date(value)
  if (Number.isNaN(resetAt.getTime())) return null

  const timeZone = displayTimeZone(requestedTimeZone)
  const date = new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    timeZone,
  }).format(resetAt)
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone,
  }).format(resetAt).replace(/\s/g, '').toLowerCase()

  return `${date} at ${time} (${timeZone})`
}

export function providerResetText(provider, timeZone) {
  const resetWindow = typeof provider?.resetWindow === 'string' && provider.resetWindow.trim()
    ? provider.resetWindow.trim()
    : null

  if (provider?.resetsIn) {
    const resetLabel = absoluteResetLabel(provider.resetsIn, timeZone)
    if (resetLabel) return resetWindow ? `${resetWindow} resets ${resetLabel}` : resetLabel
  }

  if (typeof provider?.resetLabel === 'string' && provider.resetLabel.trim()) {
    const resetLabel = provider.resetLabel.trim()
    return resetWindow ? `${resetWindow} resets ${resetLabel}` : resetLabel
  }

  return null
}
