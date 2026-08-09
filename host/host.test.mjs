import assert from 'node:assert/strict'
import { once } from 'node:events'
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { findExecutable, subscriptionEnvironment } from './command.mjs'
import {
  getProviderDefinition,
  getProviderCatalog,
  parseClaudeAuthentication,
  parseCodexAuthentication,
  parseCursorAuthentication,
  parseKiroAuthentication,
} from './providers.mjs'
import { createRelayHost } from './server.mjs'

test('subscription environment removes model API keys without removing PATH', () => {
  const env = subscriptionEnvironment({
    PATH: '/bin',
    OPENAI_API_KEY: 'secret',
    ANTHROPIC_API_KEY: 'secret',
    ANTHROPIC_BASE_URL: 'https://paid-gateway.example',
    COPILOT_PROVIDER_API_KEY: 'secret',
    COPILOT_PROVIDER_BASE_URL: 'https://paid-provider.example',
    CURSOR_API_KEY: 'secret',
    KIRO_API_KEY: 'secret',
    JUNIE_API_KEY: 'secret',
    JUNIE_ANTHROPIC_API_KEY: 'secret',
    KIMI_MODEL_NAME: 'paid-override',
    KIMI_MODEL_API_KEY: 'secret',
    KIMI_CODE_BASE_URL: 'https://paid-gateway.example',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/paid-cloud.json',
    QODER_PERSONAL_ACCESS_TOKEN: 'secret',
    CODEBUDDY_API_KEY: 'secret',
    FACTORY_API_KEY: 'secret',
    AMP_API_KEY: 'secret',
    WARP_API_KEY: 'secret',
    RELAY_SAFE_VALUE: 'kept',
  })

  assert.equal(env.PATH, '/bin')
  assert.equal(env.RELAY_SAFE_VALUE, 'kept')
  assert.equal(env.OPENAI_API_KEY, undefined)
  assert.equal(env.ANTHROPIC_API_KEY, undefined)
  assert.equal(env.ANTHROPIC_BASE_URL, undefined)
  assert.equal(env.COPILOT_PROVIDER_API_KEY, undefined)
  assert.equal(env.COPILOT_PROVIDER_BASE_URL, undefined)
  assert.equal(env.CURSOR_API_KEY, undefined)
  assert.equal(env.KIRO_API_KEY, undefined)
  assert.equal(env.JUNIE_API_KEY, undefined)
  assert.equal(env.JUNIE_ANTHROPIC_API_KEY, undefined)
  assert.equal(env.KIMI_MODEL_NAME, undefined)
  assert.equal(env.KIMI_MODEL_API_KEY, undefined)
  assert.equal(env.KIMI_CODE_BASE_URL, undefined)
  assert.equal(env.GOOGLE_APPLICATION_CREDENTIALS, undefined)
  assert.equal(env.QODER_PERSONAL_ACCESS_TOKEN, undefined)
  assert.equal(env.CODEBUDDY_API_KEY, undefined)
  assert.equal(env.FACTORY_API_KEY, undefined)
  assert.equal(env.AMP_API_KEY, undefined)
  assert.equal(env.WARP_API_KEY, undefined)
})

test('provider discovery checks user CLI directories when the app PATH is sparse', async (context) => {
  const homeDirectory = await mkdtemp(join(tmpdir(), 'ensync-cli-home-'))
  context.after(() => rm(homeDirectory, { recursive: true, force: true }))
  const binDirectory = join(homeDirectory, '.local', 'bin')
  const fileName = process.platform === 'win32' ? 'ensync-test-cli.CMD' : 'ensync-test-cli'
  const executable = join(binDirectory, fileName)
  await mkdir(binDirectory, { recursive: true })
  await writeFile(executable, process.platform === 'win32' ? '@exit /b 0\r\n' : '#!/bin/sh\nexit 0\n')
  if (process.platform !== 'win32') await chmod(executable, 0o755)

  assert.equal(await findExecutable('ensync-test-cli', {
    env: { PATH: '', PATHEXT: '.EXE;.CMD;.BAT;.COM' },
    homeDirectory,
    platform: process.platform,
  }), executable)
})

test('auth parsers only accept explicit CLI authentication signals', () => {
  const baseResult = { exitCode: 0, stderr: '', timedOut: false, error: null }
  assert.equal(
    parseCodexAuthentication({ ...baseResult, stdout: 'Logged in using ChatGPT' }).state,
    'authenticated',
  )
  assert.equal(
    parseClaudeAuthentication({
      ...baseResult,
      stdout: JSON.stringify({ loggedIn: false, authMethod: 'none' }),
    }).state,
    'not_authenticated',
  )
  assert.equal(
    parseCursorAuthentication({ ...baseResult, stdout: 'Cursor Agent is available' }).state,
    'unavailable',
  )
  assert.equal(
    parseKiroAuthentication({ ...baseResult, stdout: JSON.stringify({ email: 'user@example.com' }) }).state,
    'authenticated',
  )
  assert.equal(
    parseKiroAuthentication({ ...baseResult, exitCode: 1, stdout: 'Not logged in' }).state,
    'not_authenticated',
  )
  assert.equal(
    parseKiroAuthentication({ ...baseResult, exitCode: 1, stdout: JSON.stringify({ account: null }) }).state,
    'not_authenticated',
  )
})

test('catalog login definitions stay provider-specific', () => {
  assert.deepEqual(getProviderDefinition('claude').loginArgs, ['auth', 'login'])
  assert.deepEqual(getProviderDefinition('codex').loginArgs, ['login'])
  assert.deepEqual(getProviderDefinition('kimi').loginArgs, ['login'])
  assert.deepEqual(getProviderDefinition('antigravity').loginArgs, [])
  assert.deepEqual(getProviderDefinition('jules').loginArgs, ['login'])
  assert.deepEqual(getProviderDefinition('copilot').loginArgs, [])
  assert.deepEqual(getProviderDefinition('cursor').loginArgs, ['login'])
  assert.deepEqual(getProviderDefinition('kiro').loginArgs, ['login'])
  assert.deepEqual(getProviderDefinition('qoder').loginArgs, ['login'])
  assert.deepEqual(getProviderDefinition('codebuddy').loginArgs, [])
  assert.deepEqual(getProviderDefinition('droid').loginArgs, [])
  assert.deepEqual(getProviderDefinition('auggie').loginArgs, ['login'])
  assert.deepEqual(getProviderDefinition('amp').loginArgs, ['login'])
  assert.equal(getProviderDefinition('gitlab_duo').loginArgs, null)
  assert.deepEqual(getProviderDefinition('oz').loginArgs, ['login'])
  assert.deepEqual(getProviderDefinition('junie').loginArgs, [])
  assert.equal(getProviderDefinition('ollama').loginArgs, null)
  assert.equal(getProviderDefinition('gemini'), null)
  assert.equal(getProviderDefinition('aider'), null)
})

test('catalog update definitions cover every verified provider-owned command', () => {
  const commands = {
    codex: ['update'],
    claude: ['update'],
    copilot: ['update'],
    cursor: ['update'],
    kimi: ['upgrade'],
    droid: ['update'],
    amp: ['update'],
    auggie: ['upgrade'],
    qoder: ['update'],
    codebuddy: ['update'],
  }
  for (const [providerId, args] of Object.entries(commands)) {
    assert.deepEqual(getProviderDefinition(providerId).updateArgs, args)
  }
  for (const provider of getProviderCatalog()) {
    if (provider.id in commands) continue
    assert.equal(getProviderDefinition(provider.id).updateArgs, undefined)
  }
  for (const providerId of ['antigravity', 'kiro', 'junie']) {
    assert.equal(getProviderDefinition(providerId).updateStrategy, 'provider_automatic')
  }
})

test('Copilot account verification is separate from its discovery-only Ensync runner', () => {
  const copilot = getProviderCatalog().find((provider) => provider.id === 'copilot')
  const definition = getProviderDefinition('copilot')

  assert.equal(copilot?.routeKind, 'subscription')
  assert.equal(copilot?.chatExecution, 'discovery_only')
  assert.equal(copilot?.setupKind, 'interactive_onboarding')
  assert.equal(definition?.usageKind, 'unavailable')
  assert.deepEqual(definition?.loginArgs, [])
  assert.match(copilot?.catalogReason ?? '', /Account verification is supported/)
  assert.match(copilot?.catalogReason ?? '', /task execution and automatic fallback are not enabled/)
})

test('host returns real provider states and never invents usage numbers', async (context) => {
  const server = createRelayHost()
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())

  const address = server.address()
  assert.equal(typeof address, 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`

  const health = await fetch(`${baseUrl}/api/health`).then((response) => response.json())
  assert.equal(health.ok, true)

  const payload = await fetch(`${baseUrl}/api/providers?refresh=1`).then((response) => response.json())
  assert.deepEqual(payload.providers.map((provider) => provider.id), [
    'codex',
    'claude',
    'copilot',
    'cursor',
    'antigravity',
    'jules',
    'kimi',
    'kiro',
    'junie',
    'gitlab_duo',
    'oz',
    'droid',
    'amp',
    'auggie',
    'qoder',
    'codebuddy',
    'ollama',
  ])

  for (const provider of payload.providers) {
    assert.equal(provider.installed, provider.executable !== null)
    if (provider.usage.usedPercent === null) {
      assert.equal(provider.usage.remainingPercent, null)
      assert.equal(provider.usage.resetAt, null)
    } else {
      assert.equal(provider.usage.source, 'cli')
      assert.equal(provider.usage.usedPercent >= 0 && provider.usage.usedPercent <= 100, true)
      assert.equal(provider.usage.remainingPercent, 100 - provider.usage.usedPercent)
    }
    assert.ok(provider.usage.reason)
    assert.ok(['subscription_quota', 'session_only', 'local_runtime', 'unavailable'].includes(provider.usage.kind))
    assert.ok(Array.isArray(provider.usage.details))
    assert.ok(Array.isArray(provider.availableModels))
    assert.ok(['subscription', 'local'].includes(provider.routeKind))
    assert.ok(['supported', 'discovery_only'].includes(provider.chatExecution))
    assert.equal(provider.canUpdate, provider.installed && Array.isArray(getProviderDefinition(provider.id)?.updateArgs))
    assert.ok(['ensync_command', 'provider_automatic', 'official_guide'].includes(provider.updateStrategy))
    assert.equal(typeof provider.updateReason, 'string')
  }

  assert.deepEqual(
    payload.providers.filter((provider) => provider.chatExecution === 'supported').map((provider) => provider.id),
    ['codex', 'claude'],
  )

  const usage = await fetch(`${baseUrl}/api/usage`).then((response) => response.json())
  assert.equal(usage.providers.length, 17)
  assert.equal(usage.providers.every((provider) => provider.usedPercent === null || provider.source === 'cli'), true)
})
