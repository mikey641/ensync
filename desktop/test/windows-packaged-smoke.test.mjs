import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  findNamedFile,
  HOST_DAEMON_STATE_FILENAME,
  parseDevToolsActivePort,
  runWindowsPackagedSmoke,
  selectEnsyncPageTarget,
  validateHostDescriptor,
  validateHostHealth,
} from '../scripts/smoke-windows-package.mjs'

test('packaged Windows smoke helpers accept only an Ensync page and authenticated Host identity', () => {
  assert.equal(parseDevToolsActivePort('43121\n/devtools/browser/example\n'), 43_121)
  assert.equal(parseDevToolsActivePort('0\n'), null)
  assert.equal(parseDevToolsActivePort('not-a-port\n'), null)

  const target = selectEnsyncPageTarget([
    { type: 'page', url: 'https://example.com/' },
    { type: 'worker', url: 'ensync://app/' },
    { type: 'page', url: 'ensync://app/', title: 'Ensync' },
  ])
  assert.deepEqual(target, { type: 'page', url: 'ensync://app/', title: 'Ensync' })
  assert.equal(selectEnsyncPageTarget([{ type: 'page', url: 'ensync://other/' }]), null)

  const descriptor = validateHostDescriptor({
    version: 1,
    apiVersion: 1,
    pid: 123,
    port: 43_121,
    token: 'a'.repeat(64),
    instanceId: 'host-instance',
  })
  assert.ok(descriptor)
  assert.equal(validateHostDescriptor({ ...descriptor, token: 'public' }), null)
  assert.equal(validateHostHealth({
    ok: true,
    service: 'ensync-host',
    apiVersion: 1,
    instanceId: 'host-instance',
  }, descriptor), true)
  assert.equal(validateHostHealth({
    ok: true,
    service: 'ensync-host',
    apiVersion: 1,
    instanceId: 'another-host',
  }, descriptor), false)
})

test('packaged Windows smoke finds the daemon descriptor only inside its isolated profile', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-windows-smoke-test-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const nested = join(directory, 'AppData', 'Roaming', 'Ensync')
  await mkdir(nested, { recursive: true })
  const expected = join(nested, HOST_DAEMON_STATE_FILENAME)
  await writeFile(expected, '{}')

  assert.equal(await findNamedFile(directory, HOST_DAEMON_STATE_FILENAME), expected)
  assert.equal(await findNamedFile(directory, 'missing.json'), null)
  assert.equal(await findNamedFile(directory, HOST_DAEMON_STATE_FILENAME, 1), null)
})

test('packaged Windows smoke refuses to claim verification on another operating system', async () => {
  await assert.rejects(
    runWindowsPackagedSmoke({ platform: 'darwin' }),
    /must run on Windows/,
  )
})
