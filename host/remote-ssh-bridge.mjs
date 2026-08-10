const BRIDGE_PROTOCOL = 'ensync-ssh-bridge-v1'

export function remoteChatArguments(payload) {
  const modelArgs = payload.model ? ['--model', payload.model] : []
  if (payload.provider === 'codex') {
    const effortArgs = payload.effort ? ['-c', `model_reasoning_effort="${payload.effort}"`] : []
    if (payload.sessionId) {
      return ['exec', 'resume', '--json', '--skip-git-repo-check', ...modelArgs, ...effortArgs, payload.sessionId, '-']
    }
    return ['exec', '--json', '--color', 'never', '--skip-git-repo-check', ...modelArgs, ...effortArgs, '-']
  }
  const args = ['--print', '--verbose', '--output-format', 'stream-json']
  if (payload.model) args.push('--model', payload.model)
  if (payload.effort) args.push('--effort', payload.effort)
  if (payload.sessionId) args.push('--resume', payload.sessionId)
  return args
}

/**
 * This function is serialized and sent to a verified remote `node -` process.
 * It deliberately has no imports from the Ensync checkout: the remote machine
 * only needs Node.js and the provider CLIs already installed for that user.
 */
async function remoteBridgeMain(encodedPayload, chatArguments) {
  const childProcess = require('node:child_process')
  const crypto = require('node:crypto')
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')

  const PROTOCOL = 'ensync-ssh-bridge-v1'
  const MAX_PROBE_BYTES = 512 * 1024
  const MAX_CHAT_BYTES = 4 * 1024 * 1024
  const BYTE_PRESERVING_GIT_CONFIG = ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false']
  const PAID_PROVIDER_KEYS = new Set([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'ANTHROPIC_CUSTOM_HEADERS',
    'AMP_API_KEY',
    'AZURE_OPENAI_API_KEY',
    'AWS_BEARER_TOKEN_BEDROCK',
    'CLAUDE_API_KEY',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_VERTEX',
    'COHERE_API_KEY',
    'CODEBUDDY_API_KEY',
    'CODEBUDDY_AUTH_TOKEN',
    'COPILOT_OFFLINE',
    'COPILOT_PROVIDER_API_KEY',
    'COPILOT_PROVIDER_BASE_URL',
    'COPILOT_PROVIDER_TYPE',
    'CURSOR_API_KEY',
    'DEEPSEEK_API_KEY',
    'FACTORY_API_KEY',
    'GEMINI_API_KEY',
    'GOOGLE_API_KEY',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_GENAI_USE_VERTEXAI',
    'GROQ_API_KEY',
    'JUNIE_API_KEY',
    'JUNIE_LLM_PROVIDER',
    'KIRO_API_KEY',
    'KIMI_CODE_BASE_URL',
    'KIMI_CODE_OAUTH_HOST',
    'KIMI_OAUTH_HOST',
    'MISTRAL_API_KEY',
    'OPENAI_API_KEY',
    'OPENROUTER_API_KEY',
    'QODER_API_KEY',
    'QODER_PERSONAL_ACCESS_TOKEN',
    'TOGETHER_API_KEY',
    'WARP_API_KEY',
  ])
  const PROVIDERS = [
    { id: 'claude', commands: ['claude'], versionArgs: ['--version'] },
    { id: 'codex', commands: ['codex'], versionArgs: ['--version'] },
    { id: 'kimi', commands: ['kimi'], versionArgs: ['--version'] },
    { id: 'antigravity', commands: ['agy'], versionArgs: ['--version'] },
    { id: 'jules', commands: ['jules'], versionArgs: ['version'] },
    { id: 'copilot', commands: ['copilot'], versionArgs: ['version'] },
    { id: 'cursor', commands: ['agent', 'cursor-agent'], versionArgs: ['--version'] },
    { id: 'kiro', commands: ['kiro-cli'], versionArgs: ['--version'] },
    { id: 'qoder', commands: ['qodercli'], versionArgs: ['--version'] },
    { id: 'codebuddy', commands: ['codebuddy', 'cbc'], versionArgs: ['--version'] },
    { id: 'droid', commands: ['droid'], versionArgs: ['--version'] },
    { id: 'auggie', commands: ['auggie'], versionArgs: ['--version'] },
    { id: 'amp', commands: ['amp'], versionArgs: ['--version'] },
    { id: 'gitlab_duo', commands: ['duo'], versionArgs: ['--version'] },
    { id: 'oz', commands: ['oz'], versionArgs: ['--version'] },
    { id: 'junie', commands: ['junie'], versionArgs: ['--version'] },
    { id: 'ollama', commands: ['ollama'], versionArgs: ['-v'] },
  ]

  function send(value) {
    const json = JSON.stringify({ protocol: PROTOCOL, ...value })
    process.stdout.write('ENSYNC_SSH_BRIDGE_V1:' + Buffer.from(json, 'utf8').toString('base64'))
  }

  let lastProgressAt = 0
  function sendProgress(kind) {
    const now = Date.now()
    if (kind !== 'spawn' && now - lastProgressAt < 1_000) return
    lastProgressAt = now
    process.stderr.write('ENSYNC_SSH_PROGRESS_V1:' + kind + '\n')
  }

  function bridgeError(code, message, details) {
    const error = new Error(message)
    error.code = code
    if (details !== undefined) error.details = details
    return error
  }

  function cleanEnvironment(source) {
    const clean = {}
    for (const [key, value] of Object.entries(source)) {
      const upper = key.toUpperCase()
      if (!PAID_PROVIDER_KEYS.has(upper) && !/^JUNIE_[A-Z0-9_]+_API_KEY$/.test(upper) && !/^KIMI_MODEL_[A-Z0-9_]+$/.test(upper)) {
        if (value !== undefined) clean[key] = value
      }
    }
    clean.NO_COLOR = '1'
    clean.FORCE_COLOR = '0'
    return clean
  }

  function canonicalProject(projectPath) {
    if (typeof projectPath !== 'string' || !projectPath) {
      throw bridgeError('invalid_remote_project', 'A remote project path is required.')
    }
    let resolved
    try {
      resolved = fs.realpathSync.native ? fs.realpathSync.native(projectPath) : fs.realpathSync(projectPath)
      if (!fs.statSync(resolved).isDirectory()) {
        throw bridgeError('invalid_remote_project', 'The remote project path is not a directory.')
      }
    } catch (error) {
      if (error && error.code === 'invalid_remote_project') throw error
      throw bridgeError(
        'invalid_remote_project',
        'The remote project folder does not exist or cannot be accessed.',
      )
    }
    if (path.dirname(resolved) === resolved) {
      throw bridgeError('invalid_remote_project', 'A remote filesystem root cannot be an Ensync project.')
    }
    return resolved
  }

  function executableExtensions() {
    if (process.platform !== 'win32') return ['']
    const configured = process.env.PATHEXT || '.EXE;.COM;.CMD;.BAT'
    return configured.split(';').filter(Boolean)
  }

  function candidateDirectories() {
    const directories = (process.env.PATH || process.env.Path || process.env.path || '')
      .split(path.delimiter)
      .filter(Boolean)
    const home = os.homedir()
    const common = process.platform === 'win32'
      ? [
          process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs'),
          process.env.APPDATA && path.join(process.env.APPDATA, 'npm'),
        ]
      : [path.join(home, '.local', 'bin'), path.join(home, 'bin'), '/usr/local/bin', '/opt/homebrew/bin']
    return [...new Set([...directories, ...common.filter(Boolean)])]
  }

  function findExecutable(commands) {
    const extensions = executableExtensions()
    for (const command of commands) {
      for (const directory of candidateDirectories()) {
        for (const extension of extensions) {
          const candidate = path.join(directory.replace(/^\"|\"$/g, ''), command + extension)
          try {
            const info = fs.statSync(candidate)
            if (!info.isFile()) continue
            fs.accessSync(candidate, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK)
            return {
              command,
              executable: candidate,
              directlyRunnable: !/\.(?:cmd|bat)$/i.test(candidate),
            }
          } catch {
            // Continue looking through the fixed command catalog.
          }
        }
      }
    }
    return null
  }

  function runCaptured(executable, args, options) {
    return new Promise((resolve) => {
      const inactivityTimeoutMs = options.inactivityTimeoutMs ?? options.timeoutMs
      const hardTimeoutMs = Object.hasOwn(options, 'hardTimeoutMs')
        ? options.hardTimeoutMs
        : options.timeoutMs
      let child
      let stdoutBytes = 0
      let stderrBytes = 0
      const stdout = []
      const stderr = []
      let timedOut = false
      let timeoutReason = null
      let outputExceeded = false
      let settled = false
      let inactivityTimer = null
      let hardTimer = null
      let forceKillTimer = null
      let parentTerminating = false
      const parentSignals = ['SIGHUP', 'SIGTERM', 'SIGINT']

      const onParentTermination = () => {
        parentTerminating = true
        child && terminateChild()
      }

      const removeParentSignalHandlers = () => {
        for (const signal of parentSignals) process.removeListener(signal, onParentTermination)
      }

      const finish = (value) => {
        if (settled) return
        settled = true
        if (inactivityTimer) clearTimeout(inactivityTimer)
        if (hardTimer) clearTimeout(hardTimer)
        if (forceKillTimer) clearTimeout(forceKillTimer)
        removeParentSignalHandlers()
        resolve({
          ...value,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
          timedOut,
          timeoutReason,
          outputExceeded,
        })
      }

      try {
        child = childProcess.spawn(executable, args, {
          cwd: options.cwd,
          env: options.env,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        })
      } catch (error) {
        return finish({ exitCode: null, signal: null, error: error.message })
      }

      const terminateChild = () => {
        if (!child || child.exitCode !== null || child.signalCode !== null || forceKillTimer) return
        try { child.kill('SIGTERM') } catch {
          // A concurrent remote child exit needs no further cleanup.
        }
        forceKillTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) {
            try { child.kill('SIGKILL') } catch {
              // A concurrent remote child exit needs no further cleanup.
            }
          }
        }, 2_000)
      }
      for (const signal of parentSignals) process.once(signal, onParentTermination)

      const timeout = (reason) => {
        if (settled || timedOut || parentTerminating) return
        timedOut = true
        timeoutReason = reason
        child.stdin.destroy()
        terminateChild()
      }

      const refreshInactivityWatchdog = () => {
        if (settled || timedOut || parentTerminating || inactivityTimeoutMs == null) return
        if (inactivityTimer) clearTimeout(inactivityTimer)
        inactivityTimer = setTimeout(() => timeout('inactivity'), inactivityTimeoutMs)
      }

      const append = (chunks, chunk, stream) => {
        refreshInactivityWatchdog()
        if (typeof options.reportProgress === 'function') options.reportProgress(stream)
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (stream === 'stdout') stdoutBytes += buffer.length
        else stderrBytes += buffer.length
        if (stdoutBytes + stderrBytes > options.maxBytes) {
          outputExceeded = true
          terminateChild()
          return
        }
        chunks.push(buffer)
      }
      child.stdout.on('data', (chunk) => append(stdout, chunk, 'stdout'))
      child.stderr.on('data', (chunk) => append(stderr, chunk, 'stderr'))
      child.once('spawn', () => {
        refreshInactivityWatchdog()
        if (typeof options.reportProgress === 'function') options.reportProgress('spawn')
      })
      child.stdin.on('error', () => {})
      child.stdin.end(typeof options.input === 'string' ? options.input : '', 'utf8')

      refreshInactivityWatchdog()
      if (Number.isFinite(hardTimeoutMs) && hardTimeoutMs > 0) {
        hardTimer = setTimeout(() => timeout('hard_limit'), hardTimeoutMs)
      }

      child.on('error', (error) => finish({ exitCode: null, signal: null, error: error.message }))
      child.on('close', (exitCode, signal) => {
        finish({ exitCode, signal, error: null })
        if (parentTerminating) process.exit(1)
      })
    })
  }

  function digest(value, length) {
    return crypto.createHash('sha256').update(value).digest('hex').slice(0, length || 24)
  }

  function firstLine(value) {
    return String(value || '').split(/\r?\n/).map((line) => line.trim()).find(Boolean) || ''
  }

  function pathIsWithin(root, candidate) {
    const child = path.relative(root, candidate)
    return child === '' || (!child.startsWith('..' + path.sep) && child !== '..' && !path.isAbsolute(child))
  }

  function validateWorkspaceKey(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 512 || /[\u0000-\u001f\u007f]/.test(value)) {
      throw bridgeError('invalid_workspace_key', 'A stable Ensync conversation workspace key is required for remote agent execution.')
    }
    return value
  }

  function parseWorktrees(value) {
    const worktrees = []
    let current = null
    for (const line of String(value).split(/\r?\n/)) {
      if (!line) {
        if (current) worktrees.push(current)
        current = null
        continue
      }
      const separator = line.indexOf(' ')
      const field = separator === -1 ? line : line.slice(0, separator)
      const fieldValue = separator === -1 ? true : line.slice(separator + 1)
      if (field === 'worktree') {
        if (current) worktrees.push(current)
        current = { path: fieldValue, branch: null, prunable: false }
      } else if (current && field === 'branch') current.branch = fieldValue
      else if (current && field === 'prunable') current.prunable = true
    }
    if (current) worktrees.push(current)
    return worktrees
  }

  async function runGit(gitExecutable, cwd, args, options) {
    const result = await runCaptured(gitExecutable, args, {
      cwd,
      env: options.environment,
      input: '',
      timeoutMs: 30_000,
      maxBytes: MAX_PROBE_BYTES,
    })
    if (result.error || result.timedOut || result.outputExceeded || (result.exitCode !== 0 && !options.allowFailure)) {
      throw bridgeError(
        options.code || 'project_isolation_failed',
        firstLine(result.stderr) || options.message || 'Git could not prepare a protected remote Ensync workspace.',
      )
    }
    return result
  }

  async function canonicalDirectory(candidate, code, message) {
    try {
      const canonical = fs.realpathSync.native ? fs.realpathSync.native(candidate) : fs.realpathSync(candidate)
      if (!fs.statSync(canonical).isDirectory()) throw new Error('not a directory')
      return canonical
    } catch {
      throw bridgeError(code, message)
    }
  }

  async function snapshotRemoteSharedCheckout(gitExecutable, repository, environment) {
    const snapshotParent = path.join(repository.commonGitDirectory, 'ensync')
    await fs.promises.mkdir(snapshotParent, { recursive: true, mode: 0o700 })
    const snapshotDirectory = await fs.promises.mkdtemp(path.join(snapshotParent, 'workspace-snapshot-'))
    const snapshotEnvironment = {
      ...environment,
      GIT_INDEX_FILE: path.join(snapshotDirectory, 'index'),
      GIT_WORK_TREE: repository.path,
      GIT_AUTHOR_NAME: 'Ensync Workspace Snapshot',
      GIT_AUTHOR_EMAIL: 'workspace-snapshot@ensync.local',
      GIT_AUTHOR_DATE: new Date().toISOString(),
      GIT_COMMITTER_NAME: 'Ensync Workspace Snapshot',
      GIT_COMMITTER_EMAIL: 'workspace-snapshot@ensync.local',
      GIT_COMMITTER_DATE: new Date().toISOString(),
    }
    try {
      await runGit(gitExecutable, repository.path, ['read-tree', repository.head], {
        environment: snapshotEnvironment,
      })
      await runGit(gitExecutable, repository.path, ['add', '-A', '--', '.'], {
        environment: snapshotEnvironment,
        code: 'shared_checkout_snapshot_failed',
        message: 'Git could not capture the remote shared checkout for the protected workspace.',
      })
      const tree = await runGit(gitExecutable, repository.path, ['write-tree'], {
        environment: snapshotEnvironment,
      })
      const commit = await runGit(
        gitExecutable,
        repository.path,
        ['commit-tree', firstLine(tree.stdout), '-p', repository.head, '-m', 'Ensync protected workspace snapshot'],
        {
          environment: snapshotEnvironment,
          code: 'shared_checkout_snapshot_failed',
          message: 'Git could not finalize the remote protected workspace snapshot.',
        },
      )
      return firstLine(commit.stdout)
    } finally {
      await fs.promises.rm(snapshotDirectory, { recursive: true, force: true }).catch(() => {})
    }
  }

  async function acquireRemoteWorkspaceLease(commonGitDirectory, key) {
    const workspaceHash = digest(key)
    const lockParent = path.join(commonGitDirectory, 'ensync', 'workspace-write-locks')
    const lockPath = path.join(lockParent, workspaceHash + '.lock')
    const ownerPath = path.join(lockPath, 'owner.json')
    await fs.promises.mkdir(lockParent, { recursive: true, mode: 0o700 })

    for (;;) {
      const token = crypto.randomUUID()
      const acquiredAt = new Date().toISOString()
      try {
        await fs.promises.mkdir(lockPath, { mode: 0o700 })
      } catch (error) {
        if (error && error.code !== 'EEXIST') throw error
        let freshest
        let ownerPid = null
        try {
          const ownerInfo = await fs.promises.stat(ownerPath)
          const lockInfo = await fs.promises.stat(lockPath)
          freshest = Math.max(ownerInfo.mtimeMs, lockInfo.mtimeMs)
          try {
            const owner = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8'))
            if (Number.isInteger(owner && owner.pid) && owner.pid > 0) ownerPid = owner.pid
            const heartbeat = Date.parse(owner && owner.heartbeatAt || '')
            if (Number.isFinite(heartbeat)) freshest = Math.max(freshest, heartbeat)
          } catch {
            // File mtimes remain the conservative fallback for incomplete metadata.
          }
        } catch {
          try { freshest = (await fs.promises.stat(lockPath)).mtimeMs } catch { continue }
        }
        let ownerAlive = false
        if (ownerPid) {
          try {
            process.kill(ownerPid, 0)
            ownerAlive = true
          } catch (livenessError) {
            ownerAlive = Boolean(livenessError && livenessError.code === 'EPERM')
          }
        }
        if (!ownerAlive && Date.now() - freshest > 30_000) {
          const quarantine = lockPath + '.stale-' + crypto.randomUUID()
          try {
            await fs.promises.rename(lockPath, quarantine)
            await fs.promises.rm(quarantine, { recursive: true, force: true })
            continue
          } catch (quarantineError) {
            if (quarantineError && quarantineError.code === 'ENOENT') continue
          }
        }
        sendProgress('workspace_lock_wait')
        await new Promise((resolveWait) => setTimeout(resolveWait, 250))
        continue
      }

      try {
        let released = false
        const owner = () => JSON.stringify({
          version: 2,
          token,
          pid: process.pid,
          workspaceHash,
          acquiredAt,
          heartbeatAt: new Date().toISOString(),
        })
        const writeOwner = async () => {
          await fs.promises.writeFile(ownerPath, owner(), { encoding: 'utf8', mode: 0o600 })
          try { await fs.promises.chmod(ownerPath, 0o600) } catch { /* Windows ACLs remain user-scoped. */ }
        }
        await writeOwner()
        const heartbeat = setInterval(() => {
          void (async () => {
            try {
              const current = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8'))
              if (!current || current.token !== token) throw new Error('Remote protected workspace write lease ownership changed.')
              await writeOwner()
            } catch {
              clearInterval(heartbeat)
              try { process.kill(process.pid, 'SIGTERM') } catch { process.exit(1) }
            }
          })()
        }, 5_000)
        heartbeat.unref && heartbeat.unref()
        return {
          release: async () => {
            if (released) return
            released = true
            clearInterval(heartbeat)
            try {
              const current = JSON.parse(await fs.promises.readFile(ownerPath, 'utf8'))
              if (current && current.token === token) {
                await fs.promises.rm(lockPath, { recursive: true, force: true })
              }
            } catch {
              // A missing or replaced lock cannot authorize deleting another lease.
            }
          },
        }
      } catch (error) {
        await fs.promises.rm(lockPath, { recursive: true, force: true }).catch(() => {})
        throw error
      }
    }
  }

  async function prepareRemoteWorkspace(projectPath, rawWorkspaceKey, environment) {
    const key = validateWorkspaceKey(rawWorkspaceKey)
    const git = findExecutable(['git'])
    if (!git || !git.directlyRunnable) {
      throw bridgeError(
        'project_isolation_required',
        'Remote agent execution requires a directly runnable Git installation so Ensync can isolate changes.',
      )
    }
    const topLevel = await runGit(git.executable, projectPath, ['rev-parse', '--show-toplevel'], {
      environment,
      code: 'project_isolation_required',
      message: 'Remote agent execution requires a Git working tree.',
    })
    const repositoryPath = await canonicalDirectory(
      firstLine(topLevel.stdout),
      'project_isolation_required',
      'Ensync could not verify the remote Git working tree.',
    )
    if (!pathIsWithin(repositoryPath, projectPath)) {
      throw bridgeError('project_isolation_required', 'The remote project is not contained by its Git working tree.')
    }
    const commonResult = await runGit(git.executable, projectPath, ['rev-parse', '--git-common-dir'], { environment })
    const commonValue = firstLine(commonResult.stdout)
    const commonGitDirectory = await canonicalDirectory(
      path.isAbsolute(commonValue) ? commonValue : path.resolve(repositoryPath, commonValue),
      'project_isolation_required',
      'Ensync could not verify the remote shared Git directory.',
    )
    const headResult = await runGit(git.executable, repositoryPath, ['rev-parse', '--verify', 'HEAD'], {
      environment,
      code: 'project_baseline_unavailable',
      message: 'Create an initial remote Git commit before starting an isolated Ensync workspace.',
    })
    const repository = {
      path: repositoryPath,
      commonGitDirectory,
      head: firstLine(headResult.stdout),
    }
    const lease = await acquireRemoteWorkspaceLease(commonGitDirectory, key)

    try {
      const workspaceHash = digest(key)
      const repositoryHash = digest(commonGitDirectory)
      const branch = 'ensync/chat-' + workspaceHash
      const branchRef = 'refs/heads/' + branch
      const configuredPath = path.join(os.homedir(), '.ensync', 'agent-workspaces-v1', repositoryHash, workspaceHash)
      const list = await runGit(git.executable, repositoryPath, ['worktree', 'list', '--porcelain'], { environment })
      const registered = parseWorktrees(list.stdout).find((worktree) => worktree.branch === branchRef)
      let worktreePath
      let reused = false
      let seededFromSharedCheckout = false
      if (registered) {
        if (registered.prunable) {
          throw bridgeError('managed_worktree_missing', 'The protected remote Ensync worktree is missing. Repair its Git worktree registration before continuing.')
        }
        worktreePath = await canonicalDirectory(
          registered.path,
          'managed_worktree_missing',
          'The protected remote Ensync worktree is missing or inaccessible.',
        )
        reused = true
      } else {
        const branchCheck = await runGit(git.executable, repositoryPath, ['show-ref', '--verify', '--quiet', branchRef], {
          environment,
          allowFailure: true,
        })
        const branchExists = branchCheck.exitCode === 0
        let startingPoint = repository.head
        if (!branchExists) {
          const status = await runGit(git.executable, repositoryPath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { environment })
          const changedFiles = status.stdout.split('\0').filter(Boolean).length
          if (changedFiles > 0) {
            startingPoint = await snapshotRemoteSharedCheckout(git.executable, repository, environment)
            seededFromSharedCheckout = true
          }
        }
        await fs.promises.mkdir(path.dirname(configuredPath), { recursive: true, mode: 0o700 })
        await runGit(
          git.executable,
          repositoryPath,
          branchExists
            ? ['worktree', 'add', configuredPath, branch]
            : ['worktree', 'add', '-b', branch, configuredPath, startingPoint],
          {
            environment,
            code: 'managed_worktree_create_failed',
            message: 'Git could not create the protected remote Ensync worktree.',
          },
        )
        worktreePath = await canonicalDirectory(
          configuredPath,
          'managed_worktree_create_failed',
          'The protected remote Ensync worktree was not created correctly.',
        )
        if (seededFromSharedCheckout) {
          await runGit(git.executable, worktreePath, ['reset', '--mixed', repository.head], {
            environment,
            code: 'managed_worktree_create_failed',
            message: 'Git could not expose the remote shared-checkout snapshot in the protected workspace.',
          })
        }
      }

      const actualBranch = await runGit(git.executable, worktreePath, ['symbolic-ref', '--quiet', '--short', 'HEAD'], {
        environment,
        code: 'managed_worktree_mismatch',
        message: 'The protected remote Ensync worktree is detached or on another branch.',
      })
      if (firstLine(actualBranch.stdout) !== branch) {
        throw bridgeError('managed_worktree_mismatch', 'The protected remote Ensync worktree changed branches.')
      }
      const projectRelativePath = path.relative(repositoryPath, projectPath)
      const workspaceCandidate = path.resolve(worktreePath, projectRelativePath)
      const workspaceProjectPath = await canonicalDirectory(
        workspaceCandidate,
        'managed_project_missing',
        'The selected remote project directory is missing from its protected worktree.',
      )
      if (!pathIsWithin(worktreePath, workspaceProjectPath)) {
        throw bridgeError('managed_worktree_mismatch', 'The remote isolated project escaped its protected worktree.')
      }
      const status = await runGit(git.executable, worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { environment })
      const changedFiles = status.stdout.split('\0').filter(Boolean).length
      const head = await runGit(git.executable, worktreePath, ['rev-parse', '--verify', 'HEAD'], { environment })
      return {
        lease,
        workspace: {
          path: workspaceProjectPath,
          repositoryPath: worktreePath,
          branch,
          reused,
          seededFromSharedCheckout,
          gitBefore: {
            branch,
            head: firstLine(head.stdout),
            dirty: changedFiles > 0,
            changedFiles,
            checkedAt: new Date().toISOString(),
          },
        },
      }
    } catch (error) {
      await lease.release()
      throw error
    }
  }

  function authFrom(provider, result) {
    const output = (result.stdout + '\n' + result.stderr).trim()
    const lower = output.toLowerCase()
    if (result.timedOut || result.error || result.outputExceeded) {
      return { state: 'unavailable', method: null, reason: 'The remote authentication probe failed.' }
    }
    if (provider === 'codex') {
      if (result.exitCode === 0 && lower.includes('logged in')) {
        return {
          state: 'authenticated',
          method: lower.includes('chatgpt') ? 'ChatGPT login' : 'CLI login',
          reason: 'Remote Codex reports an active login.',
        }
      }
      if (lower.includes('not logged in') || lower.includes('not authenticated')) {
        return { state: 'not_authenticated', method: null, reason: 'Remote Codex is not logged in.' }
      }
      return { state: 'unavailable', method: null, reason: 'Remote Codex returned no recognized authentication status.' }
    }

    const start = output.indexOf('{')
    const end = output.lastIndexOf('}')
    if (start !== -1 && end > start) {
      try {
        const parsed = JSON.parse(output.slice(start, end + 1))
        if (typeof parsed.loggedIn === 'boolean') {
          return {
            state: parsed.loggedIn ? 'authenticated' : 'not_authenticated',
            method: parsed.loggedIn && typeof parsed.authMethod === 'string' ? parsed.authMethod : null,
            reason: parsed.loggedIn
              ? 'Remote Claude Code reports an active login.'
              : 'Remote Claude Code is not logged in.',
            exactPlan: typeof parsed.subscriptionType === 'string' ? parsed.subscriptionType : null,
          }
        }
      } catch {
        // The explicit unavailable state below is more useful than an exception.
      }
    }
    return { state: 'unavailable', method: null, reason: 'Remote Claude Code returned no recognized authentication status.' }
  }

  function subscriptionAuthenticationAllowed(provider, authentication) {
    const method = (authentication && authentication.method || '').toLowerCase()
    if (provider === 'codex') return method.includes('chatgpt')
    return provider === 'claude'
      && ['claude.ai', 'oauth', 'subscription'].some((signal) => method.includes(signal))
  }

  async function probe(payload) {
    const projectPath = canonicalProject(payload.projectPath)
    const environment = cleanEnvironment(process.env)
    const gitExecutable = findExecutable(['git'])
    let git = { installed: Boolean(gitExecutable), executable: gitExecutable && gitExecutable.executable, version: null }
    if (gitExecutable && gitExecutable.directlyRunnable) {
      const result = await runCaptured(gitExecutable.executable, ['--version'], {
        cwd: projectPath,
        env: environment,
        input: '',
        timeoutMs: 8_000,
        maxBytes: MAX_PROBE_BYTES,
      })
      git = {
        ...git,
        version: result.exitCode === 0 ? (result.stdout || result.stderr).trim() || null : null,
        stdout: result.stdout,
        stderr: result.stderr,
      }
    }

    const providers = await Promise.all(PROVIDERS.map(async (definition) => {
      const found = findExecutable(definition.commands)
      if (!found) {
        return {
          id: definition.id,
          installed: false,
          command: definition.commands[0],
          executable: null,
          directlyRunnable: false,
          version: null,
          authentication: null,
        }
      }
      if (!found.directlyRunnable) {
        return {
          id: definition.id,
          installed: true,
          command: found.command,
          executable: found.executable,
          directlyRunnable: false,
          version: null,
          authentication: null,
          reason: 'The discovered Windows command shim cannot be run by the shell-free remote bridge.',
        }
      }
      const versionResult = await runCaptured(found.executable, definition.versionArgs, {
        cwd: projectPath,
        env: environment,
        input: '',
        timeoutMs: 8_000,
        maxBytes: MAX_PROBE_BYTES,
      })
      let authentication = null
      let authenticationProbe = null
      if (definition.id === 'codex' || definition.id === 'claude') {
        authenticationProbe = await runCaptured(
          found.executable,
          definition.id === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'],
          {
            cwd: projectPath,
            env: environment,
            input: '',
            timeoutMs: 8_000,
            maxBytes: MAX_PROBE_BYTES,
          },
        )
        authentication = authFrom(definition.id, authenticationProbe)
      }
      return {
        id: definition.id,
        installed: true,
        command: found.command,
        executable: found.executable,
        directlyRunnable: true,
        version: versionResult.exitCode === 0
          ? (versionResult.stdout || versionResult.stderr).trim() || null
          : null,
        versionProbe: {
          exitCode: versionResult.exitCode,
          stdout: versionResult.stdout,
          stderr: versionResult.stderr,
        },
        authentication,
        authenticationProbe: authenticationProbe && {
          exitCode: authenticationProbe.exitCode,
          stdout: authenticationProbe.stdout,
          stderr: authenticationProbe.stderr,
        },
      }
    }))

    return {
      operation: 'probe',
      remote: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        hostname: os.hostname(),
      },
      node: { available: true, version: process.version, executable: process.execPath },
      project: { requestedPath: payload.projectPath, canonicalPath: projectPath },
      git,
      providers,
      checkedAt: new Date().toISOString(),
    }
  }

  async function runChat(payload) {
    if (!['codex', 'claude'].includes(payload.provider)) {
      throw bridgeError('unsupported_provider', 'Remote chat supports Codex and Claude Code only.')
    }
    if (payload.effort != null && !['low', 'medium', 'high', 'max'].includes(payload.effort)) {
      throw bridgeError('invalid_effort', 'Remote model effort must be low, medium, high, or max.')
    }
    const projectPath = canonicalProject(payload.projectPath)
    const found = findExecutable([payload.provider])
    if (!found) {
      throw bridgeError('provider_unavailable', 'The requested provider is not installed on the remote PATH.')
    }
    if (!found.directlyRunnable) {
      throw bridgeError(
        'provider_unavailable',
        'The discovered Windows command shim cannot be run by the shell-free remote bridge.',
      )
    }
    const environment = cleanEnvironment(process.env)
    const authProbe = await runCaptured(
      found.executable,
      payload.provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json'],
      {
        cwd: projectPath,
        env: environment,
        input: '',
        timeoutMs: 8_000,
        maxBytes: MAX_PROBE_BYTES,
      },
    )
    const authentication = authFrom(payload.provider, authProbe)
    if (authentication.state !== 'authenticated') {
      throw bridgeError('provider_not_authenticated', authentication.reason)
    }
    if (!subscriptionAuthenticationAllowed(payload.provider, authentication)) {
      throw bridgeError(
        'subscription_auth_required',
        'The remote provider must use its subscription login; API-key and alternate paid-provider routes are blocked.',
      )
    }

    const isolated = await prepareRemoteWorkspace(projectPath, payload.workspaceKey, environment)
    const protectedPrompt = '[ENSYNC HOST WORKSPACE ISOLATION]\n'
      + 'This run is bound to the protected Git worktree that is the current working directory.\n'
      + 'Treat the current working directory as the only writable project. Do not access or modify another checkout or worktree of this repository, even if earlier context names a canonical path.\n'
      + 'Protected branch: ' + isolated.workspace.branch + '\n'
      + 'Verified worktree state before this run: '
      + (isolated.workspace.gitBefore.dirty ? isolated.workspace.gitBefore.changedFiles + ' changed files' : 'clean')
      + ' at ' + isolated.workspace.gitBefore.head + '.\n\n'
      + payload.prompt
    let result
    try {
      result = await runCaptured(found.executable, chatArguments(payload), {
        cwd: isolated.workspace.path,
        env: environment,
        input: protectedPrompt,
        inactivityTimeoutMs: payload.inactivityTimeoutMs ?? payload.timeoutMs,
        hardTimeoutMs: Object.hasOwn(payload, 'hardTimeoutMs')
          ? payload.hardTimeoutMs
          : payload.timeoutMs,
        maxBytes: MAX_CHAT_BYTES,
        reportProgress: sendProgress,
      })
    } finally {
      await isolated.lease.release()
    }
    return {
      operation: 'chat',
      provider: payload.provider,
      projectPath,
      workspace: isolated.workspace,
      executable: found.executable,
      authentication,
      process: result,
      sharedCheckout,
      remote: {
        platform: os.platform(),
        release: os.release(),
        arch: os.arch(),
        hostname: os.hostname(),
        nodeVersion: process.version,
      },
      completedAt: new Date().toISOString(),
    }
  }

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, 'base64').toString('utf8'))
    const result = payload.operation === 'probe'
      ? await probe(payload)
      : payload.operation === 'chat'
        ? await runChat(payload)
        : (() => { throw bridgeError('invalid_operation', 'Unknown Ensync SSH bridge operation.') })()
    send({ ok: true, result })
  } catch (error) {
    send({
      ok: false,
      error: {
        code: typeof error.code === 'string' ? error.code : 'remote_bridge_failed',
        message: error instanceof Error ? error.message : 'The remote Ensync bridge failed.',
        details: error && error.details,
      },
    })
  }
}

export function createRemoteBridgeInput(payload) {
  const encodedPayload = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64')
  return `;(${remoteBridgeMain.toString()})(${JSON.stringify(encodedPayload)},${remoteChatArguments.toString()});\n`
}

export function encodeRemoteBridgeEnvelope(value) {
  const json = JSON.stringify({ protocol: BRIDGE_PROTOCOL, ...value })
  return `ENSYNC_SSH_BRIDGE_V1:${Buffer.from(json, 'utf8').toString('base64')}`
}

export function decodeRemoteBridgeEnvelope(stdout) {
  const prefix = 'ENSYNC_SSH_BRIDGE_V1:'
  if (typeof stdout !== 'string' || !stdout.startsWith(prefix)) return null
  try {
    const parsed = JSON.parse(Buffer.from(stdout.slice(prefix.length), 'base64').toString('utf8'))
    return parsed && parsed.protocol === BRIDGE_PROTOCOL ? parsed : null
  } catch {
    return null
  }
}
