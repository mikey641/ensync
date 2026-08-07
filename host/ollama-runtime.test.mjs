import assert from 'node:assert/strict'
import test from 'node:test'
import { parseOllamaRuntimeProbe } from './ollama-runtime.mjs'

const result = (stdout, overrides = {}) => ({
  exitCode: 0,
  stdout,
  stderr: '',
  timedOut: false,
  error: null,
  ...overrides,
})

test('Ollama runtime parser reports exact installed and loaded model counts', () => {
  const probe = parseOllamaRuntimeProbe(
    result('NAME             ID              SIZE      MODIFIED\nqwen3:8b         abc123          5.2 GB    2 days ago\nllama3.2:latest  def456          2.0 GB    1 week ago'),
    result('NAME      ID       SIZE      PROCESSOR    CONTEXT    UNTIL\nqwen3:8b  abc123   5.2 GB    100% GPU     4096       3 minutes'),
    '2026-08-06T00:00:00.000Z',
  )

  assert.equal(probe.usage.kind, 'local_runtime')
  assert.equal(probe.usage.source, 'cli')
  assert.equal(probe.usage.usedPercent, null)
  assert.deepEqual(probe.usage.details, [
    { label: 'Installed models', value: '2' },
    { label: 'Loaded models', value: '1' },
  ])
  assert.deepEqual(probe.models.map((model) => model.id), ['qwen3:8b', 'llama3.2:latest'])
})

test('Ollama runtime parser preserves exact zero counts', () => {
  const probe = parseOllamaRuntimeProbe(
    result('NAME    ID    SIZE    MODIFIED'),
    result('NAME    ID    SIZE    PROCESSOR    CONTEXT    UNTIL'),
  )

  assert.deepEqual(probe.usage.details, [
    { label: 'Installed models', value: '0' },
    { label: 'Loaded models', value: '0' },
  ])
  assert.deepEqual(probe.models, [])
  assert.match(probe.usage.reason, /0 installed models/)
})

test('Ollama runtime parser does not invent state when both commands fail', () => {
  assert.equal(parseOllamaRuntimeProbe(
    result('', { exitCode: 1 }),
    result('', { timedOut: true }),
  ), null)
})
