import { spawnSync } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createBuildInfo } from '../src/build-info.mjs'

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repositoryRoot = resolve(desktopRoot, '..')
export const GENERATED_BUILD_INFO_PATH = join(desktopRoot, 'build', 'generated', 'build-info.json')

function gitOutput(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed while identifying the build.`)
  return result.stdout.trim()
}

function explicitDirty(value) {
  if (value === undefined) return null
  if (value === 'true' || value === '1') return true
  if (value === 'false' || value === '0') return false
  throw new Error('ENSYNC_SOURCE_DIRTY must be true, false, 1, or 0.')
}

export async function collectBuildInfo({
  environment = process.env,
  sourceRoot = repositoryRoot,
  packagePath = join(desktopRoot, 'package.json'),
  now = () => new Date().toISOString(),
} = {}) {
  const packageJson = JSON.parse(await readFile(packagePath, 'utf8'))
  const sourceCommit = environment.ENSYNC_SOURCE_COMMIT?.trim()
    || gitOutput(['rev-parse', 'HEAD'], sourceRoot)
  const configuredDirty = explicitDirty(environment.ENSYNC_SOURCE_DIRTY)
  const sourceDirty = configuredDirty ?? gitOutput(
    ['status', '--porcelain=v1', '--untracked-files=normal'],
    sourceRoot,
  ).length > 0
  return createBuildInfo({
    appVersion: environment.ENSYNC_APP_VERSION?.trim() || packageJson.version,
    channel: environment.ENSYNC_BUILD_CHANNEL?.trim() || 'dev',
    sourceCommit,
    sourceDirty,
    builtAt: environment.ENSYNC_BUILD_TIME?.trim() || now(),
  })
}

export async function writeBuildInfo({ outputPath = GENERATED_BUILD_INFO_PATH, ...options } = {}) {
  const buildInfo = await collectBuildInfo(options)
  await mkdir(dirname(outputPath), { recursive: true })
  const stagingPath = `${outputPath}.staging`
  await writeFile(stagingPath, `${JSON.stringify(buildInfo, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(stagingPath, outputPath)
  return buildInfo
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const buildInfo = await writeBuildInfo()
  console.log(`Prepared Ensync build ${buildInfo.buildId} (${buildInfo.channel}, ${buildInfo.sourceCommit}, ${buildInfo.sourceDirty ? 'dirty' : 'clean'}).`)
}
