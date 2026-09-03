import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  AgentWorktreeClient,
  AgentWorktreeCommandError,
  resolveAgentWorktreeExecutable,
} from './agent-worktree-client.mjs'
import { stageAgentWorktree } from '../scripts/stage-agent-worktree.mjs'

async function executable(path) {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, '#!/bin/sh\nexit 0\n')
  await chmod(path, 0o755)
  return path
}

test('agent-worktree executable resolution prefers an explicit packaged binary', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ensync-wt-resolution-'))
  const packaged = await executable(join(root, 'tools', 'wt'))
  const source = await executable(join(root, 'node_modules', '.bin', 'wt'))

  assert.equal(await resolveAgentWorktreeExecutable({
    env: { ENSYNC_AGENT_WORKTREE_EXECUTABLE: packaged },
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
      env: { ENSYNC_AGENT_WORKTREE_EXECUTABLE: join(root, 'missing-wt') },
      sourceRoot: root,
      platform: 'win32',
      arch: 'x64',
    }),
    /agent-worktree executable is unavailable/i,
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
  const client = new AgentWorktreeClient({
    executable: '/tools/wt',
    storagePath: '/state/agent-worktree',
    run,
    env: { PATH: '/usr/bin' },
    prepareRuntime: async () => {},
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
  await client.sync({ worktreePath: '/repo/chat-1', from: 'main', strategy: 'merge' })
  await client.continueSync({ worktreePath: '/repo/chat-1' })
  await client.abortSync({ worktreePath: '/repo/chat-1' })
  await client.merge({ repositoryPath: '/repo', worktreePath: '/repo/chat-1', into: 'main', strategy: 'merge', delete: true })
  await client.remove({ repositoryPath: '/repo', branch: 'ensync/chat-1' })

  assert.deepEqual(calls.map(({ args }) => args), [
    ['ls', '--json'],
    ['status', '--json'],
    ['new', '--base', 'main', '--', 'ensync/chat-2'],
    ['ls', '--json'],
    ['sync', '--strategy', 'merge', '--from', 'main'],
    ['sync', '--continue'],
    ['sync', '--abort'],
    ['merge', '--strategy', 'merge', '--into', 'main', '--delete'],
    ['rm', '--', 'ensync/chat-1'],
  ])
  for (const call of calls) {
    assert.equal(call.file, '/tools/wt')
    assert.equal(call.options.shell, false)
    assert.equal(call.options.env.AGENT_WORKTREE_DIR, '/state/agent-worktree')
    assert.equal(call.options.maxBuffer, 512 * 1024)
  }
})

test('merge exit 13 is a conflict disposition while other failures are typed errors', async () => {
  const conflict = Object.assign(new Error('merge conflict'), {
    code: 13,
    stdout: '',
    stderr: 'Merge aborted due to conflicts',
  })
  const client = new AgentWorktreeClient({
    executable: '/tools/wt',
    storagePath: '/state/agent-worktree',
    run: async () => { throw conflict },
    prepareRuntime: async () => {},
  })

  assert.deepEqual(await client.merge({ repositoryPath: '/repo', worktreePath: '/repo/chat-1', into: 'main' }), {
    disposition: 'conflict',
    exitCode: 13,
    stdout: '',
    stderr: 'Merge aborted due to conflicts',
  })

  conflict.code = 2
  await assert.rejects(
    client.merge({ repositoryPath: '/repo', worktreePath: '/repo/chat-1', into: 'main' }),
    (error) => error instanceof AgentWorktreeCommandError
      && error.exitCode === 2
      && error.operation === 'merge',
  )
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

test('client refuses project agent-worktree config before create or merge can run hooks', async (context) => {
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
    () => client.merge({ repositoryPath, worktreePath, into: 'main' }),
  ]) {
    await assert.rejects(
      operation(),
      (error) => error instanceof AgentWorktreeCommandError
        && error.operation === 'configuration'
        && /project config.*disabled/i.test(error.message),
    )
  }
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
