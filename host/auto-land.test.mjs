import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'
import { autoLandWorkspace } from './auto-land.mjs'
import { ChatRunService } from './chat.mjs'
import { ProjectIsolationService } from './project-isolation.mjs'

const execFileAsync = promisify(execFile)
const BRANCH = 'ensync/chat-aaaaaaaaaaaaaaaaaaaaaaaa'

async function git(args, options = {}) {
  return execFileAsync('git', args, {
    cwd: options.cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    maxBuffer: 512 * 1024,
  })
}

async function subjectOf(repositoryPath, ref = 'HEAD') {
  return (await git(['log', '-1', '--format=%s', ref], { cwd: repositoryPath })).stdout.trim()
}

async function mergeHeadExists(worktreePath) {
  try {
    await git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], { cwd: worktreePath })
    return true
  } catch {
    return false
  }
}

async function fixture(context) {
  try {
    await git(['--version'])
  } catch {
    context.skip('Git is not installed on this test host.')
    return null
  }
  const root = await mkdtemp(join(tmpdir(), 'relay-auto-land-test-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const seed = join(root, 'seed')
  await mkdir(seed)
  await git(['init', '-b', 'main'], { cwd: seed })
  await git(['config', 'user.name', 'Relay Test'], { cwd: seed })
  await git(['config', 'user.email', 'relay-test@example.invalid'], { cwd: seed })
  await writeFile(join(seed, 'shared.txt'), 'original\n')
  await git(['add', 'shared.txt'], { cwd: seed })
  await git(['commit', '-m', 'Initial commit'], { cwd: seed })
  const worktree = join(root, 'worktree')
  await git(['worktree', 'add', '-b', BRANCH, worktree], { cwd: seed })
  return { root, seed, worktree }
}

function workspaceFor(fixtureValue) {
  return {
    branch: BRANCH,
    canonicalProjectPath: fixtureValue.seed,
    repositoryPath: fixtureValue.worktree,
    projectPath: fixtureValue.worktree,
    shared: { repositoryPath: fixtureValue.seed },
  }
}

function noticeCollector() {
  const notices = []
  return { notices, onNotice: (code, message) => notices.push({ code, message }) }
}

async function commitBranchWork(fixtureValue, content = 'built by a chat\n') {
  await writeFile(join(fixtureValue.worktree, 'shared.txt'), content)
  await git(['add', 'shared.txt'], { cwd: fixtureValue.worktree })
  await git(['commit', '-m', 'Agent work'], { cwd: fixtureValue.worktree })
}

async function divergeBaseline(fixtureValue, content = 'baseline version\n') {
  await writeFile(join(fixtureValue.seed, 'shared.txt'), content)
  await git(['add', 'shared.txt'], { cwd: fixtureValue.seed })
  await git(['commit', '-m', 'Concurrent baseline change'], { cwd: fixtureValue.seed })
}

test('autoLandWorkspace lands a clean successful branch with the guarded non-force merge', async (context) => {
  const f = await fixture(context)
  if (!f) return
  await commitBranchWork(f)
  const { notices, onNotice } = noticeCollector()

  const result = await autoLandWorkspace(workspaceFor(f), { allowedRoots: [f.root], onNotice })

  assert.equal(result.landed, true)
  assert.equal(result.resolvedConflicts, false)
  assert.equal(await subjectOf(f.seed), `Ensync land: ${BRANCH}`)
  const landed = (await git(['show', 'HEAD:shared.txt'], { cwd: f.seed })).stdout
  assert.equal(landed, 'built by a chat\n')
  assert.deepEqual(notices.map((notice) => notice.code), ['agent_work_landed'])
})

test('autoLandWorkspace is silent when there is nothing to land', async (context) => {
  const f = await fixture(context)
  if (!f) return
  const { notices, onNotice } = noticeCollector()

  const result = await autoLandWorkspace(workspaceFor(f), { allowedRoots: [f.root], onNotice })

  assert.equal(result.landed, false)
  assert.equal(result.code, 'agent_branch_already_landed')
  assert.deepEqual(notices, [])
  assert.equal(await subjectOf(f.seed), 'Initial commit')
})

test('autoLandWorkspace skips landing into a dirty shared checkout and reports it', async (context) => {
  const f = await fixture(context)
  if (!f) return
  await commitBranchWork(f)
  await writeFile(join(f.seed, 'uncommitted.txt'), 'user work in progress\n')
  const { notices, onNotice } = noticeCollector()

  const result = await autoLandWorkspace(workspaceFor(f), { allowedRoots: [f.root], onNotice })

  assert.equal(result.landed, false)
  assert.equal(result.code, 'shared_checkout_dirty')
  assert.deepEqual(notices.map((notice) => notice.code), ['auto_land_skipped'])
  assert.equal(await subjectOf(f.seed), 'Initial commit')
})

test('autoLandWorkspace resolves a baseline conflict through the agent callback, verifies, and retries the land', async (context) => {
  const f = await fixture(context)
  if (!f) return
  await commitBranchWork(f, 'agent version\n')
  await divergeBaseline(f)
  const { notices, onNotice } = noticeCollector()
  let agentCall = null

  const result = await autoLandWorkspace(workspaceFor(f), {
    allowedRoots: [f.root],
    onNotice,
    runConflictAgent: async (details) => {
      agentCall = details
      assert.equal(await mergeHeadExists(f.worktree), true)
      await writeFile(join(f.worktree, 'shared.txt'), 'resolved\n')
      await git(['add', 'shared.txt'], { cwd: f.worktree })
    },
  })

  assert.equal(result.landed, true)
  assert.equal(result.resolvedConflicts, true)
  assert.deepEqual(agentCall.conflictFiles, ['shared.txt'])
  assert.equal(agentCall.branch, BRANCH)
  assert.deepEqual(notices.map((notice) => notice.code), ['auto_land_conflict', 'agent_work_landed'])
  assert.equal(await subjectOf(f.seed), `Ensync land: ${BRANCH}`)
  const landed = (await git(['show', 'HEAD:shared.txt'], { cwd: f.seed })).stdout
  assert.equal(landed, 'resolved\n')
  assert.equal(await subjectOf(f.worktree), `Ensync conflict resolution: merge ${agentCall.baselineSha} into ${BRANCH}`)
  assert.equal(await mergeHeadExists(f.worktree), false)
})

test('autoLandWorkspace accepts a conflict agent that concludes the merge itself', async (context) => {
  const f = await fixture(context)
  if (!f) return
  await commitBranchWork(f, 'agent version\n')
  await divergeBaseline(f)
  const { notices, onNotice } = noticeCollector()

  const result = await autoLandWorkspace(workspaceFor(f), {
    allowedRoots: [f.root],
    onNotice,
    runConflictAgent: async () => {
      await writeFile(join(f.worktree, 'shared.txt'), 'resolved by the agent\n')
      await git(['add', 'shared.txt'], { cwd: f.worktree })
      await git(['commit', '--no-verify', '--no-edit'], { cwd: f.worktree })
    },
  })

  assert.equal(result.landed, true)
  assert.equal(result.resolvedConflicts, true)
  assert.deepEqual(notices.map((notice) => notice.code), ['auto_land_conflict', 'agent_work_landed'])
  const landed = (await git(['show', 'HEAD:shared.txt'], { cwd: f.seed })).stdout
  assert.equal(landed, 'resolved by the agent\n')
})

test('autoLandWorkspace aborts the merge and leaves work unlanded when the conflict agent fails', async (context) => {
  const f = await fixture(context)
  if (!f) return
  await commitBranchWork(f, 'agent version\n')
  await divergeBaseline(f)
  const { notices, onNotice } = noticeCollector()

  const result = await autoLandWorkspace(workspaceFor(f), {
    allowedRoots: [f.root],
    onNotice,
    runConflictAgent: async () => {
      throw new Error('provider crashed')
    },
  })

  assert.equal(result.landed, false)
  assert.equal(result.code, 'conflict_resolution_failed')
  assert.deepEqual(notices.map((notice) => notice.code), ['auto_land_conflict', 'auto_land_failed'])
  assert.match(notices[1].message, /provider crashed/)
  assert.equal(await mergeHeadExists(f.worktree), false)
  const status = (await git(['status', '--porcelain'], { cwd: f.worktree })).stdout.trim()
  assert.equal(status, '')
  assert.equal(await subjectOf(f.worktree), 'Agent work')
  assert.equal(await subjectOf(f.seed), 'Concurrent baseline change')
})

test('autoLandWorkspace refuses to land a resolution that still contains conflict markers', async (context) => {
  const f = await fixture(context)
  if (!f) return
  await commitBranchWork(f, 'agent version\n')
  await divergeBaseline(f)
  const { notices, onNotice } = noticeCollector()

  const result = await autoLandWorkspace(workspaceFor(f), {
    allowedRoots: [f.root],
    onNotice,
    runConflictAgent: async () => {
      await writeFile(
        join(f.worktree, 'shared.txt'),
        '<<<<<<< HEAD\nagent version\n=======\nbaseline version\n>>>>>>> abc1234\n',
      )
      await git(['add', 'shared.txt'], { cwd: f.worktree })
    },
  })

  assert.equal(result.landed, false)
  assert.equal(result.code, 'conflict_resolution_unverified')
  assert.deepEqual(notices.map((notice) => notice.code), ['auto_land_conflict', 'auto_land_failed'])
  assert.match(notices[1].message, /Conflict markers/)
  assert.equal(await mergeHeadExists(f.worktree), false)
  assert.equal(await subjectOf(f.worktree), 'Agent work')
  assert.equal(await subjectOf(f.seed), 'Concurrent baseline change')
})

function statusServiceFor(provider) {
  return {
    async get(id, options) {
      assert.equal(id, provider.id)
      assert.deepEqual(options, { refresh: true })
      return provider
    },
  }
}

function readyClaude() {
  return {
    id: 'claude',
    name: 'Claude Code',
    installed: true,
    executable: '/test/bin/claude',
    authentication: {
      state: 'authenticated',
      method: 'claude.ai OAuth',
      reason: 'claude is logged in.',
    },
  }
}

function claudeStdout(text) {
  return JSON.stringify({
    type: 'result',
    is_error: false,
    result: text,
    session_id: '123e4567-e89b-12d3-a456-426614174000',
  })
}

async function isolationFixture(context) {
  const f = await fixture(context)
  if (!f) return null
  // The end-to-end tests drive ChatRunService itself, so the protected
  // worktree comes from ProjectIsolationService rather than the unit fixture.
  await git(['worktree', 'remove', '--force', f.worktree], { cwd: f.seed })
  await git(['branch', '-D', BRANCH], { cwd: f.seed })
  return {
    ...f,
    isolation: new ProjectIsolationService({ rootPath: join(f.root, 'workspaces') }),
  }
}

test('a verified successful local run lands its work automatically', async (context) => {
  const f = await isolationFixture(context)
  if (!f) return
  const service = new ChatRunService({
    statusService: statusServiceFor(readyClaude()),
    allowedRoots: [f.root],
    projectIsolation: f.isolation,
    processRunner: async (_executable, _args, options) => {
      await writeFile(join(options.cwd, 'agent-note.txt'), 'from agent\n')
      return { exitCode: 0, error: null, timedOut: false, stderr: '', stdout: claudeStdout('done') }
    },
  })
  const events = []

  const result = await service.run(
    { provider: 'claude', projectPath: f.seed, prompt: 'do work', workspaceKey: 'conversation:autoland-clean' },
    { onEvent: (event) => events.push(event) },
  )

  assert.equal(result.response, 'done')
  const codes = events.filter((event) => event.type === 'notice').map((event) => event.code)
  assert.equal(codes.includes('agent_work_committed'), true)
  assert.equal(codes.includes('agent_work_landed'), true)
  assert.match(await subjectOf(f.seed), /^Ensync land: ensync\/chat-[a-f0-9]{24}$/)
  const landed = (await git(['show', 'HEAD:agent-note.txt'], { cwd: f.seed })).stdout
  assert.equal(landed, 'from agent\n')
})

test('a baseline that moves mid-run is auto-resolved by a conflict-resolution agent run and then landed', async (context) => {
  const f = await isolationFixture(context)
  if (!f) return
  const runnerCalls = []
  const service = new ChatRunService({
    statusService: statusServiceFor(readyClaude()),
    allowedRoots: [f.root],
    projectIsolation: f.isolation,
    processRunner: async (_executable, _args, options) => {
      if (typeof options.input === 'string' && options.input.includes('[ENSYNC HOST CONFLICT RESOLUTION]')) {
        runnerCalls.push('conflict-resolution')
        await writeFile(join(options.cwd, 'shared.txt'), 'resolved by agent\n')
        await git(['add', 'shared.txt'], { cwd: options.cwd })
        return { exitCode: 0, error: null, timedOut: false, stderr: '', stdout: claudeStdout('conflicts resolved') }
      }
      runnerCalls.push('chat')
      await writeFile(join(options.cwd, 'shared.txt'), 'agent version\n')
      await divergeBaseline(f)
      return { exitCode: 0, error: null, timedOut: false, stderr: '', stdout: claudeStdout('done') }
    },
  })
  const events = []

  await service.run(
    { provider: 'claude', projectPath: f.seed, prompt: 'do work', workspaceKey: 'conversation:autoland-conflict' },
    { onEvent: (event) => events.push(event) },
  )

  assert.deepEqual(runnerCalls, ['chat', 'conflict-resolution'])
  const codes = events.filter((event) => event.type === 'notice').map((event) => event.code)
  assert.equal(codes.includes('auto_land_conflict'), true)
  assert.equal(codes.includes('agent_work_landed'), true)
  assert.match(await subjectOf(f.seed), /^Ensync land: ensync\/chat-[a-f0-9]{24}$/)
  const landed = (await git(['show', 'HEAD:shared.txt'], { cwd: f.seed })).stdout
  assert.equal(landed, 'resolved by agent\n')
})

test('a failed local run commits its work but never lands automatically', async (context) => {
  const f = await isolationFixture(context)
  if (!f) return
  const service = new ChatRunService({
    statusService: statusServiceFor(readyClaude()),
    allowedRoots: [f.root],
    projectIsolation: f.isolation,
    processRunner: async (_executable, _args, options) => {
      await writeFile(join(options.cwd, 'partial.txt'), 'incomplete\n')
      return { exitCode: 1, error: null, timedOut: false, stderr: 'provider exploded', stdout: '' }
    },
  })
  const events = []

  await assert.rejects(service.run(
    { provider: 'claude', projectPath: f.seed, prompt: 'do work', workspaceKey: 'conversation:autoland-failed' },
    { onEvent: (event) => events.push(event) },
  ))

  const codes = events.filter((event) => event.type === 'notice').map((event) => event.code)
  assert.equal(codes.includes('agent_work_committed'), true)
  assert.equal(codes.includes('agent_work_landed'), false)
  assert.equal(codes.includes('auto_land_conflict'), false)
  assert.equal(await subjectOf(f.seed), 'Initial commit')
})

test('automatic landing can be disabled per service', async (context) => {
  const f = await isolationFixture(context)
  if (!f) return
  const service = new ChatRunService({
    statusService: statusServiceFor(readyClaude()),
    allowedRoots: [f.root],
    projectIsolation: f.isolation,
    autoLand: false,
    processRunner: async (_executable, _args, options) => {
      await writeFile(join(options.cwd, 'agent-note.txt'), 'from agent\n')
      return { exitCode: 0, error: null, timedOut: false, stderr: '', stdout: claudeStdout('done') }
    },
  })
  const events = []

  await service.run(
    { provider: 'claude', projectPath: f.seed, prompt: 'do work', workspaceKey: 'conversation:autoland-disabled' },
    { onEvent: (event) => events.push(event) },
  )

  const codes = events.filter((event) => event.type === 'notice').map((event) => event.code)
  assert.equal(codes.includes('agent_work_committed'), true)
  assert.equal(codes.includes('agent_work_landed'), false)
  assert.equal(await subjectOf(f.seed), 'Initial commit')
})

test('a run request can opt out of automatic landing', async (context) => {
  const f = await isolationFixture(context)
  if (!f) return
  const service = new ChatRunService({
    statusService: statusServiceFor(readyClaude()),
    allowedRoots: [f.root],
    projectIsolation: f.isolation,
    processRunner: async (_executable, _args, options) => {
      await writeFile(join(options.cwd, 'agent-note.txt'), 'from agent\n')
      return { exitCode: 0, error: null, timedOut: false, stderr: '', stdout: claudeStdout('done') }
    },
  })
  const events = []

  await service.run(
    { provider: 'claude', projectPath: f.seed, prompt: 'do work', workspaceKey: 'conversation:autoland-request-opt-out', autoLand: false },
    { onEvent: (event) => events.push(event) },
  )

  const codes = events.filter((event) => event.type === 'notice').map((event) => event.code)
  assert.equal(codes.includes('agent_work_committed'), true)
  assert.equal(codes.includes('agent_work_landed'), false)
  assert.equal(await subjectOf(f.seed), 'Initial commit')
})

test('a run request cannot re-enable automatic landing disabled host-wide', async (context) => {
  const f = await isolationFixture(context)
  if (!f) return
  const service = new ChatRunService({
    statusService: statusServiceFor(readyClaude()),
    allowedRoots: [f.root],
    projectIsolation: f.isolation,
    autoLand: false,
    processRunner: async (_executable, _args, options) => {
      await writeFile(join(options.cwd, 'agent-note.txt'), 'from agent\n')
      return { exitCode: 0, error: null, timedOut: false, stderr: '', stdout: claudeStdout('done') }
    },
  })
  const events = []

  await service.run(
    { provider: 'claude', projectPath: f.seed, prompt: 'do work', workspaceKey: 'conversation:autoland-request-no-override', autoLand: true },
    { onEvent: (event) => events.push(event) },
  )

  const codes = events.filter((event) => event.type === 'notice').map((event) => event.code)
  assert.equal(codes.includes('agent_work_committed'), true)
  assert.equal(codes.includes('agent_work_landed'), false)
  assert.equal(await subjectOf(f.seed), 'Initial commit')
})
