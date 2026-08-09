import { readFile, rename, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { manifestFilename, prepareChannelRelease, prepareChannelRollback } from './release-feed.mjs'

function option(name, fallback = null) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] : fallback
}

async function readJson(path) {
  return JSON.parse(await readFile(resolve(path), 'utf8'))
}

const channel = option('--channel')
const currentPath = option('--current')
const candidatePath = option('--candidate')
const rollbackVersion = option('--rollback-version')
const outputPath = resolve(option('--output', channel ? manifestFilename(channel) : 'releases.json'))
if (!currentPath || !['stable', 'beta'].includes(channel)) {
  throw new Error('Use --current with --channel stable or --channel beta.')
}
if (Boolean(candidatePath) === Boolean(rollbackVersion)) {
  throw new Error('Choose exactly one of --candidate or --rollback-version.')
}

const current = await readJson(currentPath)
const manifest = candidatePath
  ? prepareChannelRelease({ current, candidate: await readJson(candidatePath), channel })
  : prepareChannelRollback({ current, channel, version: rollbackVersion })
const stagingPath = `${outputPath}.staging`
await writeFile(stagingPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
await rename(stagingPath, outputPath)
console.log(`${candidatePath ? 'Staged' : 'Prepared rollback for'} ${channel} feed ${manifest.latest.version}.`)
