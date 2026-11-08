import { createHash } from 'node:crypto'
import { readdir, realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join, relative, sep } from 'node:path'
import { isHomeDirectory, validateProjectPath } from './chat.mjs'

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

  let ensyncStat
  try {
    ensyncStat = await stat(root)
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') {
      return { exists: false, files, truncated, error: null }
    }
    return { exists: false, files, truncated, error: 'Ensync Host could not inspect the .ensync path.' }
  }
  if (!ensyncStat.isDirectory()) {
    return { exists: false, files, truncated, error: '.ensync exists but is not a directory.' }
  }
  try {
    await visit(root)
    return { exists: true, files, truncated, error: null }
  } catch {
    return { exists: true, files, truncated, error: 'Ensync Host could not read every .ensync entry.' }
  }
}

function projectId(projectPath) {
  return `local-${createHash('sha256').update(projectPath).digest('hex').slice(0, 16)}`
}

export async function inspectProject(projectPath, options = {}) {
  const resolvedPath = await validateProjectPath(projectPath, {
    allowedRoots: options.allowedRoots,
  })
  const ensyncRoot = join(resolvedPath, '.ensync')
  const ensync = await collectFiles(ensyncRoot)
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
      ensyncDirectory: ensync.exists,
      files: ensync.files,
      featureFiles: ensync.files.filter((file) => file.startsWith('features/') && file.endsWith('.md')),
      truncated: ensync.truncated,
      error: ensync.error,
      instructionAdapters,
    },
    inspectedAt: new Date().toISOString(),
  }
}

export class ProjectInspectionService {
  constructor(options = {}) {
    this.allowedRoots = options.allowedRoots
    // `undefined` means "not configured", so a Host started inside a project
    // folder still focuses it. An explicit `null` means the caller knows its
    // working directory is not a project.
    this.defaultProjectPath = options.defaultProjectPath === undefined
      ? process.cwd()
      : options.defaultProjectPath
    this.homePath = options.homePath
    this.listRecentProjects = options.listRecentProjects ?? (() => [])
  }

  inspect(projectPath) {
    return inspectProject(projectPath, { allowedRoots: this.allowedRoots })
  }

  /**
   * The canonical home directory, reported alongside every project so each
   * client applies one rule to it without guessing what home means on this
   * machine. Project paths are canonical too, so the two compare directly.
   */
  homeDirectory() {
    return realpath(this.homePath ?? homedir()).catch(() => null)
  }

  /**
   * The project to focus when the app has not chosen one yet.
   *
   * The desktop shell runs the Host from the user's home directory, so the
   * configured default can be the home directory itself. Answering with it only
   * stranded the first run: a home directory holds everything a person owns and
   * is refused as a project repository, so the user met "A home directory is too
   * broad to become one Ensync project repository" after writing a prompt.
   * Ensync therefore never focuses a home directory on the user's behalf. It
   * offers the most recent project the shell recorded instead, and reports no
   * project at all when there is none, so the interface can ask for a folder
   * before a chat exists rather than after a run fails.
   */
  async current() {
    for (const candidate of await this.#candidatePaths()) {
      if (await isHomeDirectory(candidate, this.homePath)) continue
      let project
      try {
        project = await this.inspect(candidate)
      } catch {
        continue
      }
      // The canonical path is what a run would use; a symlinked candidate can
      // only now be revealed as the home directory.
      if (await isHomeDirectory(project.path, this.homePath)) continue
      return project
    }
    return null
  }

  async #candidatePaths() {
    const paths = []
    if (typeof this.defaultProjectPath === 'string' && this.defaultProjectPath) {
      paths.push(this.defaultProjectPath)
    }
    let recent
    try {
      recent = await this.listRecentProjects()
    } catch {
      recent = []
    }
    for (const project of Array.isArray(recent) ? recent : []) {
      const path = typeof project?.path === 'string' ? project.path : null
      if (path && !paths.includes(path)) paths.push(path)
    }
    return paths
  }
}
