import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  AgentWorktreeClient,
  AgentWorktreeCommandError,
  resolveAgentWorktreeExecutable,
  runAgentWorktreeCommand,
} from './agent-worktree-client.mjs'
import { runCommand, stageAgentWorktree } from '../scripts/stage-agent-worktree.mjs'

async function executable(path) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, '#!/bin/sh\nprintf "wt 0.13.6\\n"\n')
  await chmod(path, 0o755)
  return path
}

test('agent-worktree executable resolution prefers the packaged pinned binary and ignores env overrides', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-wt-resolution-'))
  const packaged = await executable(join(root, 'tools', 'wt'))
  const source = await executable(join(root, 'node_modules', '.bin', 'wt'))

  assert.equal(await resolveAgentWorktreeExecutable({
    env: { ENSYNC_AGENT_WORKTREE_EXECUTABLE: '/untrusted/wt' },
    sourceRoot: root,
    platform: 'darwin',
    arch: 'arm64',
  }), packaged)
  assert.notEqual(packaged, source)
})

test('agent-worktree executable resolves from the source dependency bin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-wt-source-'))
  const source = await executable(join(root, 'node_modules', '.bin', 'wt'))

  assert.equal(await resolveAgentWorktreeExecutable({
    env: {},
    sourceRoot: root,
    platform: 'darwin',
    arch: 'arm64',
  }), source)
})

test('agent-worktree executable resolution rejects a missing runtime', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-wt-missing-'))

  await assert.rejects(
    resolveAgentWorktreeExecutable({
      env: {},
      sourceRoot: root,
      platform: 'win32',
      arch: 'x64',
    }),
    /agent-worktree.*executable is unavailable/i,
  )
})

test('client uses argument arrays, fixed tool storage, and parses JSON operations', async () => {
  const calls = []
  const run = async (file, args, options) => {
    calls.push({ file, args, options })
    if (args[0] === 'ls') {
      const worktrees = calls.some((call) => call.args[0] === 'new')
        ? [
            { branch: 'ensync/chat-1', path: '/repo/chat-1' },
            { branch: 'ensync/chat-2', path: '/repo/chat-2' },
          ]
        : [{ branch: 'ensync/chat-1', path: '/repo/chat-1' }]
      return {
        stdout: JSON.stringify({ version: 1, worktrees }),
        stderr: '',
      }
    }
    if (args[0] === 'status') {
      return {
        stdout: JSON.stringify({ version: 1, branch: 'ensync/chat-1', path: '/repo/chat-1' }),
        stderr: '',
      }
    }
    return { stdout: '', stderr: 'ok' }
  }
  const publicationGuards = []
  const client = new AgentWorktreeClient({
    executable: '/tools/wt',
    storagePath: '/state/agent-worktree',
    run,
    env: {
      PATH: '/usr/bin',
      GIT_CONFIG_COUNT: '2',
      GIT_CONFIG_KEY_0: 'core.hooksPath',
      GIT_CONFIG_VALUE_0: '/untrusted/hooks',
      GIT_CONFIG_KEY_1: 'alias.pwn',
      GIT_CONFIG_VALUE_1: '!touch /tmp/pwned',
    },
    prepareRuntime: async () => {},
    withPublicationGuard: async (details, invoke) => {
      publicationGuards.push(details)
      return invoke({
        GIT_CONFIG_VALUE_0: '/state/agent-worktree/publication-guard',
        ENSYNC_EXPECTED_REF: `refs/heads/${details.into}`,
        ENSYNC_EXPECTED_OLD: details.expectedHead,
      })
    },
  })

  assert.deepEqual(await client.list('/repo'), {
    version: 1,
    worktrees: [{ branch: 'ensync/chat-1', path: '/repo/chat-1' }],
  })
  assert.deepEqual(await client.status('/repo/chat-1'), {
    version: 1,
    branch: 'ensync/chat-1',
    path: '/repo/chat-1',
  })
  await client.create({ repositoryPath: '/repo', branch: 'ensync/chat-2', base: 'main' })
  const identity = { name: 'Repository User', email: 'repository@example.test' }
  await client.sync({ worktreePath: '/repo/chat-1', from: 'main', strategy: 'merge', identity })
  await client.continueSync({ worktreePath: '/repo/chat-1', identity })
  await client.abortSync({ worktreePath: '/repo/chat-1' })
  await client.merge({
    repositoryPath: '/repo',
    worktreePath: '/repo/chat-1',
    into: 'main',
    expectedHead: 'a'.repeat(40),
    commitMessage: 'Explain the integrated work',
    identity,
  })
  await client.remove({ repositoryPath: '/repo', branch: 'ensync/chat-1' })

  assert.deepEqual(calls.map(({ args }) => args), [
    ['ls', '--json'],
    ['status', '--json'],
    ['new', '--base', 'main', '--', 'ensync/chat-2'],
    ['ls', '--json'],
    ['sync', '--strategy', 'merge', '--from', 'main'],
    ['sync', '--continue'],
    ['sync', '--abort'],
    ['merge', '--strategy', 'merge', '--into', 'main', '--skip-hooks'],
    ['rm', '--', 'ensync/chat-1'],
  ])
  for (const call of calls) {
    assert.equal(call.file, '/tools/wt')
    assert.equal(call.options.shell, false)
    assert.equal(call.options.env.AGENT_WORKTREE_DIR, '/state/agent-worktree')
    assert.equal(call.options.env.GIT_CONFIG_COUNT, '2')
    assert.equal(call.options.env.GIT_CONFIG_KEY_0, 'core.hooksPath')
    assert.equal(
      call.options.env.GIT_CONFIG_VALUE_0,
      call.args[0] === 'merge' ? '/state/agent-worktree/publication-guard' : '/dev/null',
    )
    assert.equal(call.options.env.GIT_CONFIG_KEY_1, 'commit.gpgsign')
    assert.equal(call.options.env.GIT_CONFIG_VALUE_1, 'false')
    assert.equal(call.options.maxBuffer, 512 * 1024)
  }
  assert.deepEqual(publicationGuards, [{
    storagePath: '/state/agent-worktree',
    into: 'main',
    expectedHead: 'a'.repeat(40),
    commitMessage: 'Explain the integrated work',
  }])
  const syncCalls = calls.filter((call) => (
    call.args[0] === 'sync' && !call.args.includes('--abort')
  ))
  for (const call of syncCalls) {
    assert.equal(call.options.env.GIT_AUTHOR_NAME, identity.name)
    assert.equal(call.options.env.GIT_AUTHOR_EMAIL, identity.email)
    assert.equal(call.options.env.GIT_COMMITTER_NAME, identity.name)
    assert.equal(call.options.env.GIT_COMMITTER_EMAIL, identity.email)
  }
})

test('client forwards cancellation to the active native command', async () => {
  const controller = new AbortController()
  let receivedSignal = null
  const client = new AgentWorktreeClient({
    executable: '/tools/wt',
    storagePath: '/state/agent-worktree',
    prepareRuntime: async () => {},
    run: async (_file, _args, options) => {
      receivedSignal = options.signal
      throw new Error('aborted')
    },
  })

  await assert.rejects(client.sync({
    worktreePath: '/repo/chat-1',
    from: 'main',
    signal: controller.signal,
  }), AgentWorktreeCommandError)
  assert.equal(receivedSignal, controller.signal)
})

test('native adapter cancellation terminates the full process group and waits for forced close', async () => {
  const child = new EventEmitter()
  child.pid = 456
  child.stdout = new PassThrough()
  child.stderr = new PassThrough()
  const treeKills = []
  let spawnOptions = null
  const controller = new AbortController()
  const pending = runAgentWorktreeCommand('/tools/wt', ['sync'], {
    platform: 'darwin',
    signal: controller.signal,
    terminationGraceMs: 5,
    spawn: (_file, _args, options) => {
      spawnOptions = options
      return child
    },
    killTree: async (_child, force) => {
      treeKills.push(force)
      if (force) setImmediate(() => child.emit('close', null, 'SIGKILL'))
    },
  })

  controller.abort()
  await assert.rejects(pending, (error) => error?.name === 'AbortError')
  assert.equal(spawnOptions.detached, true)
  assert.deepEqual(treeKills, [false, true])
})

test('malformed JSON never escapes as an untyped parser failure', async () => {
  const client = new AgentWorktreeClient({
    executable: '/tools/wt',
    storagePath: '/state/agent-worktree',
    run: async () => ({ stdout: 'not-json', stderr: '' }),
    prepareRuntime: async () => {},
  })

  await assert.rejects(
    client.list('/repo'),
    (error) => error instanceof AgentWorktreeCommandError
      && error.operation === 'list'
      && /invalid JSON/i.test(error.message),
  )
})

test('client pins a no-hook no-submodule runtime configuration', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-wt-safe-runtime-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const repositoryPath = join(root, 'repository')
  const storagePath = join(root, 'state')
  await mkdir(repositoryPath)
  const client = new AgentWorktreeClient({
    executable: '/tools/wt',
    storagePath,
    run: async () => ({ stdout: JSON.stringify({ version: 1, worktrees: [] }), stderr: '' }),
  })

  await client.list(repositoryPath)
  const config = await readFile(join(storagePath, 'config.toml'), 'utf8')

  assert.match(config, /submodules\s*=\s*false/)
  assert.match(config, /copy_files\s*=\s*\[\]/)
  assert.match(config, /post_create\s*=\s*\[\]/)
  assert.match(config, /pre_merge\s*=\s*\[\]/)
  assert.match(config, /post_merge\s*=\s*\[\]/)
})

test('client refreshes safe runtime config before every native invocation', async () => {
  let preparations = 0
  const client = new AgentWorktreeClient({
    executable: '/tools/wt',
    storagePath: '/state/agent-worktree',
    run: async () => ({ stdout: JSON.stringify({ version: 1, worktrees: [] }), stderr: '' }),
    prepareRuntime: async () => { preparations += 1 },
  })

  await client.list('/repo')
  await client.list('/repo')

  assert.equal(preparations, 2)
})

test('concurrent Hosts retain an already-safe runtime config instead of replacing it', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-wt-shared-runtime-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const storagePath = join(root, 'state')
  const run = async () => ({ stdout: JSON.stringify({ version: 1, worktrees: [] }), stderr: '' })
  const firstClient = new AgentWorktreeClient({ executable: '/tools/wt', storagePath, run })
  const secondClient = new AgentWorktreeClient({ executable: '/tools/wt', storagePath, run })

  await firstClient.list(root)
  const configPath = join(storagePath, 'config.toml')
  const before = await stat(configPath)
  await secondClient.list(root)
  const after = await stat(configPath)

  assert.equal(after.ino, before.ino)
  assert.equal(after.birthtimeMs, before.birthtimeMs)
})

test('client holds the safe runtime config stable for one native invocation at a time', async () => {
  const order = []
  let releaseFirst
  const firstDone = new Promise((resolve) => { releaseFirst = resolve })
  const client = new AgentWorktreeClient({
    executable: '/tools/wt',
    storagePath: '/state/agent-worktree',
    prepareRuntime: async () => { order.push('prepare') },
    run: async () => {
      order.push('run-start')
      if (order.filter((entry) => entry === 'run-start').length === 1) await firstDone
      order.push('run-end')
      return { stdout: JSON.stringify({ version: 1, worktrees: [] }), stderr: '' }
    },
  })

  const first = client.list('/repo/one')
  const second = client.list('/repo/two')
  await new Promise((resolve) => setImmediate(resolve))
  assert.deepEqual(order, ['prepare', 'run-start'])
  releaseFirst()
  await Promise.all([first, second])
  assert.deepEqual(order, [
    'prepare', 'run-start', 'run-end',
    'prepare', 'run-start', 'run-end',
  ])
})

test('queued commands recheck project configuration inside the serialized spawn boundary', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-wt-config-race-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const worktreePath = join(root, 'worktree')
  await mkdir(worktreePath)
  let releaseFirst
  let firstStarted
  const started = new Promise((resolve) => { firstStarted = resolve })
  const calls = []
  const client = new AgentWorktreeClient({
    executable: '/tools/wt',
    storagePath: join(root, 'state'),
    prepareRuntime: async () => {},
    run: async (_file, args) => {
      calls.push(args)
      if (args[0] === 'ls') {
        firstStarted()
        await new Promise((resolve) => { releaseFirst = resolve })
        return { stdout: JSON.stringify({ version: 1, worktrees: [] }), stderr: '' }
      }
      return { stdout: '', stderr: '' }
    },
  })

  const first = client.list(worktreePath)
  await started
  const queued = client.sync({ worktreePath, from: 'main' })
  await writeFile(join(worktreePath, '.agent-worktree.toml'), '[hooks]\npost_merge = ["unsafe"]\n')
  releaseFirst()
  await first

  await assert.rejects(
    queued,
    (error) => error instanceof AgentWorktreeCommandError
      && error.operation === 'configuration',
  )
  assert.deepEqual(calls.map((args) => args[0]), ['ls'])
})

test('safe runtime preparation fails closed without following an attacker-controlled config symlink', {
  skip: process.platform === 'win32',
}, async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-wt-config-symlink-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const storagePath = join(root, 'state')
  const victim = join(root, 'victim.txt')
  await mkdir(storagePath)
  await writeFile(victim, 'preserve me')
  await symlink(victim, join(storagePath, 'config.toml'))
  const client = new AgentWorktreeClient({
    executable: '/tools/wt',
    storagePath,
    run: async () => ({ stdout: JSON.stringify({ version: 1, worktrees: [] }), stderr: '' }),
  })

  await assert.rejects(client.list(root), /config.*regular file/i)

  assert.equal(await readFile(victim, 'utf8'), 'preserve me')
})

test('client refuses project agent-worktree config before create, sync, or merge can run hooks', async (context) => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-wt-project-config-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const repositoryPath = join(root, 'repository')
  const worktreePath = join(root, 'worktree')
  await mkdir(repositoryPath)
  await mkdir(worktreePath)
  await writeFile(join(repositoryPath, '.agent-worktree.toml'), '[hooks]\npost_create = ["sleep 999"]\n')
  let runCalls = 0
  const client = new AgentWorktreeClient({
    executable: '/tools/wt',
    storagePath: join(root, 'state'),
    run: async () => {
      runCalls += 1
      return { stdout: '', stderr: '' }
    },
  })

  for (const operation of [
    () => client.create({ repositoryPath, branch: 'ensync/chat-1', base: 'main' }),
    () => client.sync({ worktreePath: repositoryPath, from: 'main' }),
    () => client.merge({ repositoryPath, worktreePath, into: 'main', expectedHead: 'a'.repeat(40) }),
  ]) {
    await assert.rejects(
      operation(),
      (error) => error instanceof AgentWorktreeCommandError
        && error.operation === 'configuration'
      && /project config.*disabled/i.test(error.message),
    )
  }
  await rm(join(repositoryPath, '.agent-worktree.toml'))
  await writeFile(join(worktreePath, '.agent-worktree.toml'), '[hooks]\npost_merge = ["sleep 999"]\n')
  await assert.rejects(
    client.sync({ worktreePath, from: 'main' }),
    (error) => error instanceof AgentWorktreeCommandError
      && error.operation === 'configuration'
      && /project config.*disabled/i.test(error.message),
  )
  assert.equal(runCalls, 0)
})

test('native staging copies only the matching pinned platform executable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-wt-stage-'))
  const source = join(
    root,
    'node_modules',
    '@nekocode',
    'agent-worktree-darwin-arm64',
    'bin',
    'wt',
  )
  await mkdir(join(source, '..'), { recursive: true })
  await writeFile(join(source, '..', '..', 'package.json'), JSON.stringify({
    name: '@nekocode/agent-worktree-darwin-arm64',
    version: '0.13.6',
  }))
  await writeFile(source, 'native binary')
  await chmod(source, 0o755)
  const toolsDirectory = join(root, 'desktop', 'build', 'tools')

  const staged = await stageAgentWorktree({
    repoRoot: root,
    toolsDirectory,
    platform: 'darwin',
    arch: 'arm64',
  })

  assert.equal(staged, join(toolsDirectory, 'wt'))
  assert.equal(await readFile(staged, 'utf8'), 'native binary')
  assert.notEqual((await stat(staged)).mode & 0o111, 0)
  await assert.rejects(
    stageAgentWorktree({
      repoRoot: root,
      toolsDirectory,
      platform: 'linux',
      arch: 'arm64',
    }),
    /unsupported platform/i,
  )
})

test('packaging commands wait for inherited output streams to close', async () => {
  const grandchild = 'setTimeout(() => process.stdout.write("late output"), 40)'
  const parent = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 1, 2] })`

  const result = await runCommand(process.execPath, ['-e', parent])

  assert.equal(result.stdout, 'late output')
})

test('universal macOS staging combines both exact pinned architecture packages', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-wt-universal-stage-'))
  for (const arch of ['arm64', 'x64']) {
    const packageRoot = join(root, 'node_modules', '@nekocode', `agent-worktree-darwin-${arch}`)
    await mkdir(join(packageRoot, 'bin'), { recursive: true })
    await writeFile(join(packageRoot, 'package.json'), JSON.stringify({
      name: `@nekocode/agent-worktree-darwin-${arch}`,
      version: '0.13.6',
    }))
    await writeFile(join(packageRoot, 'bin', 'wt'), arch)
  }
  const calls = []

  const staged = await stageAgentWorktree({
    repoRoot: root,
    toolsDirectory: join(root, 'desktop', 'build', 'tools'),
    platform: 'darwin',
    arch: 'arm64',
    universalMac: true,
    combineUniversal: async (input) => {
      calls.push(input)
      await writeFile(input.destination, 'universal')
    },
  })

  assert.equal(await readFile(staged, 'utf8'), 'universal')
  assert.equal(calls.length, 1)
  assert.match(calls[0].arm64, /agent-worktree-darwin-arm64\/bin\/wt$/)
  assert.match(calls[0].x64, /agent-worktree-darwin-x64\/bin\/wt$/)
  assert.equal(calls[0].destination, `${staged}.${process.pid}.staging`)
  assert.notEqual((await stat(staged)).mode & 0o111, 0)
})

test('desktop packaging and local install both ship the staged runtime tool', async () => {
  const repositoryRoot = join(import.meta.dirname, '..')
  const manifest = JSON.parse(await readFile(join(repositoryRoot, 'desktop', 'package.json'), 'utf8'))
  assert.ok(manifest.build.extraResources.some((entry) => entry.from === 'build/tools' && entry.to === 'tools'))
  assert.match(
    await readFile(join(repositoryRoot, 'desktop', 'scripts', 'package-native.mjs'), 'utf8'),
    /stageAgentWorktree[\s\S]*universalMac:\s*platform\s*===\s*['"]macos['"]/,
  )
  assert.match(
    await readFile(join(repositoryRoot, 'scripts', 'install-app.mjs'), 'utf8'),
    /stageAgentWorktree/,
  )
})
