import { constants as fsConstants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { delimiter, join } from 'node:path'
import { spawn } from 'node:child_process'
import { homedir } from 'node:os'

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
  const hardTimeoutMs = Object.hasOwn(options, 'hardTimeoutMs')
    ? options.hardTimeoutMs
    : legacyTimeoutMs
  const terminationGraceMs = options.terminationGraceMs ?? 2_000
  const env = options.env ?? subscriptionEnvironment()
  const maxCaptureBytes = options.maxCaptureBytes ?? MAX_CAPTURE_BYTES
  const hasInput = typeof options.input === 'string'
  const invocation = commandInvocation(executable, args, env)

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

    const child = spawn(invocation.executable, invocation.args, {
      cwd: options.cwd,
      env,
      shell: false,
      stdio: [hasInput ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })

    const terminate = () => {
      if (child.exitCode !== null || child.signalCode !== null || forceKillTimer) return
      try {
        child.kill('SIGTERM')
      } catch {
        // The close/error event remains authoritative when the process already exited.
      }
      forceKillTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try {
            child.kill('SIGKILL')
          } catch {
            // A concurrent process exit needs no further cleanup.
          }
        }
      }, terminationGraceMs)
      forceKillTimer.unref?.()
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
      if (inactivityTimeoutMs === null || settled || timedOut || aborted) return
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
      child.stdin.end(options.input, 'utf8')
    }

    child.once('spawn', refreshInactivityWatchdog)
    refreshInactivityWatchdog()
    if (Number.isFinite(hardTimeoutMs) && hardTimeoutMs > 0) {
      hardTimer = setTimeout(() => timeout('hard_limit'), hardTimeoutMs)
      hardTimer.unref?.()
    }

    const finish = (result) => {
      if (settled) return
      settled = true
      if (hardTimer) clearTimeout(hardTimer)
      if (inactivityTimer) clearTimeout(inactivityTimer)
      if (forceKillTimer) clearTimeout(forceKillTimer)
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
        outputTruncated: Boolean(stdoutCapture.truncation || stderrCapture.truncation),
      })
    }

    child.on('error', (error) => finish({ exitCode: null, error: error.message }))
    child.on('close', (exitCode, signal) => finish({ exitCode, signal, error: null }))
  })
}
