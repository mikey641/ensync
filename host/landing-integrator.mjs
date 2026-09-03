import { randomUUID } from 'node:crypto'
import { relative, resolve, sep } from 'node:path'

import { runGit } from './git.mjs'
import { runLandQuickCheck } from './land-check.mjs'

const MAX_ERROR_LENGTH = 4_096
const DEFAULT_RESOLUTION_TIMEOUT_MS = 2 * 60_000
const CONFLICT_MARKER_PATTERN = '^(<{7}|>{7})( |$)'
const ZERO_SHA = '0'.repeat(40)

function bounded(value) {
  return String(value ?? 'Automatic integration failed.').slice(0, MAX_ERROR_LENGTH)
}

function firstLine(value) {
  return String(value ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? ''
}

function safeRefPart(value) {
  const safe = String(value ?? '').replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 96)
  return safe || randomUUID()
}

function isWithinRepository(repositoryPath, projectPath) {
  const child = relative(repositoryPath, projectPath)
  return child === '' || (child !== '..' && !child.startsWith(`..${sep}`))
}

function resultFor(train, landedIds, retryIds, errors, head = null) {
  const order = new Map(train.map((item) => [item.id, item.completionSequence]))
  const sorted = (ids) => [...ids].sort((left, right) => order.get(left) - order.get(right))
  return {
    landedIds: sorted(landedIds),
    retryIds: sorted(retryIds),
    errors,
    head,
  }
}

export class LandingIntegrator {
  constructor(options = {}) {
    if (!options.client || typeof options.client.create !== 'function') {
      throw new TypeError('LandingIntegrator requires an agent-worktree client.')
    }
    this.client = options.client
    this.gitRunner = options.gitRunner ?? runGit
    this.runQuickCheck = options.runQuickCheck ?? runLandQuickCheck
    this.idFactory = options.idFactory ?? randomUUID
    this.gitExecutable = options.gitExecutable
    this.resolutionTimeoutMs = options.resolutionTimeoutMs ?? DEFAULT_RESOLUTION_TIMEOUT_MS
  }

  async integrate(entries, options = {}) {
    const train = [...entries].sort((left, right) => left.completionSequence - right.completionSequence)
    if (train.length === 0) return resultFor([], [], [], {}, null)
    const repositoryPath = train[0].repositoryPath
    if (train.some((item) => item.repositoryPath !== repositoryPath)) {
      throw new TypeError('A landing train cannot cross repository boundaries.')
    }
    if (new Set(train.map((item) => item.id)).size !== train.length) {
      throw new TypeError('A landing train cannot contain duplicate item IDs.')
    }
    if (train.some((item) => !isWithinRepository(repositoryPath, item.projectPath))) {
      throw new TypeError('A landing project path must stay inside its repository.')
    }

    const landedIds = new Set()
    const retryIds = new Set()
    const errors = {}
    const retry = (item, reason) => {
      retryIds.add(item.id)
      errors[item.id] = bounded(reason)
    }
    const retryMany = (items, reason) => {
      for (const item of items) retry(item, reason)
    }

    const initialStatus = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repositoryPath)
    if (initialStatus.exitCode !== 0 || initialStatus.stdout.split('\0').filter(Boolean).length > 0) {
      retryMany(train, 'The canonical checkout has unsaved changes; automatic integration left it untouched.')
      return resultFor(train, landedIds, retryIds, errors)
    }
    const targetResult = await this.#git(['symbolic-ref', '--quiet', '--short', 'HEAD'], repositoryPath)
    const target = targetResult.exitCode === 0 ? firstLine(targetResult.stdout) : null
    if (!target) {
      retryMany(train, 'The canonical checkout has no current branch; automatic integration left it untouched.')
      return resultFor(train, landedIds, retryIds, errors)
    }
    const originalHeadResult = await this.#git(['rev-parse', '--verify', target], repositoryPath)
    const originalHead = originalHeadResult.exitCode === 0 ? firstLine(originalHeadResult.stdout) : null
    if (!originalHead) {
      retryMany(train, `Git could not read the automatic landing target ${target}.`)
      return resultFor(train, landedIds, retryIds, errors)
    }

    const integrationBranch = `ensync/landing-trains/${safeRefPart(this.idFactory())}`
    let integration = null
    const accepted = []
    try {
      integration = await this.client.create({ repositoryPath, branch: integrationBranch, base: target })

      for (const item of train) {
        const available = await this.#git(['cat-file', '-e', `${item.savedSha}^{commit}`], repositoryPath)
        if (available.exitCode !== 0) {
          retry(item, `The saved commit ${item.savedSha} is unavailable; the source chat branch was not substituted.`)
          continue
        }

        const itemBranch = `ensync/landing-items/${safeRefPart(item.id)}`
        const prepared = await this.#prepareImmutableBranch(repositoryPath, itemBranch, item.savedSha)
        if (!prepared.ok) {
          retry(item, prepared.reason)
          continue
        }

        const applied = await this.#applyItem({
          integration,
          item,
          itemBranch,
          resolveConflict: options.resolveConflict,
        })
        if (!applied.ok) {
          retry(item, applied.reason)
          if (!applied.safeToContinue) {
            retryMany(train.filter((candidate) => (
              candidate.completionSequence > item.completionSequence && !retryIds.has(candidate.id)
            )), 'The integration worktree could not be restored after a failed item; its target remained unchanged.')
            break
          }
          continue
        }
        accepted.push({ item, itemBranch })
      }

      if (accepted.length === 0) return resultFor(train, landedIds, retryIds, errors)

      const structural = await this.#git(['diff', '--check', `${originalHead}...HEAD`], integration.path)
      const unmerged = await this.#unmergedFiles(integration.path)
      if (structural.exitCode !== 0 || unmerged.length > 0) {
        const detail = firstLine(structural.stdout)
          || firstLine(structural.stderr)
          || `unmerged paths remain: ${unmerged.join(', ')}`
        retryMany(accepted.map(({ item }) => item), `The dependency-free structural check failed: ${detail}`)
        return resultFor(train, landedIds, retryIds, errors)
      }

      const checkPaths = new Set(accepted.map(({ item }) => resolve(
        integration.path,
        relative(repositoryPath, item.projectPath),
      )))
      for (const checkPath of checkPaths) {
        const check = await this.runQuickCheck(checkPath, options.quickCheckOptions)
        if (!check?.ok) {
          const detail = [check?.reason, check?.output].filter(Boolean).join(' ')
          retryMany(accepted.map(({ item }) => item), detail || 'The repository quick check failed.')
          return resultFor(train, landedIds, retryIds, errors)
        }
      }

      const [currentHead, finalStatus] = await Promise.all([
        this.#git(['rev-parse', '--verify', target], repositoryPath),
        this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repositoryPath),
      ])
      if (
        currentHead.exitCode !== 0
        || firstLine(currentHead.stdout) !== originalHead
        || finalStatus.exitCode !== 0
        || finalStatus.stdout.split('\0').filter(Boolean).length > 0
      ) {
        retryMany(accepted.map(({ item }) => item), 'The landing target changed while the train was integrating; the saved snapshots will retry on the new target.')
        return resultFor(train, landedIds, retryIds, errors)
      }

      let published
      try {
        published = await this.client.merge({
          repositoryPath,
          worktreePath: integration.path,
          into: target,
          strategy: 'merge',
          delete: true,
          skipHooks: true,
        })
      } catch (error) {
        retryMany(accepted.map(({ item }) => item), error instanceof Error ? error.message : error)
        return resultFor(train, landedIds, retryIds, errors)
      }
      if (published?.disposition === 'conflict') {
        retryMany(accepted.map(({ item }) => item), published.stderr || 'The target changed and the final publish conflicted.')
        return resultFor(train, landedIds, retryIds, errors)
      }
      integration = null
      for (const { item, itemBranch } of accepted) {
        landedIds.add(item.id)
        await this.#git(['branch', '--delete', itemBranch], repositoryPath)
      }
      const publishedHead = await this.#git(['rev-parse', '--verify', target], repositoryPath)
      return resultFor(train, landedIds, retryIds, errors, firstLine(publishedHead.stdout) || null)
    } catch (error) {
      retryMany(
        train.filter((item) => !retryIds.has(item.id) && !landedIds.has(item.id)),
        error instanceof Error ? error.message : error,
      )
      return resultFor(train, landedIds, retryIds, errors)
    } finally {
      if (integration) {
        await this.client.remove({ repositoryPath, branch: integrationBranch }).catch(() => {})
      }
    }
  }

  async #prepareImmutableBranch(repositoryPath, branch, savedSha) {
    const existing = await this.#git(['rev-parse', '--verify', `refs/heads/${branch}`], repositoryPath)
    if (existing.exitCode === 0) {
      return firstLine(existing.stdout) === savedSha
        ? { ok: true }
        : { ok: false, reason: `The preserved landing ref ${branch} no longer names the saved commit.` }
    }
    const created = await this.#git(
      ['update-ref', `refs/heads/${branch}`, savedSha, ZERO_SHA],
      repositoryPath,
    )
    return created.exitCode === 0
      ? { ok: true }
      : { ok: false, reason: firstLine(created.stderr) || `Git could not preserve saved commit ${savedSha}.` }
  }

  async #applyItem({ integration, item, itemBranch, resolveConflict }) {
    try {
      await this.client.sync({
        worktreePath: integration.path,
        from: itemBranch,
        strategy: 'merge',
      })
      return { ok: true, safeToContinue: true }
    } catch (error) {
      const conflictFiles = await this.#unmergedFiles(integration.path)
      if (conflictFiles.length === 0) {
        const restored = await this.#abortIfNeeded(integration.path)
        return {
          ok: false,
          safeToContinue: restored,
          reason: error instanceof Error ? error.message : 'agent-worktree could not apply the saved snapshot.',
        }
      }
      if (typeof resolveConflict !== 'function') {
        const restored = await this.#abortIfNeeded(integration.path)
        return {
          ok: false,
          safeToContinue: restored,
          reason: `Automatic integration found conflicts in: ${conflictFiles.join(', ')}. The saved snapshot will retry automatically.`,
        }
      }

      try {
        await this.#boundedResolution(resolveConflict, {
          item: { ...item },
          worktreePath: integration.path,
          projectPath: resolve(integration.path, relative(item.repositoryPath, item.projectPath)),
          conflictFiles: [...conflictFiles],
        })
        const markers = await this.#git(
          ['grep', '-l', '-E', CONFLICT_MARKER_PATTERN, '--', ...conflictFiles],
          integration.path,
        )
        if (markers.exitCode === 0) {
          throw new Error(`Conflict markers remain in: ${markers.stdout.split(/\r?\n/).filter(Boolean).join(', ')}.`, { cause: error })
        }
        if (await this.#mergeInProgress(integration.path)) {
          const staged = await this.#git(['add', '--', ...conflictFiles], integration.path)
          if (staged.exitCode !== 0) throw new Error(firstLine(staged.stderr) || 'Git could not stage the resolved conflict files.', { cause: error })
          const unresolved = await this.#unmergedFiles(integration.path)
          if (unresolved.length > 0) throw new Error(`Conflicts remain unresolved in: ${unresolved.join(', ')}.`, { cause: error })
          await this.client.continueSync({ worktreePath: integration.path })
        }
        const contained = await this.#git(
          ['merge-base', '--is-ancestor', item.savedSha, 'HEAD'],
          integration.path,
        )
        if (contained.exitCode !== 0) throw new Error('The conflict resolution did not retain the exact saved commit.', { cause: error })
        return { ok: true, safeToContinue: true }
      } catch (resolutionError) {
        const restored = await this.#abortIfNeeded(integration.path)
        return {
          ok: false,
          safeToContinue: restored,
          reason: resolutionError instanceof Error ? resolutionError.message : resolutionError,
        }
      }
    }
  }

  async #boundedResolution(resolveConflict, details) {
    const controller = new AbortController()
    let timer
    const resolution = Promise.resolve().then(() => resolveConflict({ ...details, signal: controller.signal }))
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        controller.abort()
        reject(new Error('Automatic conflict resolution timed out.'))
      }, this.resolutionTimeoutMs)
    })
    try {
      await Promise.race([resolution, timeout])
    } finally {
      clearTimeout(timer)
    }
  }

  async #mergeInProgress(worktreePath) {
    const result = await this.#git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], worktreePath)
    return result.exitCode === 0
  }

  async #unmergedFiles(worktreePath) {
    const result = await this.#git(['diff', '--name-only', '--diff-filter=U'], worktreePath)
    if (result.exitCode !== 0) return []
    return result.stdout.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)
  }

  async #abortIfNeeded(worktreePath) {
    if (!(await this.#mergeInProgress(worktreePath))) return true
    try {
      await this.client.abortSync({ worktreePath })
      return !(await this.#mergeInProgress(worktreePath))
    } catch {
      return false
    }
  }

  #git(args, cwd) {
    return this.gitRunner(args, {
      cwd,
      gitExecutable: this.gitExecutable,
      timeoutMs: 30_000,
    })
  }
}
