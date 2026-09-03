import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { AgentWorktreeClient, resolveAgentWorktreeExecutable } from './agent-worktree-client.mjs'
import { LandingIntegrator } from './landing-integrator.mjs'

const execFileAsync = promisify(execFile)

async function git(repositoryPath, args) {
  const result = await execFileAsync('git', args, {
    cwd: repositoryPath,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ensync Test',
      GIT_AUTHOR_EMAIL: 'ensync-test@example.invalid',
      GIT_COMMITTER_NAME: 'Ensync Test',
      GIT_COMMITTER_EMAIL: 'ensync-test@example.invalid',
      GIT_EDITOR: 'true',
      GIT_TERMINAL_PROMPT: '0',
    },
    maxBuffer: 512 * 1024,
  })
  return result.stdout.trim()
}

async function fixture(context) {
  const root = await mkdtemp(join(tmpdir(), 'ensync-landing-integrator-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const repositoryPath = join(root, 'repository')
  const storagePath = join(root, 'agent-worktree')
  await mkdir(repositoryPath)
  await git(repositoryPath, ['init', '-b', 'main'])
  await git(repositoryPath, ['config', 'user.name', 'Ensync Test'])
  await git(repositoryPath, ['config', 'user.email', 'ensync-test@example.invalid'])
  await writeFile(join(repositoryPath, 'README.md'), '# baseline\n')
  await git(repositoryPath, ['add', 'README.md'])
  await git(repositoryPath, ['commit', '-m', 'baseline'])
  const baseline = await git(repositoryPath, ['rev-parse', 'HEAD'])
  const executable = await resolveAgentWorktreeExecutable()
  const nativeClient = new AgentWorktreeClient({
    executable,
    storagePath,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ensync Test',
      GIT_AUTHOR_EMAIL: 'ensync-test@example.invalid',
      GIT_COMMITTER_NAME: 'Ensync Test',
      GIT_COMMITTER_EMAIL: 'ensync-test@example.invalid',
      GIT_EDITOR: 'true',
    },
  })
  return { baseline, nativeClient, repositoryPath, root, storagePath }
}

async function branchCommit(fixture, branch, files, base = 'main') {
  const workspacePath = join(fixture.root, branch.replaceAll('/', '-'))
  await git(fixture.repositoryPath, ['worktree', 'add', '-b', branch, workspacePath, base])
  for (const [path, contents] of Object.entries(files)) {
    const target = join(workspacePath, path)
    await mkdir(join(target, '..'), { recursive: true })
    await writeFile(target, contents)
  }
  await git(workspacePath, ['add', '--', '.'])
  await git(workspacePath, ['commit', '-m', `work on ${branch}`])
  return {
    branch,
    savedSha: await git(workspacePath, ['rev-parse', 'HEAD']),
    workspacePath,
  }
}

function item(fixture, branch, sequence, id = `landing-${sequence}`) {
  return {
    id,
    repositoryPath: fixture.repositoryPath,
    projectPath: fixture.repositoryPath,
    workspacePath: branch.workspacePath,
    branch: branch.branch,
    savedSha: branch.savedSha,
    provider: 'codex',
    completionSequence: sequence,
    state: 'integrating',
    attempts: 1,
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    error: null,
  }
}

function integrator(client, options = {}) {
  return new LandingIntegrator({
    client,
    idFactory: options.idFactory ?? (() => 'train-test'),
    runQuickCheck: options.runQuickCheck ?? (async () => ({ ok: true, skipped: true })),
    resolutionTimeoutMs: options.resolutionTimeoutMs,
  })
}

test('one immutable item lands and leaves its source chat worktree untouched', async (context) => {
  const current = await fixture(context)
  const source = await branchCommit(current, 'ensync/chat-one', { 'feature.txt': 'one\n' })

  const result = await integrator(current.nativeClient).integrate([item(current, source, 1)])

  assert.deepEqual(result.landedIds, ['landing-1'], JSON.stringify(result))
  assert.deepEqual(result.retryIds, [])
  assert.equal(await readFile(join(current.repositoryPath, 'feature.txt'), 'utf8'), 'one\n')
  assert.equal(await git(source.workspacePath, ['rev-parse', 'HEAD']), source.savedSha)
  assert.equal(await git(current.repositoryPath, ['branch', '--show-current']), 'main')
})

test('a train applies snapshots in completion order and updates the target once', async (context) => {
  const current = await fixture(context)
  const first = await branchCommit(current, 'ensync/chat-first', { 'first.txt': 'first\n' })
  const second = await branchCommit(current, 'ensync/chat-second', { 'second.txt': 'second\n' })
  const operations = []
  const client = new Proxy(current.nativeClient, {
    get(target, property) {
      const value = target[property]
      if (typeof value !== 'function') return value
      return async (...args) => {
        operations.push({ property, input: args[0] })
        return value.apply(target, args)
      }
    },
  })

  const result = await integrator(client).integrate([
    item(current, second, 2),
    item(current, first, 1),
  ])

  assert.deepEqual(result.landedIds, ['landing-1', 'landing-2'])
  assert.equal(await readFile(join(current.repositoryPath, 'first.txt'), 'utf8'), 'first\n')
  assert.equal(await readFile(join(current.repositoryPath, 'second.txt'), 'utf8'), 'second\n')
  assert.equal(await git(current.repositoryPath, ['rev-list', '--first-parent', '--count', `${current.baseline}..main`]), '1')
  assert.deepEqual(
    operations.filter((operation) => operation.property === 'sync').map((operation) => operation.input.from),
    ['ensync/landing-items/landing-1', 'ensync/landing-items/landing-2'],
  )
  assert.equal(operations.filter((operation) => operation.property === 'merge').length, 1)
  assert.doesNotMatch(JSON.stringify(operations), /theirs|ours|"force":true/)
})

test('a later run moving the chat branch cannot change an already queued snapshot', async (context) => {
  const current = await fixture(context)
  const source = await branchCommit(current, 'ensync/chat-moving', { 'first-run.txt': 'first\n' })
  await writeFile(join(source.workspacePath, 'second-run.txt'), 'second\n')
  await git(source.workspacePath, ['add', 'second-run.txt'])
  await git(source.workspacePath, ['commit', '-m', 'later work on the same chat'])

  const result = await integrator(current.nativeClient).integrate([item(current, source, 1)])

  assert.deepEqual(result.landedIds, ['landing-1'])
  assert.equal(await readFile(join(current.repositoryPath, 'first-run.txt'), 'utf8'), 'first\n')
  await assert.rejects(readFile(join(current.repositoryPath, 'second-run.txt'), 'utf8'))
})

test('a missing saved commit retries only that item while compatible later work lands', async (context) => {
  const current = await fixture(context)
  const missing = await branchCommit(current, 'ensync/chat-missing', { 'missing.txt': 'must not land\n' })
  missing.savedSha = 'f'.repeat(40)
  const compatible = await branchCommit(current, 'ensync/chat-compatible', { 'compatible.txt': 'lands\n' })

  const result = await integrator(current.nativeClient).integrate([
    item(current, missing, 1),
    item(current, compatible, 2),
  ])

  assert.deepEqual(result.landedIds, ['landing-2'])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.match(result.errors['landing-1'], /saved commit.*unavailable/i)
  assert.equal(await readFile(join(current.repositoryPath, 'compatible.txt'), 'utf8'), 'lands\n')
  await assert.rejects(readFile(join(current.repositoryPath, 'missing.txt'), 'utf8'))
})

test('a dirty canonical checkout is byte-for-byte unchanged and the train retries', async (context) => {
  const current = await fixture(context)
  const source = await branchCommit(current, 'ensync/chat-dirty', { 'feature.txt': 'work\n' })
  await writeFile(join(current.repositoryPath, 'README.md'), '# unsaved user edit\n')
  const beforeHead = await git(current.repositoryPath, ['rev-parse', 'HEAD'])
  const beforeStatus = await git(current.repositoryPath, ['status', '--porcelain=v1'])

  const result = await integrator(current.nativeClient).integrate([item(current, source, 1)])

  assert.deepEqual(result.landedIds, [])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.equal(await git(current.repositoryPath, ['rev-parse', 'HEAD']), beforeHead)
  assert.equal(await git(current.repositoryPath, ['status', '--porcelain=v1']), beforeStatus)
  assert.equal(await readFile(join(current.repositoryPath, 'README.md'), 'utf8'), '# unsaved user edit\n')
})

test('an unresolved conflict retries while a compatible later snapshot still lands', async (context) => {
  const current = await fixture(context)
  const conflicting = await branchCommit(current, 'ensync/chat-conflict', { 'README.md': '# chat version\n' })
  await writeFile(join(current.repositoryPath, 'README.md'), '# newer baseline\n')
  await git(current.repositoryPath, ['add', 'README.md'])
  await git(current.repositoryPath, ['commit', '-m', 'baseline changed'])
  const compatible = await branchCommit(current, 'ensync/chat-after-conflict', { 'after.txt': 'still lands\n' })

  const result = await integrator(current.nativeClient).integrate([
    item(current, conflicting, 1),
    item(current, compatible, 2),
  ])

  assert.deepEqual(result.landedIds, ['landing-2'])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.match(result.errors['landing-1'], /conflict/i)
  assert.equal(await readFile(join(current.repositoryPath, 'after.txt'), 'utf8'), 'still lands\n')
  assert.equal(await readFile(join(current.repositoryPath, 'README.md'), 'utf8'), '# newer baseline\n')
})

test('a conflict resolver lands only after conflicts and markers are gone and the quick gate passes', async (context) => {
  const current = await fixture(context)
  const conflicting = await branchCommit(current, 'ensync/chat-resolved', { 'README.md': '# chat version\n' })
  await writeFile(join(current.repositoryPath, 'README.md'), '# newer baseline\n')
  await git(current.repositoryPath, ['add', 'README.md'])
  await git(current.repositoryPath, ['commit', '-m', 'baseline changed'])
  const resolverCalls = []
  const checks = []
  const landingIntegrator = integrator(current.nativeClient, {
    runQuickCheck: async (path) => {
      checks.push(path)
      return { ok: true }
    },
  })

  const result = await landingIntegrator.integrate([item(current, conflicting, 1)], {
    resolveConflict: async (details) => {
      resolverCalls.push(details.conflictFiles)
      await writeFile(join(details.worktreePath, 'README.md'), '# combined resolution\n')
    },
  })

  assert.deepEqual(result.landedIds, ['landing-1'], JSON.stringify(result))
  assert.deepEqual(resolverCalls, [['README.md']])
  assert.equal(checks.length, 1)
  assert.equal(await readFile(join(current.repositoryPath, 'README.md'), 'utf8'), '# combined resolution\n')
})

test('a failed quick gate publishes nothing and keeps every source snapshot recoverable', async (context) => {
  const current = await fixture(context)
  const source = await branchCommit(current, 'ensync/chat-red', { 'broken.txt': 'broken\n' })
  const landingIntegrator = integrator(current.nativeClient, {
    runQuickCheck: async () => ({ ok: false, reason: 'quick check failed', output: 'test red' }),
  })

  const result = await landingIntegrator.integrate([item(current, source, 1)])

  assert.deepEqual(result.landedIds, [])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.match(result.errors['landing-1'], /quick check failed.*test red/i)
  assert.equal(await git(current.repositoryPath, ['rev-parse', 'main']), current.baseline)
  assert.equal(await git(source.workspacePath, ['rev-parse', 'HEAD']), source.savedSha)
})

test('the dependency-free structural gate rejects committed conflict markers', async (context) => {
  const current = await fixture(context)
  const source = await branchCommit(current, 'ensync/chat-marker-commit', {
    'marker.txt': '<<<<<<< left\nvalue\n=======\nother\n>>>>>>> right\n',
  })

  const result = await integrator(current.nativeClient).integrate([item(current, source, 1)])

  assert.deepEqual(result.landedIds, [])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.match(result.errors['landing-1'], /structural check/i)
  assert.equal(await git(current.repositoryPath, ['rev-parse', 'main']), current.baseline)
})

test('a resolver that leaves conflict markers cannot land merely by exiting successfully', async (context) => {
  const current = await fixture(context)
  const conflicting = await branchCommit(current, 'ensync/chat-markers', { 'README.md': '# chat version\n' })
  await writeFile(join(current.repositoryPath, 'README.md'), '# newer baseline\n')
  await git(current.repositoryPath, ['add', 'README.md'])
  await git(current.repositoryPath, ['commit', '-m', 'baseline changed'])
  const baseline = await git(current.repositoryPath, ['rev-parse', 'HEAD'])

  const result = await integrator(current.nativeClient).integrate([item(current, conflicting, 1)], {
    resolveConflict: async () => {},
  })

  assert.deepEqual(result.landedIds, [])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.match(result.errors['landing-1'], /conflict markers remain/i)
  assert.equal(await git(current.repositoryPath, ['rev-parse', 'main']), baseline)
})

test('a timed-out resolver is aborted and does not block compatible later work', async (context) => {
  const current = await fixture(context)
  const conflicting = await branchCommit(current, 'ensync/chat-timeout', { 'README.md': '# chat version\n' })
  await writeFile(join(current.repositoryPath, 'README.md'), '# newer baseline\n')
  await git(current.repositoryPath, ['add', 'README.md'])
  await git(current.repositoryPath, ['commit', '-m', 'baseline changed'])
  const compatible = await branchCommit(current, 'ensync/chat-after-timeout', { 'after-timeout.txt': 'landed\n' })
  const never = new Promise(() => {})

  const result = await integrator(current.nativeClient, { resolutionTimeoutMs: 20 }).integrate([
    item(current, conflicting, 1),
    item(current, compatible, 2),
  ], {
    resolveConflict: async () => never,
  })

  assert.deepEqual(result.landedIds, ['landing-2'])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.match(result.errors['landing-1'], /timed out/i)
  assert.equal(await readFile(join(current.repositoryPath, 'after-timeout.txt'), 'utf8'), 'landed\n')
})
