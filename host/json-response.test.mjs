import assert from 'node:assert/strict'
import test from 'node:test'

import {
  InvalidJsonResponseError,
  readJsonResponse,
} from '../src/lib/jsonResponse.mjs'

test('Host JSON responses decode without changing valid payloads', async () => {
  const payload = await readJsonResponse(new Response(JSON.stringify({ ok: true, value: 3 }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  }))

  assert.deepEqual(payload, { ok: true, value: 3 })
})

test('plain-text Host failures become bounded typed errors without leaking the body', async () => {
  const responseBody = 'Ensync Host returned a malformed execution event.'

  await assert.rejects(
    readJsonResponse(new Response(responseBody, { status: 502 })),
    (error) =>
      error instanceof InvalidJsonResponseError
      && error.code === 'invalid_json_response'
      && error.status === 502
      && !error.message.includes(responseBody),
  )
})
