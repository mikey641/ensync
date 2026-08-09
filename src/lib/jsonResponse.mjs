export class InvalidJsonResponseError extends SyntaxError {
  constructor(status) {
    super('The Host response was not valid JSON.')
    this.name = 'InvalidJsonResponseError'
    this.code = 'invalid_json_response'
    this.status = Number.isInteger(status) ? status : null
  }
}

/**
 * Decode a Host JSON response without leaking its untrusted body through the
 * native JSON.parse error. Callers decide whether the ambiguous operation may
 * be retried; this helper only proves that the response framing was invalid.
 */
export async function readJsonResponse(response) {
  if (!response || typeof response.text !== 'function') {
    throw new TypeError('A fetch response is required.')
  }

  const body = await response.text()
  try {
    return JSON.parse(body)
  } catch {
    throw new InvalidJsonResponseError(response.status)
  }
}
