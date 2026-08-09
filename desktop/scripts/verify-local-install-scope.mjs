import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  readdirSync,
  readlinkSync,
} from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { extractFile, listPackage, statFile } from '@electron/asar'

const ASAR_PATH = 'Contents/Resources/app.asar'
const PRESERVED_BEHAVIORS = [
  {
    name: 'native titlebar/window chrome',
    source: { kind: 'asar', path: 'src/main.mjs' },
    required: true,
    markers: ['nativeWindowFrameOptions', 'TITLEBAR_APPEARANCE_CHANNEL'],
  },
  {
    name: 'queued-prompt push and live steering',
    source: { kind: 'ui-javascript' },
    required: true,
    markers: [
      'Queue message in this chat',
      'Push now',
      'Deliver the first queued message to the active Codex turn now',
    ],
    forbiddenMarkers: ['Steer the active Codex turn'],
  },
  {
    name: 'subagent-safe Push now routing',
    source: { kind: 'bundle-file', path: 'Contents/Resources/host/codex-live-turn.mjs' },
    required: true,
    markers: ['params?.threadId === this.#threadId'],
  },
]

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function normalizedRelativePath(value) {
  return value.split(sep).join('/')
}

function walk(root, directory = root, manifest = new Map()) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolutePath = join(directory, entry.name)
    const relativePath = normalizedRelativePath(relative(root, absolutePath))
    if (entry.isDirectory()) {
      walk(root, absolutePath, manifest)
    } else if (entry.isSymbolicLink()) {
      manifest.set(relativePath, `symlink:${readlinkSync(absolutePath)}`)
    } else if (entry.isFile()) {
      manifest.set(relativePath, `file:${sha256(readFileSync(absolutePath))}`)
    } else {
      manifest.set(relativePath, `other:${lstatSync(absolutePath).mode}`)
    }
  }
  return manifest
}

function asarManifest(archivePath) {
  const manifest = new Map()
  for (const listedPath of listPackage(archivePath)) {
    const entryPath = listedPath.replace(/^\/+/, '')
    const metadata = statFile(archivePath, entryPath)
    if (metadata.files) continue
    const digest = metadata.integrity?.hash
      ?? sha256(`${metadata.offset ?? ''}:${metadata.size ?? ''}`)
    manifest.set(`${ASAR_PATH}::${entryPath}`, `file:${digest}`)
  }
  return manifest
}

function changedPaths(baseManifest, candidateManifest) {
  const paths = new Set([...baseManifest.keys(), ...candidateManifest.keys()])
  return [...paths]
    .filter((path) => baseManifest.get(path) !== candidateManifest.get(path))
    .sort()
}

export function diffBundleTrees(baseRoot, candidateRoot) {
  const base = resolve(baseRoot)
  const candidate = resolve(candidateRoot)
  if (!existsSync(base) || !existsSync(candidate)) {
    throw new Error('Both the installed-base and staged-candidate app bundles must exist.')
  }

  const baseManifest = walk(base)
  const candidateManifest = walk(candidate)
  const changes = changedPaths(baseManifest, candidateManifest)
  const asarChanged = changes.includes(ASAR_PATH)
    && existsSync(join(base, ASAR_PATH))
    && existsSync(join(candidate, ASAR_PATH))

  if (!asarChanged) return changes

  return [
    ...changes.filter((path) => path !== ASAR_PATH),
    ...changedPaths(asarManifest(join(base, ASAR_PATH)), asarManifest(join(candidate, ASAR_PATH))),
  ].sort()
}

export function normalizeAllowedPath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\\')) {
    throw new Error('Every allowed install change must be one exact bundle-relative file path.')
  }
  const normalized = value.replace(/^\.\//, '')
  if (isAbsolute(normalized)
    || normalized.endsWith('/')
    || normalized.split('/').some((part) => part === '' || part === '.' || part === '..')) {
    throw new Error(`Broad or unsafe install allowance rejected: ${value}`)
  }
  return normalized
}

export function verifyAllowedChanges(changes, allowedPaths) {
  const allowed = new Set(allowedPaths.map(normalizeAllowedPath))
  const unused = [...allowed].filter((path) => !changes.includes(path))
  const unallowed = changes.filter((path) => !allowed.has(path))
  if (unused.length > 0) {
    throw new Error(`Allowed paths did not change: ${unused.join(', ')}`)
  }
  if (unallowed.length > 0) {
    throw new Error(`Local install would overwrite unapproved files: ${unallowed.join(', ')}`)
  }
  return true
}

function behaviorSource(root, source) {
  if (source.kind === 'asar') {
    return extractFile(join(root, ASAR_PATH), source.path).toString('utf8')
  }
  if (source.kind === 'ui-javascript') {
    const assets = join(root, 'Contents', 'Resources', 'ui', 'assets')
    return readdirSync(assets)
      .filter((name) => name.endsWith('.js'))
      .sort()
      .map((name) => readFileSync(join(assets, name), 'utf8'))
      .join('\n')
  }
  if (source.kind === 'bundle-file') {
    return readFileSync(join(root, source.path), 'utf8')
  }
  throw new Error(`Unknown preserved-behavior source: ${source.kind}`)
}

export function verifyPreservedBehaviors(baseRoot, candidateRoot) {
  const base = resolve(baseRoot)
  const candidate = resolve(candidateRoot)
  for (const behavior of PRESERVED_BEHAVIORS) {
    const baseSource = behaviorSource(base, behavior.source)
    const candidateSource = behaviorSource(candidate, behavior.source)
    const missing = behavior.required
      ? behavior.markers.filter((marker) => !candidateSource.includes(marker))
      : []
    if (missing.length > 0) {
      throw new Error(`Local install candidate is missing required ${behavior.name} markers: ${missing.join(', ')}`)
    }
    const forbidden = (behavior.forbiddenMarkers ?? [])
      .filter((marker) => candidateSource.includes(marker))
    if (forbidden.length > 0) {
      throw new Error(`Local install candidate contains forbidden ${behavior.name} markers: ${forbidden.join(', ')}`)
    }
    const removed = behavior.markers.filter((marker) => (
      baseSource.includes(marker) && !candidateSource.includes(marker)
    ))
    if (removed.length > 0) {
      throw new Error(`Local install removed preserved ${behavior.name} markers: ${removed.join(', ')}`)
    }
  }
  return true
}

function parseArguments(argv) {
  const values = { base: '', candidate: '', allowed: [] }
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]
    const value = argv[index + 1]
    if (argument === '--base' || argument === '--candidate' || argument === '--allow') {
      if (!value) throw new Error(`${argument} requires a value.`)
      if (argument === '--allow') values.allowed.push(value)
      else values[argument.slice(2)] = value
      index += 1
    } else {
      throw new Error(`Unknown argument: ${argument}`)
    }
  }
  if (!values.base || !values.candidate) {
    throw new Error('Usage: verify-local-install-scope --base <app> --candidate <app> --allow <exact-path> [...]')
  }
  return values
}

export function run(argv = process.argv.slice(2)) {
  const { base, candidate, allowed } = parseArguments(argv)
  verifyPreservedBehaviors(base, candidate)
  const changes = diffBundleTrees(base, candidate)
  verifyAllowedChanges(changes, allowed)
  process.stdout.write(`${JSON.stringify({ verified: true, changes }, null, 2)}\n`)
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  try {
    run()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
