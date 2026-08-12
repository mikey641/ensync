import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, readlink, rename, unlink, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

import { runGit } from './git.mjs'

const SCHEMA_VERSION = 1
const AGENT_BRANCH_PATTERN = /^ensync\/chat-([a-f0-9]{24})$/
const DEFAULT_POLL_MS = 1_000
const DEFAULT_STALE_MS = 15_000
const MAX_PATHS = 200
const MAX_PATH_LENGTH = 4_096

function uniqueSorted(values) {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right))
}

function normalizedGitPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_PATH_LENGTH) return null
  const normalized = value.replaceAll('\\', '/')
  if (normalized.startsWith('/') || /^[A-Za-z]:\//.test(normalized) || /[\0\r\n]/.test(normalized)) return null
  const parts = normalized.split('/')
  if (parts.some((part) => !part || part === '.' || part === '..')) return null
  return normalized
}

function porcelainPaths(output) {
  const entries = String(output).split('\0')
  const paths = []
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]
    if (!entry || entry.length < 4) continue
    const status = entry.slice(0, 2)
    const path = normalizedGitPath(entry.slice(3))
    if (path) paths.push(path)
    if (/[RC]/.test(status)) {
      const original = normalizedGitPath(entries[index + 1])
      if (original) paths.push(original)
      index += 1
    }
  }
  return uniqueSorted(paths)
}

function linePaths(output) {
  return uniqueSorted(String(output).split(/\r?\n/).map(normalizedGitPath).filter(Boolean))
}

function intersection(left, right) {
  const rightSet = new Set(right)
  return left.filter((path) => rightSet.has(path))
}

function recordKey(branch) {
  const match = AGENT_BRANCH_PATTERN.exec(branch)
  return match?.[1] ?? createHash('sha256').update(String(branch)).digest('hex').slice(0, 24)
}

function overlapKey(overlap) {
  return `${overlap.source}:${overlap.peerBranch}`
}

function displayPaths(paths) {
  const visible = paths.slice(0, 3).map((path) => `\`${path}\``).join(', ')
  const remaining = paths.length - Math.min(paths.length, 3)
  return `${visible}${remaining > 0 ? ` and ${remaining} other file${remaining === 1 ? '' : 's'}` : ''}`
}

function overlapEvent(overlap, state, now) {
  const active = state === 'detected'
  const sourceText = overlap.source === 'active'
    ? 'is editing'
    : 'has unlanded changes in'
  return {
    type: 'notice',
    code: active ? 'workspace_file_overlap_detected' : 'workspace_file_overlap_cleared',
    message: active
      ? `Another Ensync conversation ${sourceText} ${displayPaths(overlap.paths)}. Work can continue; Ensync will recheck before landing.`
      : `The file overlap with ${overlap.peerBranch} is no longer active.`,
    overlap: {
      peerBranch: overlap.peerBranch,
      state,
      source: overlap.source,
      paths: active ? [...overlap.paths] : [],
      totalCount: active ? overlap.totalCount : 0,
    },
    at: new Date(now).toISOString(),
  }
}

async function fingerprint(root, path) {
  const absolute = join(root, ...path.split('/'))
  try {
    const info = await lstat(absolute)
    if (info.isSymbolicLink()) return `link:${await readlink(absolute)}`
    if (!info.isFile()) return `other:${info.mode}:${info.size}`
    const bytes = await readFile(absolute)
    return `file:${createHash('sha256').update(bytes).digest('hex')}`
  } catch (error) {
    if (error?.code === 'ENOENT') return 'missing'
    throw error
  }
}

function validRecord(value, now, staleMs) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.schemaVersion !== SCHEMA_VERSION
    || typeof value.token !== 'string' || value.token.length < 8 || value.token.length > 128
    || typeof value.jobId !== 'string' || value.jobId.length < 1 || value.jobId.length > 128
    || typeof value.branch !== 'string' || !AGENT_BRANCH_PATTERN.test(value.branch)
    || typeof value.updatedAt !== 'string'
    || !Array.isArray(value.paths) || value.paths.length > MAX_PATHS) return null
  const updatedAt = Date.parse(value.updatedAt)
  if (!Number.isFinite(updatedAt) || updatedAt > now + staleMs || now - updatedAt > staleMs) return null
  const paths = value.paths.map(normalizedGitPath)
  if (paths.some((path) => path === null)) return null
  return { ...value, paths: uniqueSorted(paths) }
}

export class WorkspaceOverlapMonitor {
  #gitRunner
  #pollMs
  #staleMs
  #now
  #uuid
  #setInterval
  #clearInterval

  constructor(options = {}) {
    this.#gitRunner = options.gitRunner ?? runGit
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS
    this.#staleMs = options.staleMs ?? DEFAULT_STALE_MS
    this.#now = options.now ?? Date.now
    this.#uuid = options.randomUUID ?? randomUUID
    this.#setInterval = options.setInterval ?? setInterval
    this.#clearInterval = options.clearInterval ?? clearInterval
  }

  async #git(cwd, args, options = {}) {
    const result = await this.#gitRunner(args, { cwd })
    if (result.exitCode !== 0 && !options.allowFailure) {
      throw new Error(result.stderr.trim() || `Git could not inspect workspace overlap (${args[0]}).`)
    }
    return result
  }

  #recordsDirectory(workspace) {
    if (typeof workspace?.commonGitDirectory !== 'string' || !isAbsolute(workspace.commonGitDirectory)) {
      throw new TypeError('Workspace overlap monitoring requires an absolute Git common directory.')
    }
    return join(workspace.commonGitDirectory, 'ensync', 'active-workspace-edits')
  }

  async #statusPaths(worktreePath) {
    const status = await this.#git(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
    return porcelainPaths(status.stdout)
  }

  async #snapshot(workspace) {
    const paths = await this.#statusPaths(workspace.repositoryPath)
    const entries = await Promise.all(paths.map(async (path) => [path, await fingerprint(workspace.repositoryPath, path)]))
    return new Map(entries)
  }

  async #changedSince(workspace, baseline) {
    const currentPaths = await this.#statusPaths(workspace.repositoryPath)
    const currentSet = new Set(currentPaths)
    const candidates = uniqueSorted([...baseline.keys(), ...currentPaths])
    const changed = []
    for (const path of candidates) {
      if (!baseline.has(path) || !currentSet.has(path)) {
        changed.push(path)
        continue
      }
      if (await fingerprint(workspace.repositoryPath, path) !== baseline.get(path)) changed.push(path)
    }
    return changed.slice(0, MAX_PATHS)
  }

  async #branchPaths(workspace, branch, baseline) {
    const diff = await this.#git(
      workspace.shared.repositoryPath,
      ['diff', '--name-only', `${baseline}...${branch}`],
      { allowFailure: true },
    )
    return diff.exitCode === 0 ? linePaths(diff.stdout).slice(0, MAX_PATHS) : []
  }

  async #baseline(workspace) {
    const result = await this.#git(workspace.shared.repositoryPath, ['rev-parse', '--verify', 'HEAD'])
    return result.stdout.trim().split(/\r?\n/, 1)[0]
  }

  async #records(workspace, self = {}) {
    const directory = this.#recordsDirectory(workspace)
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error?.code === 'ENOENT') return []
      throw error
    }
    const records = []
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      try {
        const parsed = JSON.parse(await readFile(join(directory, entry.name), 'utf8'))
        const record = validRecord(parsed, this.#now(), this.#staleMs)
        if (!record || record.token === self.token || record.branch === workspace.branch) continue
        records.push(record)
      } catch {
        // Advisory records are untrusted local metadata; malformed peers are ignored.
      }
    }
    return records
  }

  async inspect(workspace, options = {}) {
    const baseline = await this.#baseline(workspace)
    const ownBranchPaths = await this.#branchPaths(workspace, workspace.branch, baseline)
    const ownPaths = uniqueSorted([...(options.ownPaths ?? ownBranchPaths), ...ownBranchPaths]).slice(0, MAX_PATHS)
    if (ownPaths.length === 0) return []

    const overlaps = []
    const activeBranches = new Set()
    for (const record of await this.#records(workspace, { token: options.selfToken })) {
      const paths = intersection(ownPaths, record.paths)
      if (paths.length === 0) continue
      activeBranches.add(record.branch)
      overlaps.push({ peerBranch: record.branch, source: 'active', paths, totalCount: paths.length })
    }

    const refs = await this.#git(
      workspace.shared.repositoryPath,
      ['for-each-ref', 'refs/heads/ensync/chat-*', '--format=%(refname:short)'],
    )
    for (const peerBranch of refs.stdout.split(/\r?\n/).filter((branch) => AGENT_BRANCH_PATTERN.test(branch))) {
      if (peerBranch === workspace.branch || activeBranches.has(peerBranch)) continue
      const ahead = await this.#git(
        workspace.shared.repositoryPath,
        ['rev-list', '--count', `${baseline}..${peerBranch}`],
        { allowFailure: true },
      )
      if (ahead.exitCode !== 0 || Number.parseInt(ahead.stdout.trim(), 10) < 1) continue
      const paths = intersection(ownPaths, await this.#branchPaths(workspace, peerBranch, baseline))
      if (paths.length > 0) overlaps.push({ peerBranch, source: 'unlanded', paths, totalCount: paths.length })
    }
    return overlaps.sort((left, right) => overlapKey(left).localeCompare(overlapKey(right)))
  }

  async start(workspace, options = {}) {
    if (typeof options.jobId !== 'string' || !options.jobId || options.jobId.length > 128) {
      throw new TypeError('Workspace overlap monitoring requires a bounded job ID.')
    }
    const baseline = await this.#snapshot(workspace)
    const directory = this.#recordsDirectory(workspace)
    const recordPath = join(directory, `${recordKey(workspace.branch)}.json`)
    const token = this.#uuid()
    const currentOverlaps = new Map()
    let stopped = false
    let failureReported = false
    let operation = Promise.resolve([])

    const writeRecord = async (paths) => {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const record = {
        schemaVersion: SCHEMA_VERSION,
        token,
        jobId: options.jobId,
        branch: workspace.branch,
        updatedAt: new Date(this.#now()).toISOString(),
        paths: uniqueSorted(paths).slice(0, MAX_PATHS),
      }
      const temporaryPath = `${recordPath}.tmp-${this.#uuid()}`
      await writeFile(temporaryPath, `${JSON.stringify(record)}\n`, { mode: 0o600 })
      await rename(temporaryPath, recordPath)
    }

    const emitTransitions = (next) => {
      const nextMap = new Map(next.map((overlap) => [overlapKey(overlap), overlap]))
      for (const [key, overlap] of nextMap) {
        const previous = currentOverlaps.get(key)
        if (!previous || JSON.stringify(previous.paths) !== JSON.stringify(overlap.paths)) {
          options.onEvent?.(overlapEvent(overlap, 'detected', this.#now()))
        }
      }
      for (const [key, overlap] of currentOverlaps) {
        if (!nextMap.has(key)) options.onEvent?.(overlapEvent(overlap, 'cleared', this.#now()))
      }
      currentOverlaps.clear()
      for (const [key, overlap] of nextMap) currentOverlaps.set(key, overlap)
    }

    const refreshNow = async () => {
      if (stopped || options.signal?.aborted) return [...currentOverlaps.values()]
      const paths = await this.#changedSince(workspace, baseline)
      await writeRecord(paths)
      const overlaps = await this.inspect(workspace, { ownPaths: paths, selfToken: token })
      emitTransitions(overlaps)
      return overlaps
    }

    const refresh = () => {
      operation = operation.then(refreshNow, refreshNow).catch((error) => {
        if (!failureReported) {
          failureReported = true
          options.onEvent?.({
            type: 'notice',
            code: 'workspace_overlap_unavailable',
            message: `Ensync could not refresh cross-conversation file awareness: ${error instanceof Error ? error.message : 'unknown error'}. Protected workspace isolation remains active.`,
            at: new Date(this.#now()).toISOString(),
          })
        }
        return [...currentOverlaps.values()]
      })
      return operation
    }

    const timer = this.#setInterval(() => { void refresh() }, this.#pollMs)
    timer?.unref?.()
    await refresh()

    return {
      current: () => [...currentOverlaps.values()].map((overlap) => ({ ...overlap, paths: [...overlap.paths] })),
      refresh,
      stop: async () => {
        if (stopped) return
        stopped = true
        this.#clearInterval(timer)
        await operation.catch(() => {})
        try {
          const record = JSON.parse(await readFile(recordPath, 'utf8'))
          if (record?.token === token) await unlink(recordPath)
        } catch (error) {
          if (error?.code !== 'ENOENT') throw error
        }
      },
    }
  }
}
