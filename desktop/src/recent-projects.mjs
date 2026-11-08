import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export const RECENT_PROJECTS_GET_CHANNEL = 'ensync:recent-projects:get'
export const RECENT_PROJECTS_MIGRATE_CHANNEL = 'ensync:recent-projects:migrate'
export const RECENT_PROJECTS_REMEMBER_CHANNEL = 'ensync:recent-projects:remember'
export const RECENT_PROJECTS_CHANGED_CHANNEL = 'ensync:recent-projects:changed'
export const RECENT_PROJECTS_FILENAME = 'global-recent-projects-v1.json'

const FORMAT = 'ensync-global-recent-projects'
const VERSION = 1
const MAX_PROJECTS = 128

function checksum(value) {
  return createHash('sha256').update(value).digest('hex')
}

function pathKey(value) {
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(normalized) || normalized.startsWith('//')
    ? normalized.toLowerCase()
    : normalized
}

function absolutePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096) return false
  if (value.startsWith('/')) return value !== '/' && !/^\/+$/u.test(value)
  if (/^[a-z]:[\\/]/i.test(value)) return !/^[a-z]:[\\/]*$/i.test(value)
  return /^\\\\[^\\]+\\[^\\]+/.test(value)
}

function normalizeProject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || value.host !== 'local' || !absolutePath(value.path)) return null
  const path = value.path
  const fallbackName = path.replaceAll('\\', '/').split('/').filter(Boolean).at(-1) ?? 'Project'
  const name = typeof value.name === 'string' && value.name.trim()
    ? value.name.trim().slice(0, 256)
    : fallbackName.slice(0, 256)
  return Object.freeze({ name, path, host: 'local' })
}

function normalizeProjects(value) {
  if (!Array.isArray(value)) return null
  const projects = []
  const paths = new Set()
  for (const candidate of value) {
    const project = normalizeProject(candidate)
    if (!project) continue
    const key = pathKey(project.path)
    if (paths.has(key)) continue
    paths.add(key)
    projects.push(project)
    if (projects.length >= MAX_PROJECTS) break
  }
  return projects
}

function decode(encoded) {
  try {
    const envelope = JSON.parse(encoded)
    if (!envelope || envelope.format !== FORMAT || envelope.version !== VERSION
      || !Number.isSafeInteger(envelope.revision) || envelope.revision < 1
      || typeof envelope.committedAt !== 'string' || Number.isNaN(Date.parse(envelope.committedAt))
      || typeof envelope.payload !== 'string' || envelope.checksum !== checksum(envelope.payload)) return null
    const projects = normalizeProjects(JSON.parse(envelope.payload)?.projects)
    return projects ? { encoded, revision: envelope.revision, committedAt: envelope.committedAt, projects } : null
  } catch {
    return null
  }
}

function encode(projects, revision, committedAt) {
  const payload = JSON.stringify({ projects })
  return JSON.stringify({
    format: FORMAT,
    version: VERSION,
    revision,
    committedAt,
    checksum: checksum(payload),
    payload,
  })
}

function sameProjects(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

/**
 * Recent projects are folders the user can pick up again, and a home directory
 * never is one: Ensync refuses to make it a project repository, so an entry for
 * it only leads back to "A home directory is too broad to become one Ensync
 * project repository." One reached this registry automatically before the Host
 * stopped focusing it, and the renderer's boot migration would keep restoring
 * it from old workspace snapshots, so the registry drops it wherever it arrives
 * and cleans an already-stored record the first time the store opens.
 */
function excludesHome(projects, homeKey) {
  return homeKey ? projects.filter((project) => pathKey(project.path) !== homeKey) : projects
}

export function createRecentProjectStore({ filePath, homePath = null, now = () => new Date().toISOString() } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('A recent-project state path is required.')
  const homeKey = typeof homePath === 'string' && homePath ? pathKey(homePath) : null
  const stagingPath = `${filePath}.staging`
  const backupPath = `${filePath}.backup`
  const readCandidate = (path, priority) => {
    try {
      const candidate = decode(readFileSync(path, 'utf8'))
      return candidate ? { ...candidate, path, priority } : null
    } catch {
      return null
    }
  }
  const candidates = [
    readCandidate(filePath, 3),
    readCandidate(stagingPath, 2),
    readCandidate(backupPath, 1),
  ].filter(Boolean).sort((left, right) => right.revision - left.revision
    || right.committedAt.localeCompare(left.committedAt) || right.priority - left.priority)
  let revision = candidates[0]?.revision ?? 0
  const stored = candidates[0]?.projects ?? []
  let projects = excludesHome(stored, homeKey)
  const storedHome = projects.length !== stored.length

  // Promote a recovered staging/backup record without rotating corrupt bytes.
  if (candidates[0] && candidates[0].path !== filePath) {
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(filePath, candidates[0].encoded, { encoding: 'utf8', mode: 0o600 })
    if (candidates[0].path === stagingPath) {
      try { rmSync(stagingPath) } catch { /* best effort: a retained staging file is recovered on reopen */ }
    }
  }

  const persist = (nextProjects) => {
    const nextRevision = revision + 1
    const encoded = encode(nextProjects, nextRevision, now())
    mkdirSync(dirname(filePath), { recursive: true })
    writeFileSync(stagingPath, encoded, { encoding: 'utf8', mode: 0o600 })
    const current = readCandidate(filePath, 3)
    if (current) writeFileSync(backupPath, current.encoded, { encoding: 'utf8', mode: 0o600 })
    // If this write is interrupted, the complete staging file wins on reopen.
    writeFileSync(filePath, encoded, { encoding: 'utf8', mode: 0o600 })
    try { rmSync(stagingPath) } catch { /* best effort: a retained staging file is recovered on reopen */ }
    projects = nextProjects
    revision = nextRevision
    return { projects: projects.map((project) => ({ ...project })), revision, changed: true }
  }

  const merge = (incoming, promote) => {
    const normalized = excludesHome(normalizeProjects(incoming) ?? [], homeKey)
    const source = promote ? [...normalized, ...projects] : [...projects, ...normalized]
    const next = excludesHome(normalizeProjects(source) ?? [], homeKey)
    return sameProjects(next, projects)
      ? { projects: projects.map((project) => ({ ...project })), revision, changed: false }
      : persist(next)
  }

  // A stored home directory is rewritten out now rather than at the next
  // mutation, so the record is gone even if this session never focuses anything.
  if (storedHome) persist(projects)

  return Object.freeze({
    homePath: typeof homePath === 'string' && homePath ? homePath : null,
    list() { return projects.map((project) => ({ ...project })) },
    migrate(incoming) { return merge(incoming, false) },
    remember(project) { return merge([project], true) },
  })
}

export function createRecentProjectHandlers({ isAuthorized, store, onChanged = () => {} }) {
  if (typeof isAuthorized !== 'function' || !store) throw new TypeError('Recent-project authorization and store are required.')
  const response = (result) => ({ projects: result.projects, revision: result.revision, homePath: store.homePath ?? null })
  const mutate = (operation) => (event, value) => {
    if (!isAuthorized(event)) return null
    const result = operation(value)
    if (result.changed) onChanged(response(result))
    return response(result)
  }
  return Object.freeze({
    get(event) {
      if (!isAuthorized(event)) return null
      return { projects: store.list(), homePath: store.homePath ?? null }
    },
    migrate: mutate((projects) => store.migrate(projects)),
    remember: mutate((project) => store.remember(project)),
  })
}
