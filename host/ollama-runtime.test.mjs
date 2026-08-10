import assert from 'node:assert/strict'
import test from 'node:test'
import {
  OLLAMA_DEFAULT_ENDPOINT,
  describeOllamaPreflight,
  ollamaEndpoint,
  ollamaModelInstalled,
  parseOllamaModelInventory,
  parseOllamaRuntimeProbe,
  preflightOllamaRuntime,
} from './ollama-runtime.mjs'

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

// ---------------------------------------------------------------------------
// Preflight — server reachability and model inventory
//
// Fixtures match live captures against ollama 0.13.5 on 2026-08-11.
// ---------------------------------------------------------------------------

const json = (body, ok = true) => ({ ok, json: async () => body })

function fakeFetch(routes) {
  const calls = []
  return {
    calls,
    fetch: async (url) => {
      calls.push(url)
      for (const [suffix, response] of Object.entries(routes)) {
        if (url.endsWith(suffix)) {
          if (response instanceof Error) throw response
          return response
        }
      }
      throw new Error(`unexpected request: ${url}`)
    },
  }
}

test('Ollama endpoint honours OLLAMA_HOST in both bare and URL spellings', () => {
  assert.equal(ollamaEndpoint({}), OLLAMA_DEFAULT_ENDPOINT)
  assert.equal(ollamaEndpoint({ OLLAMA_HOST: '192.168.1.5:11434' }), 'http://192.168.1.5:11434')
  assert.equal(ollamaEndpoint({ OLLAMA_HOST: 'https://models.example.com' }), 'https://models.example.com')
  assert.equal(ollamaEndpoint({ OLLAMA_HOST: '   ' }), OLLAMA_DEFAULT_ENDPOINT)
})

test('Ollama model inventory is read from the verified /api/tags shape', () => {
  assert.deepEqual(parseOllamaModelInventory({ models: [{ name: 'qwen3:8b' }, { name: 'llama3.2:latest' }] }), ['qwen3:8b', 'llama3.2:latest'])
  // The live capture on a fresh install.
  assert.deepEqual(parseOllamaModelInventory({ models: [] }), [])
  assert.equal(parseOllamaModelInventory({}), null)
  assert.equal(parseOllamaModelInventory(null), null)
})

test('a bare model name matches its :latest tag', () => {
  assert.equal(ollamaModelInstalled(['llama3.2:latest'], 'llama3.2'), true)
  assert.equal(ollamaModelInstalled(['llama3.2:latest'], 'llama3.2:latest'), true)
  assert.equal(ollamaModelInstalled(['llama3.2:latest'], 'llama3.2:8b'), false)
  assert.equal(ollamaModelInstalled([], 'llama3.2'), false)
})

test('an unreachable server is reported with the address and how to start it', () => {
  const failure = describeOllamaPreflight({ reachable: false, endpoint: 'http://127.0.0.1:11434' })
  assert.equal(failure.code, 'ollama_server_unreachable')
  assert.equal(failure.status, 503)
  assert.equal(failure.safeToRetry, true)
  assert.match(failure.message, /http:\/\/127\.0\.0\.1:11434/)
  assert.match(failure.message, /ollama serve/)
})

test('an empty model inventory is refused without offering to download anything', () => {
  const failure = describeOllamaPreflight({ reachable: true, endpoint: OLLAMA_DEFAULT_ENDPOINT, installedModels: [] })
  assert.equal(failure.code, 'ollama_no_models_installed')
  assert.match(failure.message, /ollama pull/)
  assert.match(failure.message, /never downloads models on your behalf/)
})

test('a missing model names the pull command and lists what is installed', () => {
  const failure = describeOllamaPreflight({
    reachable: true,
    endpoint: OLLAMA_DEFAULT_ENDPOINT,
    installedModels: ['qwen3:8b'],
    requestedModel: 'llama3.2',
  })
  assert.equal(failure.code, 'ollama_model_missing')
  assert.equal(failure.status, 409)
  assert.match(failure.message, /ollama pull llama3\.2/)
  assert.match(failure.message, /Installed: qwen3:8b/)
})

test('an unreadable inventory is honest rather than assumed empty', () => {
  const failure = describeOllamaPreflight({ reachable: true, installedModels: null })
  assert.equal(failure.code, 'ollama_inventory_unreadable')
})

test('a ready runtime reports no failure', () => {
  assert.equal(describeOllamaPreflight({
    reachable: true,
    installedModels: ['qwen3:8b'],
    requestedModel: 'qwen3:8b',
  }), null)
})

test('preflight reports an unreachable server without asking for the inventory', async () => {
  const { fetch, calls } = fakeFetch({ '/api/version': new Error('ECONNREFUSED') })
  const preflight = await preflightOllamaRuntime({ endpoint: 'http://127.0.0.1:59999', fetch })
  assert.equal(preflight.reachable, false)
  assert.equal(preflight.failure.code, 'ollama_server_unreachable')
  // A dead server is not asked a second question.
  assert.deepEqual(calls, ['http://127.0.0.1:59999/api/version'])
})

test('preflight reads liveness and inventory from the verified endpoints', async () => {
  const { fetch, calls } = fakeFetch({
    '/api/version': json({ version: '0.13.5' }),
    '/api/tags': json({ models: [{ name: 'qwen3:8b' }] }),
  })
  const preflight = await preflightOllamaRuntime({ endpoint: OLLAMA_DEFAULT_ENDPOINT, fetch, model: 'qwen3:8b' })
  assert.equal(preflight.reachable, true)
  assert.equal(preflight.version, '0.13.5')
  assert.deepEqual(preflight.installedModels, ['qwen3:8b'])
  assert.equal(preflight.failure, null)
  assert.deepEqual(calls, [
    `${OLLAMA_DEFAULT_ENDPOINT}/api/version`,
    `${OLLAMA_DEFAULT_ENDPOINT}/api/tags`,
  ])
})

test('preflight never requests a generation endpoint, which would risk a pull', async () => {
  const { fetch, calls } = fakeFetch({
    '/api/version': json({ version: '0.13.5' }),
    '/api/tags': json({ models: [] }),
  })
  const preflight = await preflightOllamaRuntime({ endpoint: OLLAMA_DEFAULT_ENDPOINT, fetch, model: 'llama3.2' })
  assert.equal(preflight.failure.code, 'ollama_no_models_installed')
  assert.ok(calls.every((url) => !url.includes('/api/generate') && !url.includes('/api/chat')))
})

test('preflight treats a non-OK liveness response as unreachable', async () => {
  const { fetch } = fakeFetch({ '/api/version': json({}, false) })
  const preflight = await preflightOllamaRuntime({ endpoint: OLLAMA_DEFAULT_ENDPOINT, fetch })
  assert.equal(preflight.reachable, false)
  assert.equal(preflight.failure.code, 'ollama_server_unreachable')
})

test('preflight reports a live server whose inventory call fails as unreadable', async () => {
  const { fetch } = fakeFetch({
    '/api/version': json({ version: '0.13.5' }),
    '/api/tags': new Error('socket hang up'),
  })
  const preflight = await preflightOllamaRuntime({ endpoint: OLLAMA_DEFAULT_ENDPOINT, fetch })
  assert.equal(preflight.reachable, true)
  assert.equal(preflight.failure.code, 'ollama_inventory_unreadable')
})
