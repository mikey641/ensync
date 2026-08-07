import assert from 'node:assert/strict'
import test from 'node:test'
import { readNdjsonStream } from '../src/lib/ndjsonStream.mjs'

function bodyFromChunks(chunks) {
  const encoder = new TextEncoder()
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      controller.close()
    },
  })
}

test('browser NDJSON parser preserves values across arbitrary transport chunk boundaries', async () => {
  const values = []
  await readNdjsonStream(
    bodyFromChunks(['{"type":"sta', 'rted"}\n{"type":', '"output","text":"one\\ntwo"}\n']),
    (value) => values.push(value),
  )
  assert.deepEqual(values, [
    { type: 'started' },
    { type: 'output', text: 'one\ntwo' },
  ])
})

test('browser NDJSON parser rejects malformed and oversized events', async () => {
  await assert.rejects(
    readNdjsonStream(bodyFromChunks(['{"broken"\n']), () => {}),
    (error) => error instanceof SyntaxError,
  )
  await assert.rejects(
    readNdjsonStream(bodyFromChunks(['{"text":"too long"}']), () => {}, { maxLineLength: 8 }),
    (error) => error instanceof RangeError,
  )
})
