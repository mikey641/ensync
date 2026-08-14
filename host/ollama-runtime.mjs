import { runProcess } from './command.mjs'

function successfulRows(result) {
  if (result?.timedOut || result?.error || result?.exitCode !== 0 || typeof result.stdout !== 'string') {
    return null
  }

  const lines = result.stdout.split('\n').map((line) => line.trim()).filter(Boolean)
  if (lines.length === 0) return []
  const first = lines[0].split(/\s+/)[0]?.toUpperCase()
  const rows = first === 'NAME' ? lines.slice(1) : lines
  return rows.flatMap((line) => {
    const name = line.split(/\s+/)[0]?.trim()
    return name ? [name] : []
  })
}

export function parseOllamaRuntimeProbe(listResult, runningResult, checkedAt = new Date().toISOString()) {
  const installedModels = successfulRows(listResult)
  const runningModels = successfulRows(runningResult)
  if (installedModels === null && runningModels === null) return null

  const details = []
  if (installedModels !== null) {
    details.push({ label: 'Installed models', value: String(installedModels.length) })
  }
  if (runningModels !== null) {
    details.push({ label: 'Loaded models', value: String(runningModels.length) })
  }

  const observations = [
    installedModels === null
      ? 'ollama list did not return model inventory'
      : `ollama list reported ${installedModels.length} installed ${installedModels.length === 1 ? 'model' : 'models'}`,
    runningModels === null
      ? 'ollama ps did not return loaded-model state'
      : `ollama ps reported ${runningModels.length} loaded ${runningModels.length === 1 ? 'model' : 'models'}`,
  ]

  return {
    usage: {
      availability: 'partial',
      source: 'cli',
      kind: 'local_runtime',
      plan: null,
      model: null,
      usedPercent: null,
      remainingPercent: null,
      resetAt: null,
      checkedAt,
      details,
      reason: `${observations.join('; ')}. Local Ollama has no subscription quota percentage.`,
    },
    models: (installedModels ?? []).map((name) => ({
      id: name,
      displayName: name,
      isDefault: false,
    })),
  }
}

export async function probeOllamaRuntime(executable, checkedAt) {
  const [listResult, runningResult] = await Promise.all([
    runProcess(executable, ['list'], { timeoutMs: 5_000 }),
    runProcess(executable, ['ps'], { timeoutMs: 5_000 }),
  ])
  return parseOllamaRuntimeProbe(listResult, runningResult, checkedAt)
}

// ---------------------------------------------------------------------------
// Preflight
//
// Verified against ollama 0.13.5 on 2026-08-11; see docs/providers/ollama.md.
//
// Ollama is a local inference server, not an agent: it cannot read or write
// files, run commands, or hold a session, so it is NOT wired as an Ensync chat
// provider (see GATED_CHAT_PROVIDERS in host/chat.mjs). What it does need — and
// what these helpers give it — is an honest, fast answer to "is the server up
// and is the model actually here?", because both failure modes are otherwise
// silent or destructive:
//
//   * Server down: connecting to a closed port fails immediately with
//     ECONNREFUSED (verified against port 59999) — detectable, never a hang.
//   * Model absent over HTTP: `/api/generate` and `/api/chat` return an
//     immediate 404 `{"error":"model 'X' not found"}` (verified).
//   * Model absent over the CLI: `ollama run <missing>` STARTS A REGISTRY PULL
//     (verified: "pulling manifest …"). For a real model name that is a
//     multi-gigabyte download nobody asked for. Nothing here ever shells out to
//     `ollama run`, and nothing here ever pulls.
// ---------------------------------------------------------------------------

export const OLLAMA_DEFAULT_ENDPOINT = 'http://127.0.0.1:11434'
const OLLAMA_PREFLIGHT_TIMEOUT_MS = 5_000

export class OllamaRuntimeError extends Error {
  constructor(code, message, status = 502, safeToRetry = false) {
    super(message)
    this.name = 'OllamaRuntimeError'
    this.code = code
    this.status = status
    this.safeToRetry = safeToRetry
  }
}

/**
 * Resolves the server base URL the way the CLI documents OLLAMA_HOST: a bare
 * `host:port` is accepted as well as a full URL.
 */
export function ollamaEndpoint(environment = process.env) {
  const raw = typeof environment?.OLLAMA_HOST === 'string' ? environment.OLLAMA_HOST.trim() : ''
  if (!raw) return OLLAMA_DEFAULT_ENDPOINT
  const candidate = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`
  try {
    const url = new URL(candidate)
    return url.origin
  } catch {
    return OLLAMA_DEFAULT_ENDPOINT
  }
}

export function parseOllamaModelInventory(payload) {
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.models)) return null
  return payload.models.flatMap((entry) => {
    const name = typeof entry?.name === 'string' ? entry.name.trim() : ''
    return name ? [name] : []
  })
}

/**
 * Ollama tags carry an explicit `:tag` suffix (`llama3:8b`); a bare name is
 * conventionally the `:latest` tag, so both spellings resolve to one model.
 */
export function ollamaModelInstalled(installedModels, requestedModel) {
  if (!Array.isArray(installedModels) || typeof requestedModel !== 'string' || !requestedModel) return false
  const wanted = requestedModel.includes(':') ? requestedModel : `${requestedModel}:latest`
  return installedModels.some((name) => name === requestedModel || name === wanted)
}

/**
 * Turns an observed server state into an honest, actionable failure — or null
 * when the runtime is genuinely ready. Pure, so every branch is testable
 * without a server.
 */
export function describeOllamaPreflight({ reachable, endpoint, installedModels, requestedModel } = {}) {
  const target = endpoint ?? OLLAMA_DEFAULT_ENDPOINT
  if (!reachable) {
    return new OllamaRuntimeError(
      'ollama_server_unreachable',
      `Ensync could not reach the Ollama server at ${target}. Start it with \`ollama serve\` (or set OLLAMA_HOST to the right address) and try again.`,
      503,
      true,
    )
  }
  if (installedModels === null) {
    return new OllamaRuntimeError(
      'ollama_inventory_unreadable',
      `The Ollama server at ${target} did not return a readable model inventory, so Ensync cannot confirm which models are available.`,
      502,
      true,
    )
  }
  if (installedModels.length === 0) {
    return new OllamaRuntimeError(
      'ollama_no_models_installed',
      `The Ollama server at ${target} has no models installed. Pull one first — for example \`ollama pull llama3\`. Ensync never downloads models on your behalf.`,
      409,
      false,
    )
  }
  if (requestedModel && !ollamaModelInstalled(installedModels, requestedModel)) {
    return new OllamaRuntimeError(
      'ollama_model_missing',
      `The Ollama server at ${target} does not have "${requestedModel}" installed. Run \`ollama pull ${requestedModel}\` first — Ensync never downloads models on your behalf. Installed: ${installedModels.join(', ')}.`,
      409,
      false,
    )
  }
  return null
}

/**
 * Reads server liveness and model inventory over HTTP. Never pulls, never sends
 * a prompt, and never shells out to `ollama run`. Both requests are bounded by
 * an abort timeout so an unresponsive (as opposed to refusing) host cannot hang
 * the caller.
 */
export async function preflightOllamaRuntime(options = {}) {
  const endpoint = options.endpoint ?? ollamaEndpoint(options.environment)
  const fetchImpl = options.fetch ?? globalThis.fetch
  const timeoutMs = options.timeoutMs ?? OLLAMA_PREFLIGHT_TIMEOUT_MS

  const request = async (path) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    timer.unref?.()
    try {
      const response = await fetchImpl(`${endpoint}${path}`, { signal: controller.signal })
      if (!response?.ok) return null
      return await response.json()
    } catch {
      return null
    } finally {
      clearTimeout(timer)
    }
  }

  const version = await request('/api/version')
  if (!version || typeof version !== 'object') {
    return {
      endpoint,
      reachable: false,
      version: null,
      installedModels: null,
      failure: describeOllamaPreflight({ reachable: false, endpoint }),
    }
  }
  const tags = await request('/api/tags')
  const installedModels = parseOllamaModelInventory(tags)
  return {
    endpoint,
    reachable: true,
    version: typeof version.version === 'string' ? version.version : null,
    installedModels,
    failure: describeOllamaPreflight({
      reachable: true,
      endpoint,
      installedModels,
      requestedModel: options.model ?? null,
    }),
  }
}
