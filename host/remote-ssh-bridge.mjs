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
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')

  const PROTOCOL = 'ensync-ssh-bridge-v1'
  const MAX_PROBE_BYTES = 512 * 1024
  const MAX_CHAT_BYTES = 4 * 1024 * 1024
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
      const hardTimeoutMs = options.hardTimeoutMs ?? options.timeoutMs
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
      hardTimer = setTimeout(() => timeout('hard_limit'), hardTimeoutMs)

      child.on('error', (error) => finish({ exitCode: null, signal: null, error: error.message }))
      child.on('close', (exitCode, signal) => {
        finish({ exitCode, signal, error: null })
        if (parentTerminating) process.exit(1)
      })
    })
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

    const result = await runCaptured(found.executable, chatArguments(payload), {
      cwd: projectPath,
      env: environment,
      input: payload.prompt,
      inactivityTimeoutMs: payload.inactivityTimeoutMs ?? payload.timeoutMs,
      hardTimeoutMs: payload.hardTimeoutMs ?? payload.timeoutMs,
      maxBytes: MAX_CHAT_BYTES,
      reportProgress: sendProgress,
    })
    return {
      operation: 'chat',
      provider: payload.provider,
      projectPath,
      executable: found.executable,
      authentication,
      process: result,
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
