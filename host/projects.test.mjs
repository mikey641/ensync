import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { ChatRunError } from './chat.mjs'
import { inspectProject, ProjectInspectionService } from './projects.mjs'
import { createEnsyncHost } from './server.mjs'

async function projectFixture(context) {
  const projectPath = await mkdtemp(join(tmpdir(), 'relay-project-test-'))
  context.after(() => rm(projectPath, { recursive: true, force: true }))
  await mkdir(join(projectPath, '.ensync', 'features'), { recursive: true })
  await writeFile(join(projectPath, '.ensync', 'project.md'), '# Test project\n')
  await writeFile(join(projectPath, '.ensync', 'features', 'focus.md'), '# Focus\n')
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
  const server = createEnsyncHost({ defaultProjectPath: projectPath })
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

async function recentProjectsFixture(context, projects) {
  const directory = await mkdtemp(join(tmpdir(), 'ensync-recent-projects-test-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = join(directory, 'global-recent-projects-v1.json')
  await writeFile(filePath, JSON.stringify({ payload: JSON.stringify({ projects }) }))
  return filePath
}

test('the current project never becomes the home directory the Host runs from', async (context) => {
  const homePath = await mkdtemp(join(tmpdir(), 'ensync-home-test-'))
  context.after(() => rm(homePath, { recursive: true, force: true }))
  const projectPath = await projectFixture(context)
  const projects = new ProjectInspectionService({
    defaultProjectPath: homePath,
    homePath,
    listRecentProjects: () => [{ name: 'project', path: projectPath, host: 'local' }],
  })

  const current = await projects.current()
  assert.equal(current.path, await realpath(projectPath))
})

test('the current project is none when only unusable folders are known', async (context) => {
  const homePath = await mkdtemp(join(tmpdir(), 'ensync-home-test-'))
  context.after(() => rm(homePath, { recursive: true, force: true }))
  const projects = new ProjectInspectionService({
    defaultProjectPath: homePath,
    homePath,
    listRecentProjects: () => [
      { name: 'home', path: homePath, host: 'local' },
      { name: 'gone', path: join(tmpdir(), 'ensync-project-that-does-not-exist'), host: 'local' },
    ],
  })

  assert.equal(await projects.current(), null)
})

test('a Host with no configured default project falls back to recent projects', async (context) => {
  const projectPath = await projectFixture(context)
  const recentProjectsPath = await recentProjectsFixture(context, [
    { name: 'project', path: projectPath, host: 'local' },
  ])
  const server = createEnsyncHost({ defaultProjectPath: null, recentProjectsPath })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/current`)
  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.project.path, await realpath(projectPath))
})

test('the current project endpoint reports no project instead of an unusable one', async (context) => {
  const homePath = await mkdtemp(join(tmpdir(), 'ensync-home-test-'))
  context.after(() => rm(homePath, { recursive: true, force: true }))
  const recentProjectsPath = await recentProjectsFixture(context, [
    { name: 'home', path: homePath, host: 'local' },
  ])
  const server = createEnsyncHost({ defaultProjectPath: homePath, homePath, recentProjectsPath })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/projects/current`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { project: null, homePath: await realpath(homePath) })
})

test('project responses report the home directory so clients never keep it as a project', async (context) => {
  const homePath = await mkdtemp(join(tmpdir(), 'ensync-home-test-'))
  context.after(() => rm(homePath, { recursive: true, force: true }))
  const projectPath = await projectFixture(context)
  const server = createEnsyncHost({ defaultProjectPath: projectPath, homePath })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  context.after(() => server.close())

  const baseUrl = `http://127.0.0.1:${server.address().port}`
  const current = await (await fetch(`${baseUrl}/api/projects/current`)).json()
  const inspected = await (await fetch(`${baseUrl}/api/projects/inspect`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: projectPath }),
  })).json()

  assert.equal(current.homePath, await realpath(homePath))
  assert.equal(inspected.homePath, await realpath(homePath))
  assert.equal(inspected.project.path, await realpath(projectPath))
})
