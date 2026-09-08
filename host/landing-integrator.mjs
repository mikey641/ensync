import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

import { runGit } from './git.mjs'

const MAX_ERROR_LENGTH = 4_096
const DEFAULT_RESOLUTION_SHUTDOWN_TIMEOUT_MS = 5_000
const CONFLICT_MARKER_PATTERN = '^(<{7}|>{7})( |$)'
const MARKER_ONLY_WHITESPACE_RULES = '-blank-at-eol,-blank-at-eof,-space-before-tab,-indent-with-non-tab,-tab-in-indent'
const MAX_CONFLICT_FILES = 128
const MAX_CONFLICT_PATH_BYTES = 32 * 1024
const MAX_COMMIT_SUBJECT = 100
const MAX_COMMIT_PATHS = 24

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

function cleanCommitText(value, maximum = MAX_COMMIT_SUBJECT) {
  const cleaned = String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  if (cleaned.length <= maximum) return cleaned
  return `${cleaned.slice(0, Math.max(1, maximum - 1)).trimEnd()}…`
}

function isInternalCommitSubject(subject) {
  return !subject
    || /^Ensync (?:agent work|automatic landing)\b/i.test(subject)
    || /ensync\/(?:chat|landing-(?:items|trains))\b/i.test(subject)
}

function humanizeArea(value) {
  const words = cleanCommitText(value, 80)
    .replace(/\.(?:test|spec)$/i, '')
    .replace(/[-_.]+/g, ' ')
    .replace(/\bdocuseal\b/gi, 'DocuSeal')
    .replace(/\bapi\b/gi, 'API')
    .replace(/\bui\b/gi, 'UI')
  return words.trim()
}

function areaForPath(path) {
  const safePath = cleanCommitText(path, 512).replaceAll('\\', '/')
  const segments = safePath.split('/').filter(Boolean)
  if (segments.length === 0) return null
  if (segments[0] === 'supabase' && segments[1] === 'migrations') return 'database migrations'
  let stem = segments.at(-1).replace(/\.[^.]+$/, '').replace(/\.(?:test|spec)$/i, '')
  if (['index', 'route', 'page', 'layout'].includes(stem.toLowerCase()) && segments.length > 1) {
    const parent = segments.at(-2)
    const grandparent = segments.at(-3)
    stem = ['route', 'page'].includes(stem.toLowerCase()) && grandparent
      ? `${grandparent} ${parent}`
      : parent
  }
  return humanizeArea(stem)
}

function readableList(values) {
  if (values.length < 2) return values[0] ?? ''
  if (values.length === 2) return `${values[0]} and ${values[1]}`
  return `${values.slice(0, -1).join(', ')}, and ${values.at(-1)}`
}

function fallbackSubject(paths) {
  const areas = [...new Set(paths.map(areaForPath).filter(Boolean))].slice(0, 3)
  return areas.length > 0
    ? cleanCommitText(`Update ${readableList(areas)}`)
    : 'Integrate completed Ensync work'
}

function publicationMessage({ subjects, paths, accepted }) {
  const meaningful = [...new Set(subjects.map((subject) => cleanCommitText(subject)).filter((subject) => !isInternalCommitSubject(subject)))]
  const subject = meaningful.length === 1
    ? meaningful[0]
    : meaningful.length > 1
      ? cleanCommitText(`Integrate: ${meaningful.slice(0, 2).join('; ')}`)
      : fallbackSubject(paths)
  const body = [
    subject,
    '',
    accepted.length === 1
      ? 'Includes one completed Ensync task.'
      : `Includes ${accepted.length} completed Ensync tasks.`,
  ]
  if (paths.length > 0) {
    body.push('', 'Changed paths:', ...paths.slice(0, MAX_COMMIT_PATHS).map((path) => `- ${cleanCommitText(path, 512)}`))
    if (paths.length > MAX_COMMIT_PATHS) body.push(`- …and ${paths.length - MAX_COMMIT_PATHS} more`)
  }
  body.push('', 'Ensync-Landing: true')
  return body.join('\n')
}

function isWithinRepository(repositoryPath, projectPath) {
  const child = relative(repositoryPath, projectPath)
  return child === '' || (
    child !== '..'
    && !child.startsWith(`..${sep}`)
    && !isAbsolute(child)
  )
}

function samePath(left, right) {
  return process.platform === 'win32'
    ? left.toLowerCase() === right.toLowerCase()
    : left === right
}

function conflictPathsAreBounded(paths) {
  return paths.length <= MAX_CONFLICT_FILES
    && paths.reduce((total, path) => total + Buffer.byteLength(path, 'utf8') + 1, 0) <= MAX_CONFLICT_PATH_BYTES
}

function structuralDiffArguments(range) {
  // The exact saved snapshot owns every non-conflict byte, so whitespace style
  // in those bytes cannot be repaired without violating resolver containment.
  // `diff --check` still rejects introduced conflict markers with all Git
  // whitespace-error classes explicitly disabled.
  return ['-c', `core.whitespace=${MARKER_ONLY_WHITESPACE_RULES}`, 'diff', '--check', range]
}

function resultFor(train, landedIds, retryIds, errors, head = null, description = null) {
  const order = new Map(train.map((item) => [item.id, item.completionSequence]))
  const sorted = (ids) => [...ids].sort((left, right) => order.get(left) - order.get(right))
  return {
    landedIds: sorted(landedIds),
    retryIds: sorted(retryIds),
    errors,
    head,
    description,
  }
}

export class LandingIntegrator {
  constructor(options = {}) {
    if (
      !options.client
      || typeof options.client.create !== 'function'
      || typeof options.client.gitEnvironment !== 'function'
    ) {
      throw new TypeError('LandingIntegrator requires an agent-worktree client.')
    }
    this.client = options.client
    this.gitRunner = options.gitRunner ?? runGit
    this.idFactory = options.idFactory ?? randomUUID
    this.gitExecutable = options.gitExecutable
    // A semantic conflict resolution has no fixed wall-clock deadline. The
    // provider runner still owns inactivity/failure detection, and Host
    // shutdown remains able to cancel the run and verify that it stopped.
    // Tests may supply an explicit deadline to exercise that safety path.
    this.resolutionTimeoutMs = options.resolutionTimeoutMs ?? null
    this.resolutionShutdownTimeoutMs = options.resolutionShutdownTimeoutMs
      ?? DEFAULT_RESOLUTION_SHUTDOWN_TIMEOUT_MS
    this.operationContext = new AsyncLocalStorage()
  }

  async integrate(entries, options = {}) {
    return this.operationContext.run({
      signal: options.signal,
      worktreeControls: new Map(),
    }, () => this.#integrate(entries, options))
  }

  async #integrate(entries, options = {}) {
    const train = [...entries].sort((left, right) => left.completionSequence - right.completionSequence)
    if (train.length === 0) return resultFor([], [], [], {}, null)
    const repositoryPath = train[0].repositoryPath
    if (train.some((item) => item.repositoryPath !== repositoryPath)) {
      throw new TypeError('A landing train cannot cross repository boundaries.')
    }
    const commonGitDirectory = train[0].commonGitDirectory
    if (
      !isAbsolute(commonGitDirectory ?? '')
      || train.some((item) => !samePath(item.commonGitDirectory ?? '', commonGitDirectory))
    ) {
      throw new TypeError('A landing train must retain one exact shared Git directory.')
    }
    if (new Set(train.map((item) => item.id)).size !== train.length) {
      throw new TypeError('A landing train cannot contain duplicate item IDs.')
    }
    if (train.some((item) => !isWithinRepository(repositoryPath, item.projectPath))) {
      throw new TypeError('A landing project path must stay inside its repository.')
    }
    const target = train[0].targetBranch
    if (
      typeof target !== 'string'
      || !target
      || train.some((item) => item.targetBranch !== target)
    ) {
      throw new TypeError('A landing train must retain one exact target branch.')
    }
    const targetRef = `refs/heads/${target}`

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

    const currentCommon = await this.#git([
      'rev-parse', '--path-format=absolute', '--git-common-dir',
    ], repositoryPath)
    if (
      currentCommon.exitCode !== 0
      || !samePath(resolve(repositoryPath, firstLine(currentCommon.stdout)), commonGitDirectory)
    ) {
      retryMany(train, 'The canonical checkout no longer matches the saved shared Git directory; automatic landing left it untouched.')
      return resultFor(train, landedIds, retryIds, errors)
    }

    const initialStatus = await this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repositoryPath)
    if (initialStatus.exitCode !== 0 || initialStatus.stdout.split('\0').filter(Boolean).length > 0) {
      retryMany(train, 'The canonical checkout has unsaved changes; automatic integration left it untouched.')
      return resultFor(train, landedIds, retryIds, errors)
    }
    if (!(await this.#canonicalIndexIsOrdinary(repositoryPath))) {
      retryMany(train, 'The canonical checkout has hidden tracked-file index flags; automatic integration left its bytes untouched.')
      return resultFor(train, landedIds, retryIds, errors)
    }
    const targetFormat = await this.#git(['check-ref-format', '--branch', target], repositoryPath)
    if (targetFormat.exitCode !== 0) {
      retryMany(train, 'The saved automatic-landing target branch is invalid.')
      return resultFor(train, landedIds, retryIds, errors)
    }
    const targetResult = await this.#git(['symbolic-ref', '--quiet', 'HEAD'], repositoryPath)
    const checkedOutTarget = targetResult.exitCode === 0 ? firstLine(targetResult.stdout) : null
    if (checkedOutTarget !== targetRef) {
      retryMany(train, `The saved target branch ${target} is not checked out; automatic integration left every branch untouched.`)
      return resultFor(train, landedIds, retryIds, errors)
    }
    const originalHeadResult = await this.#git(['rev-parse', '--verify', targetRef], repositoryPath)
    const originalHead = originalHeadResult.exitCode === 0 ? firstLine(originalHeadResult.stdout) : null
    if (!originalHead) {
      retryMany(train, `Git could not read the automatic landing target ${target}.`)
      return resultFor(train, landedIds, retryIds, errors)
    }

    const eligible = []
    for (const item of train) {
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(item.targetBaseSha ?? '')) {
        retry(item, 'This saved landing item predates target-bound automatic landing and needs a new completed chat snapshot.')
        continue
      }
      const checkpointResult = await this.#git(
        ['config', '--get', `branch.${item.branch}.ensyncTargetBaseSha`],
        repositoryPath,
      )
      const currentCheckpoint = firstLine(checkpointResult.stdout).toLowerCase()
      const requiredCheckpoint = checkpointResult.exitCode === 0
        && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(currentCheckpoint)
        ? currentCheckpoint
        : item.targetBaseSha
      const [available, baseAvailable, baseInSnapshot, baseRetained, alreadyLanded] = await Promise.all([
        this.#git(['cat-file', '-e', `${item.savedSha}^{commit}`], repositoryPath),
        this.#git(['cat-file', '-e', `${requiredCheckpoint}^{commit}`], repositoryPath),
        this.#git(['merge-base', '--is-ancestor', requiredCheckpoint, item.savedSha], repositoryPath),
        this.#git(['merge-base', '--is-ancestor', requiredCheckpoint, originalHead], repositoryPath),
        this.#git(['merge-base', '--is-ancestor', item.savedSha, originalHead], repositoryPath),
      ])
      if (available.exitCode !== 0) {
        retry(item, `The saved commit ${item.savedSha} is unavailable; the source chat branch was not substituted.`)
      } else if (baseAvailable.exitCode !== 0 || baseInSnapshot.exitCode !== 0 || baseRetained.exitCode !== 0) {
        retry(item, `The saved target ${target} or snapshot no longer contains conversation checkpoint ${requiredCheckpoint}; automatic landing will not reintroduce rewritten history.`)
      } else if (alreadyLanded.exitCode === 0) {
        const persisted = await this.#persistConversationCheckpoint(repositoryPath, item)
        if (persisted.ok) landedIds.add(item.id)
        else retry(item, persisted.reason)
      } else {
        eligible.push(item)
      }
    }
    if (eligible.length === 0) return resultFor(train, landedIds, retryIds, errors, originalHead)

    const identity = await this.#repositoryIdentity(repositoryPath)
    const safeGitEnvironment = await this.client.gitEnvironment(identity)
    const integrationBranch = `ensync/landing-trains/${safeRefPart(this.idFactory())}`
    const integrationBaseBranch = `ensync/landing-bases/${originalHead.toLowerCase()}`
    let integration = null
    const accepted = []
    try {
      const preparedBase = await this.#prepareImmutableBranch(
        repositoryPath,
        integrationBaseBranch,
        originalHead,
        safeGitEnvironment,
      )
      if (!preparedBase.ok) {
        retryMany(train, preparedBase.reason)
        return resultFor(train, landedIds, retryIds, errors)
      }
      integration = await this.client.create({
        repositoryPath,
        branch: integrationBranch,
        base: integrationBaseBranch,
        signal: this.#signal(),
      })
      await this.#bindWorktreeControl(integration.path)
      const [createdHead, createdBranch, createdCommon] = await Promise.all([
        this.#git(['rev-parse', '--verify', 'HEAD'], integration.path),
        this.#git(['symbolic-ref', '--quiet', 'HEAD'], integration.path),
        this.#git(['rev-parse', '--path-format=absolute', '--git-common-dir'], integration.path),
      ])
      if (
        createdHead.exitCode !== 0
        || firstLine(createdHead.stdout) !== originalHead
        || createdBranch.exitCode !== 0
        || firstLine(createdBranch.stdout) !== `refs/heads/${integrationBranch}`
        || createdCommon.exitCode !== 0
        || !samePath(resolve(integration.path, firstLine(createdCommon.stdout)), commonGitDirectory)
      ) {
        retryMany(train, 'The isolated landing train did not start from the exact inspected target commit.')
        return resultFor(train, landedIds, retryIds, errors)
      }
      if (!(await this.#shortBranchResolvesExactly(repositoryPath, integrationBranch))) {
        retryMany(train, 'The generated integration branch has a colliding Git ref, so automatic landing left the target untouched.')
        return resultFor(train, landedIds, retryIds, errors)
      }

      for (const item of eligible) {
        const itemBranch = `ensync/landing-items/${safeRefPart(item.id)}`
        const prepared = await this.#prepareImmutableBranch(
          repositoryPath,
          itemBranch,
          item.savedSha,
          safeGitEnvironment,
        )
        if (!prepared.ok) {
          retry(item, prepared.reason)
          continue
        }

        const checkpointResult = await this.#git(['rev-parse', '--verify', 'HEAD'], integration.path)
        const checkpoint = firstLine(checkpointResult.stdout)
        if (checkpointResult.exitCode !== 0 || !checkpoint) {
          retry(item, 'Git could not checkpoint the isolated integration branch before applying this item.')
          retryMany(eligible.filter((candidate) => candidate.completionSequence > item.completionSequence), 'The integration checkpoint was unavailable; later saved snapshots will retry.')
          break
        }
        const applied = await this.#applyItem({
          integration,
          item,
          itemBranch,
          identity,
          resolveConflict: options.resolveConflict,
        })
        if (!applied.ok) {
          retry(item, applied.reason)
          const restored = applied.safeToContinue
            && await this.#restoreCheckpoint(integration.path, integrationBranch, checkpoint, safeGitEnvironment)
          if (!restored) {
            retryMany(accepted.map(({ item: acceptedItem }) => acceptedItem), 'The conflict resolver did not stop cleanly; this entire isolated train was abandoned before publication.')
            accepted.length = 0
            retryMany(train.filter((candidate) => (
              candidate.completionSequence > item.completionSequence && !retryIds.has(candidate.id)
            )), 'The integration worktree could not be restored after a failed item; its target remained unchanged.')
            break
          }
          continue
        }
        const validation = await this.#validateAppliedItem(
          integration.path,
          integrationBranch,
          originalHead,
          item.savedSha,
        )
        if (!validation.ok) {
          retry(item, `The dependency-free structural check failed: ${validation.reason}`)
          const restored = await this.#restoreCheckpoint(
            integration.path,
            integrationBranch,
            checkpoint,
            safeGitEnvironment,
          )
          if (!restored) {
            retryMany(eligible.filter((candidate) => candidate.completionSequence > item.completionSequence), 'The integration worktree could not be restored after a rejected item; later snapshots will retry.')
            break
          }
          continue
        }
        accepted.push({ item, itemBranch })
      }

      if (accepted.length === 0) return resultFor(train, landedIds, retryIds, errors)

      const mergeMessage = await this.#publicationMessage(integration.path, originalHead, accepted)

      const sealed = await this.#git([
        '-c', 'commit.gpgsign=false',
        'commit', '--allow-empty', '--no-verify',
        '-m', `Ensync automatic landing (FIFO ${accepted[0].item.completionSequence}-${accepted.at(-1).item.completionSequence})`,
      ], integration.path, { env: safeGitEnvironment })
      if (sealed.exitCode !== 0) {
        retryMany(accepted.map(({ item }) => item), firstLine(sealed.stderr) || 'Git could not seal the verified landing train.')
        return resultFor(train, landedIds, retryIds, errors)
      }

      const [structural, integrationStatus, integrationHead, integrationBranchResult] = await Promise.all([
        this.#git(structuralDiffArguments(`${originalHead}...HEAD`), integration.path),
        this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], integration.path),
        this.#git(['rev-parse', '--verify', 'HEAD'], integration.path),
        this.#git(['symbolic-ref', '--quiet', 'HEAD'], integration.path),
      ])
      const unmerged = await this.#unmergedFiles(integration.path)
      const verifiedIntegrationHead = firstLine(integrationHead.stdout)
      const missingAcceptedSha = await this.#firstMissingAncestor(integration.path, accepted)
      const retainsOriginalTarget = await this.#git(
        ['merge-base', '--is-ancestor', originalHead, 'HEAD'],
        integration.path,
      )
      if (
        structural.exitCode !== 0
        || integrationStatus.exitCode !== 0
        || integrationStatus.stdout.split('\0').filter(Boolean).length > 0
        || integrationHead.exitCode !== 0
        || !verifiedIntegrationHead
        || integrationBranchResult.exitCode !== 0
        || firstLine(integrationBranchResult.stdout) !== `refs/heads/${integrationBranch}`
        || unmerged.length > 0
        || missingAcceptedSha
        || retainsOriginalTarget.exitCode !== 0
      ) {
        const detail = firstLine(structural.stdout)
          || firstLine(structural.stderr)
          || (missingAcceptedSha ? `saved commit ${missingAcceptedSha} is not an ancestor` : '')
          || `unmerged paths remain: ${unmerged.join(', ')}`
        retryMany(accepted.map(({ item }) => item), `The dependency-free structural check failed: ${detail}`)
        return resultFor(train, landedIds, retryIds, errors)
      }

      const [postGateHead, postGateBranch, postGateStatus, postGateStructural] = await Promise.all([
        this.#git(['rev-parse', '--verify', 'HEAD'], integration.path),
        this.#git(['symbolic-ref', '--quiet', 'HEAD'], integration.path),
        this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], integration.path),
        this.#git(structuralDiffArguments(`${originalHead}...HEAD`), integration.path),
      ])
      const postGateUnmerged = await this.#unmergedFiles(integration.path)
      const postGateMissingSha = await this.#firstMissingAncestor(integration.path, accepted)
      const postGateRetainsTarget = await this.#git(
        ['merge-base', '--is-ancestor', originalHead, 'HEAD'],
        integration.path,
      )
      if (
        postGateHead.exitCode !== 0
        || firstLine(postGateHead.stdout) !== verifiedIntegrationHead
        || postGateBranch.exitCode !== 0
        || firstLine(postGateBranch.stdout) !== `refs/heads/${integrationBranch}`
        || postGateStatus.exitCode !== 0
        || postGateStatus.stdout.split('\0').filter(Boolean).length > 0
        || postGateStructural.exitCode !== 0
        || postGateUnmerged.length > 0
        || postGateMissingSha
        || postGateRetainsTarget.exitCode !== 0
      ) {
        retryMany(
          accepted.map(({ item }) => item),
          'The verified integration branch changed before publication; automatic landing discarded that integration attempt.',
        )
        return resultFor(train, landedIds, retryIds, errors)
      }

      const [currentHead, finalStatus, finalBranch] = await Promise.all([
        this.#git(['rev-parse', '--verify', targetRef], repositoryPath),
        this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repositoryPath),
        this.#git(['symbolic-ref', '--quiet', 'HEAD'], repositoryPath),
      ])
      if (
        currentHead.exitCode !== 0
        || firstLine(currentHead.stdout) !== originalHead
        || finalStatus.exitCode !== 0
        || finalStatus.stdout.split('\0').filter(Boolean).length > 0
        || finalBranch.exitCode !== 0
        || firstLine(finalBranch.stdout) !== targetRef
      ) {
        retryMany(accepted.map(({ item }) => item), 'The landing target or checked-out branch changed while the train was integrating; the saved snapshots will retry after the checkout is stable.')
        return resultFor(train, landedIds, retryIds, errors)
      }
      if (!(await this.#canonicalIndexIsOrdinary(repositoryPath))) {
        retryMany(accepted.map(({ item }) => item), 'The canonical checkout gained hidden tracked-file index flags before publication; automatic landing left its bytes untouched.')
        return resultFor(train, landedIds, retryIds, errors)
      }
      if (!(await this.#shortBranchResolvesExactly(repositoryPath, integrationBranch))) {
        retryMany(accepted.map(({ item }) => item), 'The verified integration branch gained a colliding ref before publication; automatic landing left the target untouched.')
        return resultFor(train, landedIds, retryIds, errors)
      }

      const collision = await this.#firstPublicationCollision(
        repositoryPath,
        originalHead,
        verifiedIntegrationHead,
      )
      if (collision) {
        retryMany(accepted.map(({ item }) => item), `The verified train would overwrite the local path ${collision}; automatic landing left the checkout and target unchanged.`)
        return resultFor(train, landedIds, retryIds, errors)
      }

      let published
      try {
        published = await this.client.merge({
          repositoryPath,
          worktreePath: integration.path,
          into: target,
          expectedHead: originalHead,
          strategy: 'merge',
          skipHooks: true,
          commitMessage: mergeMessage,
          identity,
          signal: this.#signal(),
        })
      } catch (error) {
        retryMany(
          accepted.map(({ item }) => item),
          error instanceof Error ? error.message : 'agent-worktree refused publication.',
        )
        return resultFor(train, landedIds, retryIds, errors)
      }
      const publishedHead = await this.#git(['rev-parse', '--verify', targetRef], repositoryPath)
      const publishedSha = firstLine(publishedHead.stdout)
      if (publishedHead.exitCode !== 0 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(publishedSha)) {
        retryMany(accepted.map(({ item }) => item), 'Git could not pin the published automatic landing commit for verification.')
        return resultFor(train, landedIds, retryIds, errors)
      }
      const [publishedStatus, publishedStructural, publishedCandidate, publishedOriginal, publishedConfig, publishedParents] = await Promise.all([
        this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], repositoryPath),
        this.#git(structuralDiffArguments(`${originalHead}...${publishedSha}`), repositoryPath),
        this.#git(['merge-base', '--is-ancestor', verifiedIntegrationHead, publishedSha], repositoryPath),
        this.#git(['merge-base', '--is-ancestor', originalHead, publishedSha], repositoryPath),
        this.#git(['cat-file', '-e', `${publishedSha}:.agent-worktree.toml`], repositoryPath),
        this.#git(['rev-list', '--parents', '-n', '1', publishedSha], repositoryPath),
      ])
      const publishedMissingSha = await this.#firstMissingAncestor(repositoryPath, accepted, publishedSha)
      const parentFields = firstLine(publishedParents.stdout).split(' ')
      const [finalPublishedHead, finalPublishedBranch] = await Promise.all([
        this.#git(['rev-parse', '--verify', targetRef], repositoryPath),
        this.#git(['symbolic-ref', '--quiet', 'HEAD'], repositoryPath),
      ])
      if (
        published.disposition !== 'applied'
        || publishedStatus.exitCode !== 0
        || publishedStatus.stdout.split('\0').filter(Boolean).length > 0
        || publishedStructural.exitCode !== 0
        || publishedCandidate.exitCode !== 0
        || publishedOriginal.exitCode !== 0
        || publishedConfig.exitCode === 0
        || publishedParents.exitCode !== 0
        || parentFields.length !== 3
        || parentFields[0] !== publishedSha
        || parentFields[1] !== originalHead
        || parentFields[2] !== verifiedIntegrationHead
        || publishedMissingSha
        || finalPublishedHead.exitCode !== 0
        || firstLine(finalPublishedHead.stdout) !== publishedSha
        || finalPublishedBranch.exitCode !== 0
        || firstLine(finalPublishedBranch.stdout) !== targetRef
      ) {
        retryMany(accepted.map(({ item }) => item), 'The published target did not pass post-merge ancestry and structural verification; the saved snapshots will retry without replaying a provider.')
        return resultFor(train, landedIds, retryIds, errors)
      }
      for (const { item, itemBranch } of accepted) {
        const persisted = await this.#persistConversationCheckpoint(repositoryPath, item, safeGitEnvironment)
        if (persisted.ok) {
          landedIds.add(item.id)
          await this.#git(['branch', '--delete', itemBranch], repositoryPath, { env: safeGitEnvironment })
        } else {
          retry(item, persisted.reason)
        }
      }
      return resultFor(train, landedIds, retryIds, errors, publishedSha, firstLine(mergeMessage))
    } catch (error) {
      retryMany(
        train.filter((item) => !retryIds.has(item.id) && !landedIds.has(item.id)),
        error instanceof Error ? error.message : error,
      )
      return resultFor(train, landedIds, retryIds, errors)
    } finally {
      if (integration) {
        await this.#withCleanupSignal((signal) => this.client.remove({
          repositoryPath,
          branch: integrationBranch,
          signal,
        })).catch(() => {})
      }
    }
  }

  async #prepareImmutableBranch(repositoryPath, branch, savedSha, environment) {
    const collidingTag = await this.#git(['show-ref', '--verify', '--quiet', `refs/tags/${branch}`], repositoryPath)
    if (collidingTag.exitCode === 0) {
      return { ok: false, reason: `The internal landing branch ${branch} collides with an existing tag.` }
    }
    const existing = await this.#git(['rev-parse', '--verify', `refs/heads/${branch}`], repositoryPath)
    if (existing.exitCode === 0) {
      return firstLine(existing.stdout) === savedSha && await this.#shortBranchResolvesExactly(repositoryPath, branch)
        ? { ok: true }
        : { ok: false, reason: `The preserved landing ref ${branch} no longer names the saved commit.` }
    }
    const created = await this.#git(
      ['update-ref', `refs/heads/${branch}`, savedSha, '0'.repeat(savedSha.length)],
      repositoryPath,
      { env: environment },
    )
    return created.exitCode === 0 && await this.#shortBranchResolvesExactly(repositoryPath, branch)
      ? { ok: true }
      : { ok: false, reason: firstLine(created.stderr) || `Git could not preserve saved commit ${savedSha}.` }
  }

  async #shortBranchResolvesExactly(repositoryPath, branch) {
    const resolved = await this.#git(
      ['rev-parse', '--symbolic-full-name', '--verify', branch],
      repositoryPath,
    )
    return resolved.exitCode === 0 && firstLine(resolved.stdout) === `refs/heads/${branch}`
  }

  async #publicationMessage(worktreePath, originalHead, accepted) {
    const [log, diff] = await Promise.all([
      this.#git(['log', '--no-merges', '--format=%s%x00', `${originalHead}..HEAD`, '--'], worktreePath),
      this.#git(['diff', '--name-only', '-z', `${originalHead}...HEAD`, '--'], worktreePath),
    ])
    const subjects = log.exitCode === 0 ? log.stdout.split('\0').map((value) => value.trim()).filter(Boolean) : []
    const paths = diff.exitCode === 0 ? diff.stdout.split('\0').filter(Boolean) : []
    return publicationMessage({ subjects, paths, accepted })
  }

  async #canonicalIndexIsOrdinary(repositoryPath) {
    const files = await this.#git(['ls-files', '-v', '-z'], repositoryPath)
    if (files.exitCode !== 0) return false
    return files.stdout.split('\0').filter(Boolean).every((entry) => entry.startsWith('H '))
  }

  async #persistConversationCheckpoint(repositoryPath, item, environment) {
    const persisted = await this.#git(
      ['config', `branch.${item.branch}.ensyncTargetBaseSha`, item.savedSha],
      repositoryPath,
      environment ? { env: environment } : {},
    )
    return persisted.exitCode === 0
      ? { ok: true }
      : {
          ok: false,
          reason: firstLine(persisted.stderr) || `Git could not retain the landed checkpoint for ${item.branch}.`,
        }
  }

  async #applyItem({ integration, item, itemBranch, identity, resolveConflict }) {
    try {
      await this.client.sync({
        worktreePath: integration.path,
        from: itemBranch,
        strategy: 'merge',
        identity,
        signal: this.#signal(),
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
      if (!conflictPathsAreBounded(conflictFiles)) {
        const restored = await this.#abortIfNeeded(integration.path)
        return {
          ok: false,
          safeToContinue: restored,
          reason: `Automatic integration found too many conflict paths for the bounded resolver (${conflictFiles.length} files). The saved snapshot will retry automatically.`,
        }
      }

      const protectedEntries = await this.#nonConflictIndexEntries(
        integration.path,
        conflictFiles,
      )
      const commonGit = await this.#git(
        ['rev-parse', '--path-format=absolute', '--git-common-dir'],
        integration.path,
      )
      if (protectedEntries === null || commonGit.exitCode !== 0 || !firstLine(commonGit.stdout)) {
        const restored = await this.#abortIfNeeded(integration.path)
        return {
          ok: false,
          safeToContinue: restored,
          reason: 'Ensync could not pin the integration worktree before conflict resolution.',
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
        const recovered = await this.#recoverPriorResolution(
          integration.path,
          item,
          conflictFiles,
          protectedEntries,
        )
        if (recovered) {
          const finalized = await this.#finalizeResolution(
            integration,
            item,
            identity,
            conflictFiles,
            protectedEntries,
          )
          if (!finalized.ok) {
            const restored = await this.#abortIfNeeded(integration.path)
            return { ok: false, safeToContinue: restored, reason: finalized.reason }
          }
          return { ok: true, safeToContinue: true }
        }

        let resolutionFailure = null
        try {
          await this.#boundedResolution(resolveConflict, {
            item: { ...item },
            worktreePath: integration.path,
            projectPath: resolve(integration.path, relative(item.repositoryPath, item.projectPath)),
            commonGitDirectory: firstLine(commonGit.stdout),
            conflictFiles: [...conflictFiles],
          })
        } catch (error) {
          resolutionFailure = error
        }
        try {
          await this.#assertWorktreeControl(integration.path)
        } catch {
          const unsafe = new Error('The conflict resolver changed the integration worktree Git control file; the isolated train was abandoned without running Git through that path.')
          unsafe.unsafeWorktreeControl = true
          throw unsafe
        }
        if (resolutionFailure) throw resolutionFailure
        const finalized = await this.#finalizeResolution(integration, item, identity, conflictFiles, protectedEntries)
        if (!finalized.ok) {
          const restored = await this.#abortIfNeeded(integration.path)
          return {
            ok: false,
            safeToContinue: restored,
            reason: finalized.reason,
          }
        }
        return { ok: true, safeToContinue: true }
      } catch (resolutionError) {
        if (resolutionError?.unsafeWorktreeControl || resolutionError?.resolverStopped === false) {
          return {
            ok: false,
            safeToContinue: false,
            reason: resolutionError.message,
          }
        }
        const restored = await this.#abortIfNeeded(integration.path)
        return {
          ok: false,
          safeToContinue: restored && resolutionError?.resolverStopped !== false,
          reason: resolutionError instanceof Error ? resolutionError.message : resolutionError,
        }
      }
    }
  }

  async #recoverPriorResolution(worktreePath, item, conflictFiles, protectedEntries) {
    const listed = await this.#git(['worktree', 'list', '--porcelain', '-z'], worktreePath)
    if (listed.exitCode !== 0) return false
    const integrationParent = dirname(resolve(worktreePath))
    const tips = []
    const candidateRefs = []
    for (const record of listed.stdout.split('\0\0').filter(Boolean)) {
      const fields = Object.fromEntries(record.split('\0').map((line) => {
        const separator = line.indexOf(' ')
        return separator < 0 ? [line, ''] : [line.slice(0, separator), line.slice(separator + 1)]
      }))
      if (
        !fields.worktree
        || !fields.HEAD
        || !fields.branch?.startsWith('refs/heads/ensync/landing-trains/')
        || samePath(resolve(fields.worktree), resolve(worktreePath))
        || !samePath(dirname(resolve(fields.worktree)), integrationParent)
      ) continue
      tips.push(fields.HEAD)
      candidateRefs.push(fields.branch)
    }
    if (tips.length === 0) return false

    const [currentStages, history, reflogHistory] = await Promise.all([
      this.#conflictIndexEntries(worktreePath, conflictFiles),
      this.#git(['rev-list', '--merges', '--parents', '--max-count=4096', ...tips], worktreePath),
      // A rejected over-broad resolver result is reset back to its checkpoint,
      // but its merge commit remains in the reflog of that retained,
      // tool-owned landing branch. The same exact-input and bounded-path gates
      // below make its conflict-file subset reusable without publishing any
      // non-conflict edit that caused the original rejection.
      this.#git([
        'log', '-g', '--merges', '--format=%H %P', '--max-count=4096',
        ...candidateRefs,
      ], worktreePath),
    ])
    if (currentStages === null || history.exitCode !== 0) return false

    const reusable = new Map()
    const candidates = [
      ...history.stdout.split(/\r?\n/),
      ...(reflogHistory.exitCode === 0 ? reflogHistory.stdout.split(/\r?\n/) : []),
    ].filter(Boolean)
    for (const line of candidates) {
      const [candidate, firstParent, secondParent, ...extraParents] = line.trim().split(/\s+/)
      if (
        !candidate
        || !firstParent
        || secondParent?.toLowerCase() !== item.savedSha.toLowerCase()
        || extraParents.length > 0
      ) continue
      const [mergeBase, structural, markers] = await Promise.all([
        this.#git(['merge-base', firstParent, item.savedSha], worktreePath),
        this.#git(structuralDiffArguments(`${firstParent}...${candidate}`), worktreePath),
        this.#git(['grep', '-l', '-E', CONFLICT_MARKER_PATTERN, candidate, '--', ...conflictFiles], worktreePath),
      ])
      if (
        mergeBase.exitCode !== 0
        || !firstLine(mergeBase.stdout)
        || structural.exitCode !== 0
        || ![1].includes(markers.exitCode)
      ) continue
      const resolution = []
      let exactInputs = true
      for (const path of conflictFiles) {
        const [base, ours, theirs, resolved] = await Promise.all([
          this.#treeEntryAt(worktreePath, firstLine(mergeBase.stdout), path),
          this.#treeEntryAt(worktreePath, firstParent, path),
          this.#treeEntryAt(worktreePath, item.savedSha, path),
          this.#treeEntryAt(worktreePath, candidate, path),
        ])
        const stages = currentStages.get(path) ?? new Map()
        if (
          base === undefined
          || ours === undefined
          || theirs === undefined
          || resolved === undefined
          || (stages.get('1') ?? null) !== base
          || (stages.get('2') ?? null) !== ours
          || (stages.get('3') ?? null) !== theirs
        ) {
          exactInputs = false
          break
        }
        resolution.push([path, resolved])
      }
      if (!exactInputs) continue
      reusable.set(JSON.stringify(resolution), { candidate, resolution })
    }
    // Conflicting cached answers are ambiguous and must fall back to a live
    // semantic resolver instead of choosing one by traversal order.
    if (reusable.size !== 1) return false
    const [{ candidate, resolution }] = reusable.values()
    const present = resolution.filter(([, entry]) => entry !== null).map(([path]) => path)
    const deleted = resolution.filter(([, entry]) => entry === null).map(([path]) => path)
    if (present.length > 0) {
      const restored = await this.#git(['checkout', candidate, '--', ...present], worktreePath)
      if (restored.exitCode !== 0) return false
    }
    if (deleted.length > 0) {
      const removed = await this.#git(['rm', '-f', '--', ...deleted], worktreePath)
      if (removed.exitCode !== 0) return false
    }
    const resolvedEntries = await this.#nonConflictIndexEntries(worktreePath, conflictFiles)
    return resolvedEntries !== null && resolvedEntries === protectedEntries
  }

  async #finalizeResolution(integration, item, identity, conflictFiles, protectedEntries) {
    const markers = await this.#git(
      ['grep', '-l', '-E', CONFLICT_MARKER_PATTERN, '--', ...conflictFiles],
      integration.path,
    )
    if (markers.exitCode === 0) {
      return { ok: false, reason: `Conflict markers remain in: ${markers.stdout.split(/\r?\n/).filter(Boolean).join(', ')}.` }
    }
    if (await this.#mergeInProgress(integration.path)) {
      const staged = await this.#git(['add', '--', ...conflictFiles], integration.path)
      if (staged.exitCode !== 0) return { ok: false, reason: firstLine(staged.stderr) || 'Git could not stage the resolved conflict files.' }
      const unresolved = await this.#unmergedFiles(integration.path)
      if (unresolved.length > 0) return { ok: false, reason: `Conflicts remain unresolved in: ${unresolved.join(', ')}.` }
      await this.client.continueSync({
        worktreePath: integration.path,
        identity,
        signal: this.#signal(),
      })
    }
    const contained = await this.#git(
      ['merge-base', '--is-ancestor', item.savedSha, 'HEAD'],
      integration.path,
    )
    if (contained.exitCode !== 0) return { ok: false, reason: 'The conflict resolution did not retain the exact saved commit.' }
    const resolvedEntries = await this.#nonConflictTreeEntries(
      integration.path,
      conflictFiles,
    )
    if (resolvedEntries === null || resolvedEntries !== protectedEntries) {
      return { ok: false, reason: 'The conflict resolver changed files outside the reported conflict set.' }
    }
    return { ok: true }
  }

  async #boundedResolution(resolveConflict, details) {
    const controller = new AbortController()
    const parentSignal = this.#signal()
    let timer = null
    let onParentAbort = null
    const resolution = Promise.resolve().then(() => resolveConflict({ ...details, signal: controller.signal }))
    const outcomes = [resolution.then(() => 'resolved')]
    if (Number.isFinite(this.resolutionTimeoutMs) && this.resolutionTimeoutMs > 0) {
      outcomes.push(new Promise((resolveTimeout) => {
        timer = setTimeout(() => {
          controller.abort()
          resolveTimeout('timeout')
        }, this.resolutionTimeoutMs)
      }))
    }
    const cancelled = new Promise((resolveCancellation) => {
      if (!parentSignal) return
      if (parentSignal.aborted) resolveCancellation('cancelled')
      else {
        onParentAbort = () => resolveCancellation('cancelled')
        parentSignal.addEventListener('abort', onParentAbort, { once: true })
      }
    })
    outcomes.push(cancelled)
    try {
      const outcome = await Promise.race(outcomes)
      if (outcome === 'resolved') return
      controller.abort()
      const stopped = await Promise.race([
        resolution.then(() => true, () => true),
        new Promise((resolveShutdown) => {
          setTimeout(() => resolveShutdown(false), this.resolutionShutdownTimeoutMs)
        }),
      ])
      const error = new Error(outcome === 'cancelled'
        ? 'Automatic conflict resolution stopped with the Host.'
        : 'Automatic conflict resolution timed out.')
      error.resolverStopped = stopped
      throw error
    } finally {
      clearTimeout(timer)
      if (onParentAbort) parentSignal.removeEventListener('abort', onParentAbort)
    }
  }

  async #validateAppliedItem(worktreePath, expectedBranch, originalHead, savedSha) {
    const [structural, status, head, branch, config, contained, retainedTarget] = await Promise.all([
      this.#git(structuralDiffArguments(`${originalHead}...HEAD`), worktreePath),
      this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktreePath),
      this.#git(['rev-parse', '--verify', 'HEAD'], worktreePath),
      this.#git(['symbolic-ref', '--quiet', 'HEAD'], worktreePath),
      this.#git(['cat-file', '-e', 'HEAD:.agent-worktree.toml'], worktreePath),
      this.#git(['merge-base', '--is-ancestor', savedSha, 'HEAD'], worktreePath),
      this.#git(['merge-base', '--is-ancestor', originalHead, 'HEAD'], worktreePath),
    ])
    const unmerged = await this.#unmergedFiles(worktreePath)
    if (config.exitCode === 0) return { ok: false, reason: 'repository-provided agent-worktree configuration is disabled' }
    if (contained.exitCode !== 0) return { ok: false, reason: `saved commit ${savedSha} is not an ancestor` }
    if (retainedTarget.exitCode !== 0) return { ok: false, reason: 'the original landing target is not an ancestor' }
    if (branch.exitCode !== 0 || firstLine(branch.stdout) !== `refs/heads/${expectedBranch}`) return { ok: false, reason: 'the integration branch changed' }
    if (head.exitCode !== 0 || !firstLine(head.stdout)) return { ok: false, reason: 'the integration commit is unavailable' }
    if (status.exitCode !== 0 || status.stdout.split('\0').filter(Boolean).length > 0) return { ok: false, reason: 'the integration worktree is not clean' }
    if (unmerged.length > 0) return { ok: false, reason: `unmerged paths remain: ${unmerged.join(', ')}` }
    if (structural.exitCode !== 0) return { ok: false, reason: firstLine(structural.stdout) || firstLine(structural.stderr) || 'git diff --check rejected the item' }
    return { ok: true }
  }

  async #restoreCheckpoint(worktreePath, expectedBranch, checkpoint, environment) {
    if (!(await this.#abortIfNeeded(worktreePath))) return false
    const reset = await this.#git(['reset', '--hard', checkpoint], worktreePath, { env: environment })
    const clean = await this.#git(['clean', '-fd'], worktreePath, { env: environment })
    const [head, branch, status] = await Promise.all([
      this.#git(['rev-parse', '--verify', 'HEAD'], worktreePath),
      this.#git(['symbolic-ref', '--quiet', 'HEAD'], worktreePath),
      this.#git(['status', '--porcelain=v1', '-z', '--untracked-files=all'], worktreePath),
    ])
    return reset.exitCode === 0
      && clean.exitCode === 0
      && firstLine(head.stdout) === checkpoint
      && firstLine(branch.stdout) === `refs/heads/${expectedBranch}`
      && status.exitCode === 0
      && status.stdout.split('\0').filter(Boolean).length === 0
  }

  async #repositoryIdentity(repositoryPath) {
    const [name, email] = await Promise.all([
      this.#git(['config', '--get', 'user.name'], repositoryPath),
      this.#git(['config', '--get', 'user.email'], repositoryPath),
    ])
    return {
      name: name.exitCode === 0 && firstLine(name.stdout) ? firstLine(name.stdout) : 'Ensync Agent',
      email: email.exitCode === 0 && firstLine(email.stdout) ? firstLine(email.stdout) : 'agent@ensync.local',
    }
  }

  async #mergeInProgress(worktreePath) {
    const result = await this.#git(['rev-parse', '-q', '--verify', 'MERGE_HEAD'], worktreePath)
    return result.exitCode === 0
  }

  async #unmergedFiles(worktreePath) {
    const result = await this.#git(['diff', '--name-only', '--diff-filter=U', '-z'], worktreePath)
    if (result.exitCode !== 0) return []
    return result.stdout.split('\0').filter(Boolean)
  }

  async #nonConflictIndexEntries(worktreePath, conflictFiles) {
    const result = await this.#git(['ls-files', '--stage', '-z'], worktreePath)
    if (result.exitCode !== 0) return null
    const conflicts = new Set(conflictFiles)
    const entries = []
    for (const record of result.stdout.split('\0').filter(Boolean)) {
      const match = /^(\d+) ([a-f0-9]+) ([0-3])\t([\s\S]*)$/i.exec(record)
      if (!match) return null
      const [, mode, sha, stage, path] = match
      if (stage === '0' && !conflicts.has(path)) entries.push(`${mode} ${sha.toLowerCase()}\t${path}`)
    }
    return entries.sort().join('\0')
  }

  async #nonConflictTreeEntries(worktreePath, conflictFiles) {
    return this.#treeEntriesAt(worktreePath, 'HEAD', conflictFiles)
  }

  async #conflictIndexEntries(worktreePath, conflictFiles) {
    const result = await this.#git(['ls-files', '--unmerged', '-z', '--', ...conflictFiles], worktreePath)
    if (result.exitCode !== 0) return null
    const entries = new Map(conflictFiles.map((path) => [path, new Map()]))
    for (const record of result.stdout.split('\0').filter(Boolean)) {
      const match = /^(\d+) ([a-f0-9]+) ([1-3])\t([\s\S]*)$/i.exec(record)
      if (!match || !entries.has(match[4])) return null
      entries.get(match[4]).set(match[3], `${match[1]} ${match[2].toLowerCase()}`)
    }
    return entries
  }

  async #treeEntryAt(worktreePath, treeish, path) {
    const result = await this.#git(['ls-tree', '-z', treeish, '--', path], worktreePath)
    if (result.exitCode !== 0) return undefined
    const records = result.stdout.split('\0').filter(Boolean)
    if (records.length === 0) return null
    if (records.length !== 1) return undefined
    const match = /^(\d+) \S+ ([a-f0-9]+)\t([\s\S]*)$/i.exec(records[0])
    if (!match || match[3] !== path) return undefined
    return `${match[1]} ${match[2].toLowerCase()}`
  }

  async #treeEntriesAt(worktreePath, treeish, conflictFiles) {
    const result = await this.#git(['ls-tree', '-r', '-z', treeish], worktreePath)
    if (result.exitCode !== 0) return null
    const conflicts = new Set(conflictFiles)
    const entries = []
    for (const record of result.stdout.split('\0').filter(Boolean)) {
      const match = /^(\d+) \S+ ([a-f0-9]+)\t([\s\S]*)$/i.exec(record)
      if (!match) return null
      const [, mode, sha, path] = match
      if (!conflicts.has(path)) entries.push(`${mode} ${sha.toLowerCase()}\t${path}`)
    }
    return entries.sort().join('\0')
  }

  async #firstPublicationCollision(repositoryPath, originalHead, candidateHead) {
    const added = await this.#git([
      'diff', '--name-only', '--diff-filter=A', '--no-renames', '-z',
      originalHead, candidateHead,
    ], repositoryPath)
    if (added.exitCode !== 0) return '[unknown path: Git could not preflight added files]'
    for (const path of added.stdout.split('\0').filter(Boolean)) {
      let current = repositoryPath
      const parts = path.split('/')
      for (let index = 0; index < parts.length; index += 1) {
        current = join(current, parts[index])
        try {
          const information = await lstat(current)
          if (index === parts.length - 1 || !information.isDirectory()) return path
        } catch (error) {
          if (error?.code === 'ENOENT') break
          if (error?.code === 'ENOTDIR') return path
          return path
        }
      }
    }
    return null
  }

  async #firstMissingAncestor(worktreePath, accepted, descendant = 'HEAD') {
    for (const { item } of accepted) {
      const contained = await this.#git(['merge-base', '--is-ancestor', item.savedSha, descendant], worktreePath)
      if (contained.exitCode !== 0) return item.savedSha
    }
    return null
  }

  async #abortIfNeeded(worktreePath) {
    if (!(await this.#mergeInProgress(worktreePath))) return true
    try {
      await this.client.abortSync({ worktreePath, signal: this.#signal() })
      return !(await this.#mergeInProgress(worktreePath))
    } catch {
      return false
    }
  }

  #git(args, cwd, options = {}) {
    return this.gitRunner(args, {
      cwd,
      gitExecutable: this.gitExecutable,
      timeoutMs: 30_000,
      signal: this.#signal(),
      ...options,
    })
  }

  #signal() {
    return this.operationContext.getStore()?.signal
  }

  async #bindWorktreeControl(worktreePath) {
    const value = await this.#readWorktreeControl(worktreePath)
    this.operationContext.getStore()?.worktreeControls.set(worktreePath, value)
  }

  async #assertWorktreeControl(worktreePath) {
    const expected = this.operationContext.getStore()?.worktreeControls.get(worktreePath)
    if (!expected || await this.#readWorktreeControl(worktreePath) !== expected) {
      throw new Error('The integration worktree Git control file changed.')
    }
  }

  async #readWorktreeControl(worktreePath) {
    const path = join(worktreePath, '.git')
    const before = await lstat(path)
    if (!before.isFile() || before.isSymbolicLink() || before.size > 4_096) {
      throw new Error('The integration worktree Git control path is unsafe.')
    }
    const contents = await readFile(path)
    const after = await lstat(path)
    if (
      !after.isFile()
      || after.isSymbolicLink()
      || before.dev !== after.dev
      || before.ino !== after.ino
      || before.size !== after.size
      || contents.byteLength !== after.size
    ) {
      throw new Error('The integration worktree Git control path changed during verification.')
    }
    return contents.toString('base64')
  }

  async #withCleanupSignal(action) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 2_000)
    try {
      return await action(controller.signal)
    } finally {
      clearTimeout(timer)
    }
  }
}
