import { createHash } from 'node:crypto'
import { readdir, stat } from 'node:fs/promises'
import { basename, join, relative, sep } from 'node:path'
import { validateProjectPath } from './chat.mjs'

const MAX_CONTEXT_FILES = 1_000
const INSTRUCTION_FILES = [
  { provider: 'codex', name: 'Codex', file: 'AGENTS.md' },
  { provider: 'claude', name: 'Claude Code', file: 'CLAUDE.md' },
]

function portableRelativePath(root, target) {
  return relative(root, target).split(sep).join('/')
}

async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function collectFiles(root) {
  const files = []
  let truncated = false

  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true })
    entries.sort((left, right) => left.name.localeCompare(right.name))

    for (const entry of entries) {
      if (files.length >= MAX_CONTEXT_FILES) {
        truncated = true
        return
      }
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile()) files.push(portableRelativePath(root, path))
      if (truncated) return
    }
  }

  let relayStat
  try {
    relayStat = await stat(root)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { exists: false, files, truncated, error: null }
    }
    return { exists: false, files, truncated, error: 'Ensync Host could not inspect the .relay path.' }
  }
  if (!relayStat.isDirectory()) {
    return { exists: false, files, truncated, error: '.relay exists but is not a directory.' }
  }
  try {
    await visit(root)
    return { exists: true, files, truncated, error: null }
  } catch {
    return { exists: true, files, truncated, error: 'Ensync Host could not read every .relay entry.' }
  }
}

function projectId(projectPath) {
  return `local-${createHash('sha256').update(projectPath).digest('hex').slice(0, 16)}`
}

export async function inspectProject(projectPath, options = {}) {
  const resolvedPath = await validateProjectPath(projectPath, {
    allowedRoots: options.allowedRoots,
  })
  const relayRoot = join(resolvedPath, '.relay')
  const relay = await collectFiles(relayRoot)
  const instructionAdapters = []

  for (const adapter of INSTRUCTION_FILES) {
    if (await isFile(join(resolvedPath, adapter.file))) instructionAdapters.push(adapter)
  }

  return {
    id: projectId(resolvedPath),
    name: basename(resolvedPath),
    path: resolvedPath,
    host: 'local',
    context: {
      relayDirectory: relay.exists,
      files: relay.files,
      featureFiles: relay.files.filter((file) => file.startsWith('features/') && file.endsWith('.md')),
      truncated: relay.truncated,
      error: relay.error,
      instructionAdapters,
    },
    inspectedAt: new Date().toISOString(),
  }
}

export class ProjectInspectionService {
  constructor(options = {}) {
    this.allowedRoots = options.allowedRoots
    this.defaultProjectPath = options.defaultProjectPath ?? process.cwd()
  }

  inspect(projectPath) {
    return inspectProject(projectPath, { allowedRoots: this.allowedRoots })
  }

  current() {
    return this.inspect(this.defaultProjectPath)
  }
}
