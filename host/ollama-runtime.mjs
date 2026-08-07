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
