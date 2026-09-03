import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repositoryRoot = resolve(desktopRoot, '..')

test('desktop Host shutdown drains chat jobs before aborting and awaiting automatic landing', async () => {
  const bootstrap = await readFile(resolve(desktopRoot, 'src', 'host-bootstrap.mjs'), 'utf8')
  const chatShutdown = bootstrap.indexOf('await server.ensyncServices.chatJobs.shutdown()')
  const landingShutdown = bootstrap.indexOf('await server.ensyncServices.landingCoordinator?.shutdown?.()')
  const serverClose = bootstrap.indexOf('await new Promise((resolve) => server.close(resolve))')

  assert.ok(chatShutdown >= 0)
  assert.ok(landingShutdown > chatShutdown)
  assert.ok(serverClose > landingShutdown)
})

test('Host service forwards coordinator cancellation into the landing integrator', async () => {
  const server = await readFile(resolve(repositoryRoot, 'host', 'server.mjs'), 'utf8')

  assert.match(server, /integrate:\s*async \(train, runtime = \{\}\)/)
  assert.match(server, /integrator\.integrate\(train, \{\s*signal: runtime\.signal,/)
})
