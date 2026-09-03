import { constants as fsConstants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { execFile as execFileCallback, spawn } from 'node:child_process'
import { homedir } from 'node:os'
import { promisify } from 'node:util'

const execFile = promisify(execFileCallback)

const API_KEY_NAMES = new Set([
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

function isPaidProviderOverride(key) {
  return API_KEY_NAMES.has(key)
    || /^JUNIE_[A-Z0-9_]+_API_KEY$/.test(key)
    || /^KIMI_MODEL_[A-Z0-9_]+$/.test(key)
}

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g
const MAX_CAPTURE_BYTES = 256 * 1024
const CAPTURE_HEAD_RATIO = 0.25

async function posixDescendants(rootPid) {
  try {
    const { stdout } = await execFile('ps', ['-A', '-o', 'pid=', '-o', 'ppid=', '-o', 'lstart='], {
      encoding: 'utf8',
      maxBuffer: 512 * 1024,
      timeout: 2_000,
    })
    const children = new Map()
    for (const line of stdout.split(/\r?\n/)) {
      const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/)
      if (!match) continue
      const pid = Number(match[1])
      const parent = Number(match[2])
      const identity = match[3].replace(/\s+/g, ' ').trim()
      const values = children.get(parent) ?? []
      values.push({ pid, identity })
      children.set(parent, values)
    }
    const result = []
    const visit = (parent) => {
      for (const child of children.get(parent) ?? []) {
        visit(child.pid)
        result.push(child)
      }
    }
    visit(rootPid)
    return result
  } catch {
    return []
  }
}

async function posixProcessIdentity(pid) {
  try {
    const { stdout } = await execFile('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      maxBuffer: 16 * 1024,
      timeout: 2_000,
    })
    return stdout.replace(/\s+/g, ' ').trim() || null
  } catch {
    return null
  }
}

function descendantProcesses(rootPid, processes) {
  const children = new Map()
  for (const process of processes) {
    const values = children.get(process.parentPid) ?? []
    values.push(process)
    children.set(process.parentPid, values)
  }
  const result = []
  const visit = (parentPid) => {
    for (const process of children.get(parentPid) ?? []) {
      visit(process.pid)
      result.push(process)
    }
  }
  visit(rootPid)
  return result
}

async function windowsProcessSnapshot() {
  const script = [
    "$ErrorActionPreference='Stop'",
    '@(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,CreationDate) | ConvertTo-Json -Compress',
  ].join(';')
  try {
    const { stdout } = await execFile('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
    ], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 5_000,
      windowsHide: true,
    })
    const parsed = JSON.parse(stdout)
    const records = Array.isArray(parsed) ? parsed : [parsed]
    return records.flatMap((record) => {
      const pid = Number(record?.ProcessId)
      const parentPid = Number(record?.ParentProcessId)
      const identity = typeof record?.CreationDate === 'string' ? record.CreationDate : ''
      return Number.isInteger(pid) && pid > 0 && Number.isInteger(parentPid) && identity
        ? [{ pid, parentPid, identity }]
        : []
    })
  } catch {
    return null
  }
}

async function taskkill(pid, force, spawnProcess = spawn) {
  return new Promise((resolveTermination) => {
    const killer = spawnProcess('taskkill', [
      '/PID', String(pid), '/T', ...(force ? ['/F'] : []),
    ], { shell: false, stdio: 'ignore', windowsHide: true })
    killer.once('error', () => resolveTermination(false))
    killer.once('close', (code) => resolveTermination(code === 0))
  })
}

async function terminateProcessTree(child, force, retainedPids, options = {}) {
  if (!Number.isInteger(child.pid) || child.pid <= 0) return false
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    const snapshot = await (options.windowsSnapshot ?? windowsProcessSnapshot)(child.pid)
    if (!snapshot) return false
    for (const process of descendantProcesses(child.pid, snapshot)) {
      retainedPids.set(process.pid, process.identity)
    }
    if (child.exitCode === null && child.signalCode === null) {
      return (options.taskkill ?? taskkill)(child.pid, force, options.spawn ?? spawn)
    }
    let confirmed = true
    const current = new Map(snapshot.map((process) => [process.pid, process.identity]))
    for (const [pid, identity] of retainedPids) {
      if (current.get(pid) !== identity) continue
      if (!(await (options.taskkill ?? taskkill)(pid, force, options.spawn ?? spawn))) confirmed = false
    }
    return confirmed
  }
  for (const process of await posixDescendants(child.pid)) retainedPids.set(process.pid, process.identity)
  const signal = force ? 'SIGKILL' : 'SIGTERM'
  try { process.kill(-child.pid, signal) } catch { /* individually captured PIDs remain */ }
  for (const [pid, identity] of retainedPids) {
    if (await posixProcessIdentity(pid) !== identity) continue
    try { process.kill(pid, signal) } catch { /* an exited descendant needs no cleanup */ }
  }
  try { child.kill(signal) } catch { /* close/error remains authoritative */ }
  return true
}

async function processTreeIsQuiescent(child, retainedPids, terminationConfirmed, options = {}) {
  const platform = options.platform ?? process.platform
  if (platform === 'win32') {
    if (!terminationConfirmed) return false
    const snapshot = await (options.windowsSnapshot ?? windowsProcessSnapshot)(child.pid)
    if (!snapshot) return false
    const current = new Map(snapshot.map((process) => [process.pid, process.identity]))
    if (descendantProcesses(child.pid, snapshot).length > 0) return false
    return [...retainedPids].every(([pid, identity]) => current.get(pid) !== identity)
  }
  await new Promise((resolveCheck) => setTimeout(resolveCheck, 20))
  try {
    process.kill(-child.pid, 0)
    return false
  } catch {
    // An absent process group is the expected successful state.
  }
  for (const [pid, identity] of retainedPids) {
    if (await posixProcessIdentity(pid) !== identity) continue
    try {
      process.kill(pid, 0)
      return false
    } catch {
      // An exited captured descendant is quiescent.
    }
  }
  return true
}

/**
 * Bounded process-output capture that discards only whole lines from the middle
 * of a stream. Provider protocols put session identity in their first events and
 * terminal completion plus the final response in their last, so a blind
 * head-slice at the capture limit destroys the proof that a finished run
 * succeeded and leaves a partial event line behind. Keeping a head and a rolling
 * tail preserves both ends, keeps every retained line machine-readable, and
 * reports exactly how much was dropped so callers can refuse to treat an
 * incomplete stream as evidence.
 */
export class BoundedOutputCapture {
  #maxCharacters
  #headBudget
  #head = []
  #headCharacters = 0
  #tail = []
  #tailStart = 0
  #tailCharacters = 0
  #pending = ''
  #pendingDroppedCharacters = 0
  #droppedLineCount = 0
  #droppedCharacterCount = 0

  constructor(maxCharacters, options = {}) {
    this.#maxCharacters = Math.max(0, Math.trunc(maxCharacters))
    this.#headBudget = Math.trunc(this.#maxCharacters * (options.headRatio ?? CAPTURE_HEAD_RATIO))
  }

  #retainedCharacters() {
    return this.#headCharacters + this.#tailCharacters + this.#pending.length
  }

  #tailLineCount() {
    return this.#tail.length - this.#tailStart
  }

  #evictTail() {
    while (this.#retainedCharacters() > this.#maxCharacters && this.#tailLineCount() > 0) {
      const line = this.#tail[this.#tailStart]
      this.#tail[this.#tailStart] = ''
      this.#tailStart += 1
      this.#tailCharacters -= line.length
      this.#droppedLineCount += 1
      this.#droppedCharacterCount += line.length
      if (this.#tailStart > 1_024 && this.#tailStart * 2 > this.#tail.length) {
        this.#tail = this.#tail.slice(this.#tailStart)
        this.#tailStart = 0
      }
    }
  }

  #growPending(part) {
    this.#pending += part
    this.#evictTail()
    const room = Math.max(0, this.#maxCharacters - this.#headCharacters - this.#tailCharacters)
    if (this.#pending.length <= room) return
    // Only the in-progress line can still exceed the budget. Clip it now and
    // keep counting so the completed line can be discarded in full.
    const overflow = this.#pending.length - room
    this.#pending = this.#pending.slice(0, room)
    this.#pendingDroppedCharacters += overflow
    this.#droppedCharacterCount += overflow
  }

  #completePendingLine() {
    const line = this.#pending
    this.#pending = ''
    if (this.#pendingDroppedCharacters > 0) {
      // A line that cannot fit the whole budget is dropped entirely rather than
      // retained as a fragment that no protocol parser could verify.
      this.#pendingDroppedCharacters = 0
      this.#droppedLineCount += 1
      this.#droppedCharacterCount += line.length
      return
    }
    if (this.#tailLineCount() === 0 && this.#headCharacters + line.length <= this.#headBudget) {
      this.#head.push(line)
      this.#headCharacters += line.length
    } else {
      this.#tail.push(line)
      this.#tailCharacters += line.length
    }
    this.#evictTail()
  }

  append(text) {
    if (typeof text !== 'string' || !text) return
    let start = 0
    while (start < text.length) {
      const newlineIndex = text.indexOf('\n', start)
      if (newlineIndex === -1) {
        this.#growPending(text.slice(start))
        return
      }
      this.#growPending(text.slice(start, newlineIndex + 1))
      this.#completePendingLine()
      start = newlineIndex + 1
    }
  }

  get text() {
    return `${this.#head.join('')}${this.#tail.slice(this.#tailStart).join('')}${this.#pending}`
  }

  get truncation() {
    if (this.#droppedLineCount === 0 && this.#droppedCharacterCount === 0) return null
    return {
      droppedLineCount: this.#droppedLineCount,
      droppedCharacterCount: this.#droppedCharacterCount,
    }
  }
}

const MIN_CONFIGURED_HARD_TIMEOUT_MS = 1_000

// The hard ceiling is a runaway-process backstop. The inactivity watchdog is
// responsible for detecting a hung provider, so by default there is no absolute
// ceiling at all (null). An operator may pin one explicitly through
// ENSYNC_CHAT_HARD_TIMEOUT_MS; a value that cannot be verified as a safe
// integer falls back to the caller's conservative ceiling instead of silently
// meaning "unlimited".
export function configuredHardTimeoutMs(environment, invalidFallbackMs) {
  const raw = environment?.ENSYNC_CHAT_HARD_TIMEOUT_MS
  if (typeof raw !== 'string' || raw.trim() === '') return null
  const parsed = Number(raw.trim())
  if (!Number.isSafeInteger(parsed) || parsed < MIN_CONFIGURED_HARD_TIMEOUT_MS) return invalidFallbackMs
  return parsed
}

export function subscriptionEnvironment(source = process.env) {
  const clean = {}

  for (const [key, value] of Object.entries(source)) {
    if (!isPaidProviderOverride(key.toUpperCase()) && value !== undefined) {
      clean[key] = value
    }
  }

  clean.NO_COLOR = '1'
  clean.FORCE_COLOR = '0'
  return clean
}

export function cleanOutput(value) {
  return value.replace(ANSI_PATTERN, '').replace(/\r/g, '').trim()
}

export function describeProcessExit(processName, result = {}) {
  const label = typeof processName === 'string' && processName.trim()
    ? processName.trim()
    : 'Process'
  if (Number.isInteger(result.exitCode)) return `${label} exited with code ${result.exitCode}`
  if (typeof result.signal === 'string' && /^[A-Z0-9]+$/.test(result.signal)) {
    return `${label} was terminated by signal ${result.signal}`
  }
  return `${label} stopped without reporting an exit code`
}

export function commandInvocation(executable, args, env = process.env) {
  const isWindowsScript = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(executable)
  return isWindowsScript
    ? {
        executable: env.ComSpec ?? env.COMSPEC ?? 'cmd.exe',
        args: ['/d', '/s', '/c', `""${executable}" ${args.map((arg) => `"${arg.replaceAll('"', '""')}"`).join(' ')}"`],
      }
    : { executable, args }
}

function executableExtensions(platform, env) {
  if (platform !== 'win32') return ['']
  const configured = env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM'
  return configured.split(';').filter(Boolean)
}

async function isExecutable(path, platform) {
  try {
    const info = await stat(path)
    if (!info.isFile()) return false
    await access(path, platform === 'win32' ? fsConstants.F_OK : fsConstants.X_OK)
    return true
  } catch {
    return false
  }
}

export async function findExecutable(command, options = {}) {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const pathValue = env.PATH ?? env.Path ?? env.path ?? ''
  const extensions = executableExtensions(platform, env)
  const homeDirectory = options.homeDirectory ?? homedir()
  const commonDirectories = platform === 'win32'
    ? [
        env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs'),
        env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs', 'kimi-code'),
        env.APPDATA && join(env.APPDATA, 'npm'),
        join(homeDirectory, '.local', 'bin'),
      ]
    : [
        join(homeDirectory, '.local', 'bin'),
        join(homeDirectory, '.kimi-code', 'bin'),
        join(homeDirectory, 'bin'),
        '/opt/homebrew/bin',
        '/usr/local/bin',
      ]
  const directories = [...new Set([
    ...pathValue.split(delimiter).filter(Boolean),
    ...commonDirectories.filter(Boolean),
  ])]

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory.replace(/^"|"$/g, ''), `${command}${extension}`)
      if (await isExecutable(candidate, platform)) return candidate
    }
  }

  return null
}

export function runProcess(executable, args, options = {}) {
  const legacyTimeoutMs = options.timeoutMs ?? 8_000
  const inactivityTimeoutMs = options.inactivityTimeoutMs ?? null
  const questionHoldTimeoutMs = options.questionHoldTimeoutMs ?? null
  const hardTimeoutMs = Object.hasOwn(options, 'hardTimeoutMs')
    ? options.hardTimeoutMs
    : legacyTimeoutMs
  const terminationGraceMs = options.terminationGraceMs ?? 2_000
  const env = options.env ?? subscriptionEnvironment()
  const maxCaptureBytes = options.maxCaptureBytes ?? MAX_CAPTURE_BYTES
  const hasInput = typeof options.input === 'string'
  const invocation = commandInvocation(executable, args, env)
  const killProcessTree = options.killProcessTree === true
  const processTreePlatform = options.processTreePlatform ?? process.platform
  const processTreeOptions = {
    platform: processTreePlatform,
    taskkill: options.processTreeTaskkill,
    windowsSnapshot: options.windowsProcessSnapshot,
  }

  return new Promise((resolve) => {
    const stdoutCapture = new BoundedOutputCapture(maxCaptureBytes)
    const stderrCapture = new BoundedOutputCapture(maxCaptureBytes)
    let settled = false
    let timedOut = false
    let timeoutReason = null
    let aborted = options.signal?.aborted === true
    let forceKillTimer = null
    let inactivityTimer = null
    let hardTimer = null
    let questionHoldTimer = null
    // A CLI that is blocked on a question Ensync put to the person is not hung.
    // The interactive session holds the watchdog for exactly that window.
    let inactivityHeld = false
    let treeTerminationComplete = false
    let treeTerminationStarted = false
    let processTreeQuiescent = !killProcessTree
    let pendingCloseResult = null
    const retainedTreePids = new Map()
    let treeSampleTimer = null
    let treeSampleInFlight = null

    const child = spawn(invocation.executable, invocation.args, {
      cwd: options.cwd,
      env,
      shell: false,
      stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: killProcessTree && processTreePlatform !== 'win32',
      windowsHide: true,
    })

    const sampleProcessTree = () => {
      if (!killProcessTree || processTreePlatform === 'win32' || treeSampleInFlight) return
      treeSampleInFlight = posixDescendants(child.pid)
        .then((processes) => {
          for (const process of processes) retainedTreePids.set(process.pid, process.identity)
        })
        .catch(() => {})
        .finally(() => { treeSampleInFlight = null })
    }
    const quiesceProcessTree = () => {
      if (treeTerminationStarted) return
      treeTerminationStarted = true
      if (treeSampleTimer) clearInterval(treeSampleTimer)
      treeSampleTimer = null
      let terminationConfirmed = false
      void Promise.resolve(treeSampleInFlight)
        .then(() => terminateProcessTree(child, true, retainedTreePids, processTreeOptions))
        .then((confirmed) => {
          terminationConfirmed = confirmed
          return processTreeIsQuiescent(child, retainedTreePids, terminationConfirmed, processTreeOptions)
        })
        .then((quiescent) => { processTreeQuiescent = quiescent })
        .catch(() => { processTreeQuiescent = false })
        .finally(() => {
          treeTerminationComplete = true
          if (pendingCloseResult) finish(pendingCloseResult)
        })
    }
    if (killProcessTree && processTreePlatform !== 'win32') {
      sampleProcessTree()
      treeSampleTimer = setInterval(sampleProcessTree, 50)
      treeSampleTimer.unref?.()
    }

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null || forceKillTimer) return
      if (killProcessTree) {
        void terminateProcessTree(child, false, retainedTreePids, processTreeOptions).catch(() => {})
      } else {
        try {
          child.kill('SIGTERM')
        } catch {
          // The close/error event remains authoritative when the process already exited.
        }
      }
      forceKillTimer = setTimeout(() => {
        if (killProcessTree) {
          quiesceProcessTree()
        } else if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL')
          } catch {
            // A concurrent process exit needs no further cleanup.
          }
        }
      }, terminationGraceMs)
      if (!killProcessTree) forceKillTimer.unref?.()
    }

    const onAbort = () => {
      aborted = true
      child.stdin?.destroy()
      terminate()
    }
    options.signal?.addEventListener('abort', onAbort, { once: true })
    if (aborted) onAbort()

    const timeout = (reason) => {
      if (settled || timedOut || aborted) return
      timedOut = true
      timeoutReason = reason
      child.stdin?.destroy()
      terminate()
    }

    const refreshInactivityWatchdog = () => {
      if (inactivityTimeoutMs === null || settled || timedOut || aborted || inactivityHeld) return
      if (inactivityTimer) clearTimeout(inactivityTimer)
      inactivityTimer = setTimeout(() => timeout('inactivity'), inactivityTimeoutMs)
      inactivityTimer.unref?.()
    }

    child.stdout.on('data', (chunk) => {
      refreshInactivityWatchdog()
      const text = chunk.toString('utf8')
      stdoutCapture.append(text)
      try {
        options.onStdout?.(text)
      } catch {
        // Observers must never be able to change the child-process result.
      }
    })
    child.stderr.on('data', (chunk) => {
      refreshInactivityWatchdog()
      const text = chunk.toString('utf8')
      stderrCapture.append(text)
      try {
        options.onStderr?.(text)
      } catch {
        // Observers must never be able to change the child-process result.
      }
    })

    if (hasInput) {
      child.stdin.on('error', () => {
        // A CLI may close stdin before consuming it; its exit status remains authoritative.
      })
      // A bidirectional CLI protocol needs stdin to stay open after the prompt:
      // the caller closes it once the stream reports its own terminal frame.
      if (options.keepStdinOpen) child.stdin.write(options.input, 'utf8')
      else child.stdin.end(options.input, 'utf8')
    }

    // Handed out only after stdin exists, so a session can answer the CLI
    // without ever reaching the child process itself.
    options.onSession?.({
      write: (chunk) => {
        if (!hasInput || child.stdin.destroyed || child.stdin.writableEnded) return false
        child.stdin.write(chunk, 'utf8')
        return true
      },
      endInput: () => {
        if (!hasInput || child.stdin.destroyed || child.stdin.writableEnded) return false
        child.stdin.end()
        return true
      },
      // Holding the watchdog is what keeps a person's thinking time from
      // reading as a hung CLI, but an unanswered question must never pin the
      // run — and through it this conversation's process-local ownership — forever.
      // Every hold therefore carries its own bound, and answering hands the
      // run straight back to the ordinary inactivity watchdog.
      holdInactivity: () => {
        inactivityHeld = true
        if (inactivityTimer) clearTimeout(inactivityTimer)
        inactivityTimer = null
        if (questionHoldTimer) clearTimeout(questionHoldTimer)
        questionHoldTimer = null
        if (questionHoldTimeoutMs === null || settled || timedOut || aborted) return
        questionHoldTimer = setTimeout(() => timeout('question_unanswered'), questionHoldTimeoutMs)
        questionHoldTimer.unref?.()
      },
      releaseInactivity: () => {
        inactivityHeld = false
        if (questionHoldTimer) clearTimeout(questionHoldTimer)
        questionHoldTimer = null
        refreshInactivityWatchdog()
      },
    })

    child.once('spawn', refreshInactivityWatchdog)
    refreshInactivityWatchdog()
    if (Number.isFinite(hardTimeoutMs) && hardTimeoutMs > 0) {
      hardTimer = setTimeout(() => timeout('hard_limit'), hardTimeoutMs)
      hardTimer.unref?.()
    }

    const finish = (result) => {
      if (settled) return
      if (killProcessTree && !treeTerminationComplete) {
        pendingCloseResult = result
        if (!forceKillTimer) quiesceProcessTree()
        return
      }
      settled = true
      if (hardTimer) clearTimeout(hardTimer)
      if (inactivityTimer) clearTimeout(inactivityTimer)
      if (questionHoldTimer) clearTimeout(questionHoldTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
      if (treeSampleTimer) clearInterval(treeSampleTimer)
      options.signal?.removeEventListener('abort', onAbort)
      resolve({
        ...result,
        stdout: cleanOutput(stdoutCapture.text),
        stderr: cleanOutput(stderrCapture.text),
        truncation: {
          stdout: stdoutCapture.truncation,
          stderr: stderrCapture.truncation,
        },
        timedOut,
        timeoutReason,
        aborted,
        processTreeQuiescent,
        outputTruncated: Boolean(stdoutCapture.truncation || stderrCapture.truncation),
      })
    }

    child.on('error', (error) => finish({ exitCode: null, error: error.message }))
    child.on('close', (exitCode, signal) => finish({ exitCode, signal, error: null }))
  })
}
