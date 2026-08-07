import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ChatRunError } from './chat.mjs'
import { inspectProject } from './projects.mjs'
import { createRelayHost } from './server.mjs'

async function projectFixture(context) {
  const projectPath = await mkdtemp(join(tmpdir(), 'relay-project-test-'))
  context.after(() => rm(projectPath, { recursive: true, force: true }))
  await mkdir(join(projectPath, '.relay', 'features'), { recursive: true })
  await writeFile(join(projectPath, '.relay', 'project.md'), '# Test project\n')
  await writeFile(join(projectPath, '.relay', 'features', 'focus.md'), '# Focus\n')
  await writeFile(join(projectPath, 'AGENTS.md'), '# Instructions\n')
  return projectPath
}

test('project inspection returns only context and adapters found on disk', async (context) => {
  const projectPath = await projectFixture(context)
  const inspection = await inspectProject(projectPath)

  assert.equal(inspection.path, await realpath(projectPath))
  assert.equal(inspection.name, inspection.path.split(/[\\/]/).at(-1))
  assert.equal(inspection.host, 'local')
  assert.deepEqual(inspection.context.files, ['features/focus.md', 'project.md'])
  assert.deepEqual(inspection.context.featureFiles, ['features/focus.md'])
  assert.deepEqual(inspection.context.instructionAdapters, [
    { provider: 'codex', name: 'Codex', file: 'AGENTS.md' },
  ])
  assert.equal(inspection.context.truncated, false)
  assert.equal(inspection.context.error, null)
})

test('project inspection rejects relative and inaccessible folders', async () => {
  await assert.rejects(
    inspectProject('relative/project'),
    (error) => error instanceof ChatRunError && error.code === 'invalid_project',
  )
  await assert.rejects(
    inspectProject(join(tmpdir(), 'relay-project-that-does-not-exist')),
    (error) => error instanceof ChatRunError && error.code === 'invalid_project',
  )
})

test('project endpoints inspect explicit paths and the host working directory', async (context) => {
  const projectPath = await projectFixture(context)
  const server = createRelayHost({ defaultProjectPath: projectPath })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())

  const address = server.address()
  assert.equal(typeof address, 'object')
  const baseUrl = `http://127.0.0.1:${address.port}`

  const currentResponse = await fetch(`${baseUrl}/api/projects/current`)
  assert.equal(currentResponse.status, 200)
  const current = await currentResponse.json()
  assert.equal(current.project.path, await realpath(projectPath))

  const inspectResponse = await fetch(`${baseUrl}/api/projects/inspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: projectPath }),
  })
  assert.equal(inspectResponse.status, 200)
  const inspected = await inspectResponse.json()
  assert.equal(inspected.project.id, current.project.id)

  const invalidResponse = await fetch(`${baseUrl}/api/projects/inspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'relative/project' }),
  })
  assert.equal(invalidResponse.status, 400)
  const invalid = await invalidResponse.json()
  assert.equal(invalid.code, 'invalid_project')
})
