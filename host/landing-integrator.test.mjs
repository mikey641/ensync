import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

import { AgentWorktreeClient, resolveAgentWorktreeExecutable } from './agent-worktree-client.mjs'
import { runGit } from './git.mjs'
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
  return {
    baseline,
    commonGitDirectory: await realpath(join(repositoryPath, '.git')),
    nativeClient,
    repositoryPath,
    root,
    storagePath,
  }
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
    commonGitDirectory: fixture.commonGitDirectory,
    projectPath: fixture.repositoryPath,
    workspacePath: branch.workspacePath,
    branch: branch.branch,
    savedSha: branch.savedSha,
    targetBranch: 'main',
    targetBaseSha: fixture.baseline,
    provider: 'codex',
    completionSequence: sequence,
    state: 'integrating',
    attempts: 1,
    createdAt: '2026-09-03T00:00:00.000Z',
    updatedAt: '2026-09-03T00:00:00.000Z',
    error: null,
  }
}

test('a durable train refuses a checkout that now belongs to another Git repository', async (context) => {
  const original = await fixture(context)
  const replacement = await fixture(context)
  const source = await branchCommit(original, 'ensync/chat-bound-repository', { 'bound.txt': 'safe\n' })
  const queued = {
    ...item(original, source, 1),
    repositoryPath: replacement.repositoryPath,
    projectPath: replacement.repositoryPath,
  }

  const result = await integrator(original.nativeClient).integrate([queued])

  assert.deepEqual(result.landedIds, [])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.match(result.errors['landing-1'], /shared Git directory|repository identity/i)
  assert.equal(await git(replacement.repositoryPath, ['rev-parse', 'main']), replacement.baseline)
})

function integrator(client, options = {}) {
  return new LandingIntegrator({
    client,
    idFactory: options.idFactory ?? (() => 'train-test'),
    resolutionTimeoutMs: options.resolutionTimeoutMs,
    resolutionShutdownTimeoutMs: options.resolutionShutdownTimeoutMs,
    gitRunner: options.gitRunner,
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
  assert.equal(
    await git(current.repositoryPath, ['config', '--get', `branch.${source.branch}.ensyncTargetBaseSha`]),
    source.savedSha,
  )
})

test('the published integration commits use the repository Git identity', async (context) => {
  const current = await fixture(context)
  await git(current.repositoryPath, ['config', 'user.name', 'Repository Owner'])
  await git(current.repositoryPath, ['config', 'user.email', 'repository-owner@example.test'])
  const source = await branchCommit(current, 'ensync/chat-identity', { 'identity.txt': 'identity\n' })

  const result = await integrator(current.nativeClient).integrate([item(current, source, 1)])

  assert.deepEqual(result.landedIds, ['landing-1'], JSON.stringify(result))
  assert.equal(await git(current.repositoryPath, ['show', '-s', '--format=%ae', 'main']), 'repository-owner@example.test')
  assert.notEqual(await git(current.repositoryPath, ['rev-parse', 'main']), source.savedSha)
})

test('an already-landed snapshot is a no-op and leaks no landing worktree', async (context) => {
  const current = await fixture(context)
  const source = {
    branch: 'ensync/chat-no-op',
    savedSha: current.baseline,
    workspacePath: current.repositoryPath,
  }

  const result = await integrator(current.nativeClient).integrate([item(current, source, 1)])

  assert.deepEqual(result.landedIds, ['landing-1'], JSON.stringify(result))
  assert.equal(await git(current.repositoryPath, ['branch', '--list', 'ensync/landing-trains/*']), '')
  assert.doesNotMatch(await git(current.repositoryPath, ['worktree', 'list', '--porcelain']), /ensync\/landing-trains\//)
})

test('a train applies snapshots in completion order and updates the target once', async (context) => {
  const current = await fixture(context)
  const first = await branchCommit(current, 'ensync/chat-first', { 'first.txt': 'first\n' })
  const second = await branchCommit(current, 'ensync/chat-second', { 'second.txt': 'second\n' })
  await git(current.repositoryPath, ['config', 'commit.gpgsign', 'true'])
  await git(current.repositoryPath, ['config', 'gpg.program', 'false'])
  const operations = []
  const gitOperations = []
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

  const result = await integrator(client, {
    gitRunner: async (args, options) => {
      gitOperations.push(args)
      return runGit(args, options)
    },
  }).integrate([
    item(current, second, 2),
    item(current, first, 1),
  ])

  assert.deepEqual(result.landedIds, ['landing-1', 'landing-2'])
  assert.equal(await readFile(join(current.repositoryPath, 'first.txt'), 'utf8'), 'first\n')
  assert.equal(await readFile(join(current.repositoryPath, 'second.txt'), 'utf8'), 'second\n')
  assert.equal(operations.filter((operation) => operation.property === 'merge').length, 1)
  assert.deepEqual(
    operations.filter((operation) => operation.property === 'sync').map((operation) => operation.input.from),
    ['ensync/landing-items/landing-1', 'ensync/landing-items/landing-2'],
  )
  assert.doesNotMatch(JSON.stringify(operations), /theirs|ours|"force":true/)
  assert.ok(gitOperations.every((args) => args.every((arg) => !arg.startsWith('--force'))))
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

test('a stale queued base cannot reintroduce a landed conversation after target history is reset', async (context) => {
  const current = await fixture(context)
  const source = await branchCommit(current, 'ensync/chat-stale-queued-base', { 'first.txt': 'first run\n' })
  const firstSavedSha = source.savedSha
  await writeFile(join(source.workspacePath, 'second.txt'), 'second run\n')
  await git(source.workspacePath, ['add', 'second.txt'])
  await git(source.workspacePath, ['commit', '-m', 'second run queued before first landed'])
  source.savedSha = await git(source.workspacePath, ['rev-parse', 'HEAD'])
  await git(
    current.repositoryPath,
    ['config', `branch.${source.branch}.ensyncTargetBaseSha`, firstSavedSha],
  )

  const result = await integrator(current.nativeClient).integrate([item(current, source, 2)])

  assert.deepEqual(result.landedIds, [])
  assert.deepEqual(result.retryIds, ['landing-2'])
  assert.match(result.errors['landing-2'], /checkpoint|rewritten history/i)
  assert.equal(await git(current.repositoryPath, ['rev-parse', 'refs/heads/main']), current.baseline)
  await assert.rejects(readFile(join(current.repositoryPath, 'first.txt'), 'utf8'))
  await assert.rejects(readFile(join(current.repositoryPath, 'second.txt'), 'utf8'))
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

test('hidden tracked changes never reach native publication or lose canonical bytes', async (context) => {
  const current = await fixture(context)
  const source = await branchCommit(current, 'ensync/chat-hidden-dirty', {
    'README.md': '# agent replacement\n',
  })
  await git(current.repositoryPath, ['update-index', '--assume-unchanged', 'README.md'])
  await writeFile(join(current.repositoryPath, 'README.md'), '# hidden local bytes\n')
  const beforeHead = await git(current.repositoryPath, ['rev-parse', 'refs/heads/main'])

  const result = await integrator(current.nativeClient).integrate([item(current, source, 1)])

  assert.deepEqual(result.landedIds, [])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.match(result.errors['landing-1'], /index flags|hidden tracked/i)
  assert.equal(await git(current.repositoryPath, ['rev-parse', 'refs/heads/main']), beforeHead)
  assert.equal(await readFile(join(current.repositoryPath, 'README.md'), 'utf8'), '# hidden local bytes\n')
})

test('the landing target is always the exact branch ref when a tag has the same name', async (context) => {
  const current = await fixture(context)
  await git(current.repositoryPath, ['tag', 'main', current.baseline])
  await writeFile(join(current.repositoryPath, 'target.txt'), 'new target base\n')
  await git(current.repositoryPath, ['add', 'target.txt'])
  await git(current.repositoryPath, ['commit', '-m', 'advance branch beyond colliding tag'])
  const branchHead = await git(current.repositoryPath, ['rev-parse', 'refs/heads/main'])
  const source = await branchCommit(
    current,
    'ensync/chat-tag-collision',
    { 'feature.txt': 'landed\n' },
    'refs/heads/main',
  )
  const queued = { ...item(current, source, 1), targetBaseSha: branchHead }

  const result = await integrator(current.nativeClient).integrate([queued])

  assert.deepEqual(result.landedIds, ['landing-1'], JSON.stringify(result))
  assert.equal(await readFile(join(current.repositoryPath, 'target.txt'), 'utf8'), 'new target base\n')
  assert.equal(await readFile(join(current.repositoryPath, 'feature.txt'), 'utf8'), 'landed\n')
  assert.equal(await git(current.repositoryPath, ['rev-parse', 'refs/tags/main']), current.baseline)
})

test('publication refuses to overwrite an ignored local file and leaves the target unchanged', async (context) => {
  const current = await fixture(context)
  await writeFile(join(current.repositoryPath, '.gitignore'), 'secret.txt\n')
  await git(current.repositoryPath, ['add', '.gitignore'])
  await git(current.repositoryPath, ['commit', '-m', 'ignore local secret'])
  const targetBefore = await git(current.repositoryPath, ['rev-parse', 'main'])
  const source = await branchCommit(current, 'ensync/chat-tracked-secret', { 'agent.txt': 'safe\n' })
  await writeFile(join(source.workspacePath, 'secret.txt'), 'agent bytes\n')
  await git(source.workspacePath, ['add', '-f', 'secret.txt'])
  await git(source.workspacePath, ['commit', '-m', 'track secret path'])
  source.savedSha = await git(source.workspacePath, ['rev-parse', 'HEAD'])
  await writeFile(join(current.repositoryPath, 'secret.txt'), 'user bytes\n')

  const result = await integrator(current.nativeClient).integrate([item(current, source, 1)])

  assert.deepEqual(result.landedIds, [])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.match(result.errors['landing-1'], /overwrite|local path/i)
  assert.equal(await git(current.repositoryPath, ['branch', '--show-current']), 'main')
  assert.equal(await git(current.repositoryPath, ['rev-parse', 'main']), targetBefore)
  assert.equal(await readFile(join(current.repositoryPath, 'secret.txt'), 'utf8'), 'user bytes\n')
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

test('an oversized conflict set retries without starting a resolver', async (context) => {
  const current = await fixture(context)
  const conflicting = await branchCommit(current, 'ensync/chat-many-conflicts', { 'README.md': '# chat version\n' })
  await writeFile(join(current.repositoryPath, 'README.md'), '# newer baseline\n')
  await git(current.repositoryPath, ['add', 'README.md'])
  await git(current.repositoryPath, ['commit', '-m', 'baseline changed'])
  let injected = false
  let resolverCalls = 0
  const landingIntegrator = integrator(current.nativeClient, {
    gitRunner: async (args, options) => {
      const result = await runGit(args, options)
      if (
        !injected
        && args[0] === 'diff'
        && args.includes('--diff-filter=U')
      ) {
        injected = true
        return {
          ...result,
          exitCode: 0,
          stdout: `${Array.from({ length: 129 }, (_, index) => `conflict-${index}.txt`).join('\0')}\0`,
        }
      }
      return result
    },
  })

  const result = await landingIntegrator.integrate([item(current, conflicting, 1)], {
    resolveConflict: async () => { resolverCalls += 1 },
  })

  assert.equal(injected, true)
  assert.equal(resolverCalls, 0)
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.match(result.errors['landing-1'], /too many conflict paths|bounded/i)
})

test('a conflict resolver lands only after conflicts and markers are gone', async (context) => {
  const current = await fixture(context)
  const conflicting = await branchCommit(current, 'ensync/chat-resolved', { 'README.md': '# chat version\n' })
  await writeFile(join(current.repositoryPath, 'README.md'), '# newer baseline\n')
  await git(current.repositoryPath, ['add', 'README.md'])
  await git(current.repositoryPath, ['commit', '-m', 'baseline changed'])
  const resolverCalls = []
  const landingIntegrator = integrator(current.nativeClient)

  const result = await landingIntegrator.integrate([item(current, conflicting, 1)], {
    resolveConflict: async (details) => {
      resolverCalls.push(details.conflictFiles)
      await writeFile(join(details.worktreePath, 'README.md'), '# combined resolution\n')
    },
  })

  assert.deepEqual(result.landedIds, ['landing-1'], JSON.stringify(result))
  assert.deepEqual(resolverCalls, [['README.md']])
  assert.equal(await readFile(join(current.repositoryPath, 'README.md'), 'utf8'), '# combined resolution\n')
})

test('a conflict resolver cannot commit changes outside the reported conflict files', async (context) => {
  const current = await fixture(context)
  await writeFile(join(current.repositoryPath, 'stable.txt'), 'stable\n')
  await git(current.repositoryPath, ['add', 'stable.txt'])
  await git(current.repositoryPath, ['commit', '-m', 'add stable file'])
  const conflicting = await branchCommit(current, 'ensync/chat-resolver-scope', { 'README.md': '# chat version\n' })
  await writeFile(join(current.repositoryPath, 'README.md'), '# newer baseline\n')
  await git(current.repositoryPath, ['add', 'README.md'])
  await git(current.repositoryPath, ['commit', '-m', 'baseline changed'])
  const before = await git(current.repositoryPath, ['rev-parse', 'main'])

  const result = await integrator(current.nativeClient).integrate([item(current, conflicting, 1)], {
    resolveConflict: async (details) => {
      await writeFile(join(details.worktreePath, 'README.md'), '# resolved\n')
      await writeFile(join(details.worktreePath, 'stable.txt'), 'provider changed unrelated file\n')
      await git(details.worktreePath, ['add', 'README.md', 'stable.txt'])
      await git(details.worktreePath, ['commit', '-m', 'over-broad resolution'])
    },
  })

  assert.deepEqual(result.landedIds, [])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.match(result.errors['landing-1'], /outside the reported conflict set/i)
  assert.equal(await git(current.repositoryPath, ['rev-parse', 'main']), before)
  assert.equal(await readFile(join(current.repositoryPath, 'stable.txt'), 'utf8'), 'stable\n')
})

test('a conflict resolver cannot redirect the integration worktree Git control file', async (context) => {
  const current = await fixture(context)
  const conflicting = await branchCommit(current, 'ensync/chat-resolver-gitdir', { 'README.md': '# chat version\n' })
  await writeFile(join(current.repositoryPath, 'README.md'), '# newer baseline\n')
  await git(current.repositoryPath, ['add', 'README.md'])
  await git(current.repositoryPath, ['commit', '-m', 'baseline changed'])
  const beforeHead = await git(current.repositoryPath, ['rev-parse', 'main'])
  const beforeBytes = await readFile(join(current.repositoryPath, 'README.md'), 'utf8')

  const result = await integrator(current.nativeClient).integrate([item(current, conflicting, 1)], {
    resolveConflict: async (details) => {
      await writeFile(join(details.worktreePath, '.git'), `gitdir: ${current.commonGitDirectory}\n`)
    },
  })

  assert.deepEqual(result.landedIds, [])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.match(result.errors['landing-1'], /Git control file/i)
  assert.equal(await git(current.repositoryPath, ['rev-parse', 'main']), beforeHead)
  assert.equal(await readFile(join(current.repositoryPath, 'README.md'), 'utf8'), beforeBytes)
  assert.equal(await git(current.repositoryPath, ['status', '--porcelain']), '')
})

test('a conflict resolver cannot rewind away commits already on the landing target', async (context) => {
  const current = await fixture(context)
  const conflicting = await branchCommit(current, 'ensync/chat-resolver-rewind', { 'README.md': '# chat version\n' })
  await writeFile(join(current.repositoryPath, 'README.md'), '# newer baseline\n')
  await git(current.repositoryPath, ['add', 'README.md'])
  await git(current.repositoryPath, ['commit', '-m', 'target commit must survive'])
  const before = await git(current.repositoryPath, ['rev-parse', 'main'])

  const result = await integrator(current.nativeClient).integrate([item(current, conflicting, 1)], {
    resolveConflict: async (details) => {
      await git(details.worktreePath, ['reset', '--hard', conflicting.savedSha])
    },
  })

  assert.deepEqual(result.landedIds, [])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.match(result.errors['landing-1'], /original landing target.*ancestor/i)
  assert.equal(await git(current.repositoryPath, ['rev-parse', 'main']), before)
})

test('automatic landing never executes repository-provided package scripts', async (context) => {
  const current = await fixture(context)
  const markerPath = join(current.root, 'untrusted-script-ran')
  const source = await branchCommit(current, 'ensync/chat-untrusted-script', {
    'package.json': `${JSON.stringify({
      scripts: {
        'land:quick': `node -e "require('node:fs').writeFileSync('${markerPath}', 'ran')"`,
      },
    })}\n`,
    'safe.txt': 'land this file\n',
  })
  const landingIntegrator = new LandingIntegrator({
    client: current.nativeClient,
    idFactory: () => 'train-untrusted-script',
  })

  const result = await landingIntegrator.integrate([item(current, source, 1)])

  assert.deepEqual(result.landedIds, ['landing-1'], JSON.stringify(result))
  await assert.rejects(readFile(markerPath, 'utf8'), (error) => error?.code === 'ENOENT')
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

test('one structurally invalid item retries without blocking a compatible later item', async (context) => {
  const current = await fixture(context)
  const invalid = await branchCommit(current, 'ensync/chat-invalid-marker', {
    'marker.txt': '<<<<<<< left\nvalue\n=======\nother\n>>>>>>> right\n',
  })
  const compatible = await branchCommit(current, 'ensync/chat-after-invalid', {
    'after-invalid.txt': 'still lands\n',
  })

  const result = await integrator(current.nativeClient).integrate([
    item(current, invalid, 1),
    item(current, compatible, 2),
  ])

  assert.deepEqual(result.landedIds, ['landing-2'])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.equal(await readFile(join(current.repositoryPath, 'after-invalid.txt'), 'utf8'), 'still lands\n')
  await assert.rejects(readFile(join(current.repositoryPath, 'marker.txt'), 'utf8'))
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

test('a resolver that ignores abort cannot race compatible later work in the same worktree', async (context) => {
  const current = await fixture(context)
  const conflicting = await branchCommit(current, 'ensync/chat-timeout', { 'README.md': '# chat version\n' })
  await writeFile(join(current.repositoryPath, 'README.md'), '# newer baseline\n')
  await git(current.repositoryPath, ['add', 'README.md'])
  await git(current.repositoryPath, ['commit', '-m', 'baseline changed'])
  const compatible = await branchCommit(current, 'ensync/chat-after-timeout', { 'after-timeout.txt': 'landed\n' })
  const never = new Promise(() => {})

  const result = await integrator(current.nativeClient, {
    resolutionTimeoutMs: 20,
    resolutionShutdownTimeoutMs: 20,
  }).integrate([
    item(current, conflicting, 1),
    item(current, compatible, 2),
  ], {
    resolveConflict: async () => never,
  })

  assert.deepEqual(result.landedIds, [])
  assert.deepEqual(result.retryIds, ['landing-1', 'landing-2'])
  assert.match(result.errors['landing-1'], /timed out/i)
  await assert.rejects(readFile(join(current.repositoryPath, 'after-timeout.txt'), 'utf8'))
})

test('an unconfirmed resolver shutdown abandons earlier accepted items instead of publishing that worktree', async (context) => {
  const current = await fixture(context)
  const acceptedFirst = await branchCommit(current, 'ensync/chat-before-hung-resolver', { 'before-timeout.txt': 'must retry\n' })
  const conflicting = await branchCommit(current, 'ensync/chat-hung-second', { 'README.md': '# chat version\n' })
  await writeFile(join(current.repositoryPath, 'README.md'), '# newer baseline\n')
  await git(current.repositoryPath, ['add', 'README.md'])
  await git(current.repositoryPath, ['commit', '-m', 'baseline changed'])
  const compatibleLater = await branchCommit(current, 'ensync/chat-after-hung-second', { 'after-hung.txt': 'must retry too\n' })

  const result = await integrator(current.nativeClient, {
    resolutionTimeoutMs: 20,
    resolutionShutdownTimeoutMs: 20,
  }).integrate([
    item(current, acceptedFirst, 1),
    item(current, conflicting, 2),
    item(current, compatibleLater, 3),
  ], {
    resolveConflict: async () => new Promise(() => {}),
  })

  assert.deepEqual(result.landedIds, [])
  assert.deepEqual(result.retryIds, ['landing-1', 'landing-2', 'landing-3'])
  await assert.rejects(readFile(join(current.repositoryPath, 'before-timeout.txt'), 'utf8'))
  await assert.rejects(readFile(join(current.repositoryPath, 'after-hung.txt'), 'utf8'))
})

test('a resolver commit followed by provider failure is reset before later compatible work lands', async (context) => {
  const current = await fixture(context)
  const conflicting = await branchCommit(current, 'ensync/chat-resolver-failed-after-commit', { 'README.md': '# chat version\n' })
  await writeFile(join(current.repositoryPath, 'README.md'), '# newer baseline\n')
  await git(current.repositoryPath, ['add', 'README.md'])
  await git(current.repositoryPath, ['commit', '-m', 'baseline changed'])
  const compatible = await branchCommit(current, 'ensync/chat-after-failed-resolver', { 'safe-later.txt': 'landed\n' })

  const result = await integrator(current.nativeClient).integrate([
    item(current, conflicting, 1),
    item(current, compatible, 2),
  ], {
    resolveConflict: async (details) => {
      await writeFile(join(details.worktreePath, 'README.md'), '# resolver output\n')
      await git(details.worktreePath, ['add', 'README.md'])
      await git(details.worktreePath, ['commit', '-m', 'resolver committed before failing'])
      throw new Error('provider parse failed after commit')
    },
  })
  const failedAncestor = await runGit(
    ['merge-base', '--is-ancestor', conflicting.savedSha, 'main'],
    { cwd: current.repositoryPath },
  )

  assert.deepEqual(result.landedIds, ['landing-2'])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.notEqual(failedAncestor.exitCode, 0)
  assert.equal(await readFile(join(current.repositoryPath, 'safe-later.txt'), 'utf8'), 'landed\n')
  assert.equal(await readFile(join(current.repositoryPath, 'README.md'), 'utf8'), '# newer baseline\n')
})

test('a resolver cannot redirect publication with a tag matching the integration branch', async (context) => {
  const current = await fixture(context)
  const conflicting = await branchCommit(current, 'ensync/chat-resolver-ref-collision', { 'README.md': '# chat version\n' })
  await writeFile(join(current.repositoryPath, 'README.md'), '# newer baseline\n')
  await git(current.repositoryPath, ['add', 'README.md'])
  await git(current.repositoryPath, ['commit', '-m', 'baseline changed'])
  const beforeHead = await git(current.repositoryPath, ['rev-parse', 'refs/heads/main'])
  const beforeBytes = await readFile(join(current.repositoryPath, 'README.md'), 'utf8')

  const result = await integrator(current.nativeClient).integrate([item(current, conflicting, 1)], {
    resolveConflict: async (details) => {
      const integrationBranch = await git(details.worktreePath, ['branch', '--show-current'])
      await git(details.worktreePath, ['tag', integrationBranch, conflicting.savedSha])
      await writeFile(join(details.worktreePath, 'README.md'), '# resolved\n')
    },
  })

  assert.deepEqual(result.landedIds, [])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.match(result.errors['landing-1'], /ambiguous|colliding ref|matching tag/i)
  assert.equal(await git(current.repositoryPath, ['rev-parse', 'refs/heads/main']), beforeHead)
  assert.equal(await readFile(join(current.repositoryPath, 'README.md'), 'utf8'), beforeBytes)
})

test('an abort-aware timed-out resolver stops before compatible later work continues', async (context) => {
  const current = await fixture(context)
  const conflicting = await branchCommit(current, 'ensync/chat-timeout-aware', { 'README.md': '# chat version\n' })
  await writeFile(join(current.repositoryPath, 'README.md'), '# newer baseline\n')
  await git(current.repositoryPath, ['add', 'README.md'])
  await git(current.repositoryPath, ['commit', '-m', 'baseline changed'])
  const compatible = await branchCommit(current, 'ensync/chat-after-aware-timeout', { 'after-aware-timeout.txt': 'landed\n' })

  const result = await integrator(current.nativeClient, {
    resolutionTimeoutMs: 20,
    resolutionShutdownTimeoutMs: 100,
  }).integrate([
    item(current, conflicting, 1),
    item(current, compatible, 2),
  ], {
    resolveConflict: ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('resolver stopped')), { once: true })
    }),
  })

  assert.deepEqual(result.landedIds, ['landing-2'])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.match(result.errors['landing-1'], /timed out/i)
  assert.equal(await readFile(join(current.repositoryPath, 'after-aware-timeout.txt'), 'utf8'), 'landed\n')
})

test('landing stays bound to the target branch captured with the provider snapshot', async (context) => {
  const current = await fixture(context)
  await git(current.repositoryPath, ['branch', 'release', 'main'])
  const source = await branchCommit(current, 'ensync/chat-target-main', { 'targeted.txt': 'main only\n' })
  await git(current.repositoryPath, ['checkout', 'release'])

  const result = await integrator(current.nativeClient).integrate([item(current, source, 1)])

  assert.deepEqual(result.landedIds, [])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.match(result.errors['landing-1'], /target branch main.*checked out/i)
  assert.equal(await git(current.repositoryPath, ['rev-parse', 'main']), current.baseline)
  assert.equal(await git(current.repositoryPath, ['rev-parse', 'release']), current.baseline)
})

test('agent-worktree publication rejects a concurrent target advance without reintroducing history', async (context) => {
  const current = await fixture(context)
  const source = await branchCommit(current, 'ensync/chat-cas', { 'cas.txt': 'candidate\n' })
  let moved = false
  let concurrent
  const client = new Proxy(current.nativeClient, {
    get(target, property) {
      const value = target[property]
      if (property !== 'merge') return typeof value === 'function' ? value.bind(target) : value
      return async (input) => {
        moved = true
        const parent = await git(current.repositoryPath, ['rev-parse', 'main'])
        const tree = await git(current.repositoryPath, ['rev-parse', 'main^{tree}'])
        concurrent = await git(current.repositoryPath, ['commit-tree', tree, '-p', parent, '-m', 'concurrent target advance'])
        await git(current.repositoryPath, ['update-ref', 'refs/heads/main', concurrent, parent])
        return value.call(target, input)
      }
    }
  })

  const result = await integrator(client).integrate([item(current, source, 1)])
  assert.equal(moved, true)
  assert.deepEqual(result.landedIds, [], JSON.stringify(result))
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.equal(await git(current.repositoryPath, ['rev-parse', 'main']), concurrent)
  await assert.rejects(readFile(join(current.repositoryPath, 'cas.txt'), 'utf8'), { code: 'ENOENT' })
})

test('integration creation is pinned to the inspected target commit', async (context) => {
  const current = await fixture(context)
  const source = await branchCommit(current, 'ensync/chat-create-race', { 'pinned.txt': 'candidate\n' })
  let transient
  const client = new Proxy(current.nativeClient, {
    get(target, property) {
      const value = target[property]
      if (property !== 'create') return typeof value === 'function' ? value.bind(target) : value
      return async (input) => {
        if (!input.branch.startsWith('ensync/landing-trains/')) return value.call(target, input)
        const tree = await git(current.repositoryPath, ['rev-parse', 'main^{tree}'])
        transient = await git(current.repositoryPath, ['commit-tree', tree, '-p', current.baseline, '-m', 'transient removed target'])
        await git(current.repositoryPath, ['update-ref', 'refs/heads/main', transient, current.baseline])
        try {
          return await value.call(target, input)
        } finally {
          await git(current.repositoryPath, ['update-ref', 'refs/heads/main', current.baseline, transient])
        }
      }
    },
  })

  const result = await integrator(client).integrate([item(current, source, 1)])
  const transientRetained = await runGit(
    ['merge-base', '--is-ancestor', transient, 'main'],
    { cwd: current.repositoryPath },
  )

  assert.deepEqual(result.landedIds, ['landing-1'], JSON.stringify(result))
  assert.equal(transientRetained.exitCode, 1)
  assert.equal(await readFile(join(current.repositoryPath, 'pinned.txt'), 'utf8'), 'candidate\n')
})

test('post-publication checks stay pinned to one SHA and observe the final target ref', async (context) => {
  const current = await fixture(context)
  const source = await branchCommit(current, 'ensync/chat-post-publish-race', { 'post-race.txt': 'candidate\n' })
  let published = false
  let rewritten = false
  const client = new Proxy(current.nativeClient, {
    get(target, property) {
      const value = target[property]
      if (property !== 'merge') return typeof value === 'function' ? value.bind(target) : value
      return async (input) => {
        const result = await value.call(target, input)
        published = true
        return result
      }
    },
  })
  const gitRunner = async (args, options) => {
    const result = await runGit(args, options)
    if (
      published
      && !rewritten
      && args[0] === 'merge-base'
      && args[1] === '--is-ancestor'
      && args[2] === source.savedSha
      && result.exitCode === 0
    ) {
      const currentHead = (await runGit(['rev-parse', '--verify', 'main'], options)).stdout.trim()
      await runGit(['update-ref', 'refs/heads/main', current.baseline, currentHead], options)
      rewritten = true
    }
    return result
  }

  const result = await integrator(client, { gitRunner }).integrate([item(current, source, 1)])

  assert.equal(rewritten, true)
  assert.deepEqual(result.landedIds, [])
  assert.deepEqual(result.retryIds, ['landing-1'])
  assert.equal(await git(current.repositoryPath, ['rev-parse', 'main']), current.baseline)
})
