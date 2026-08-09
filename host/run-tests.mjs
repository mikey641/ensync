import { spawnSync } from 'node:child_process'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'

const testFiles = (await readdir(import.meta.dirname, { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith('.test.mjs'))
  .map((entry) => join(import.meta.dirname, entry.name))
  .sort()

if (testFiles.length === 0) throw new Error('No Ensync Host test files were found.')

const result = spawnSync(process.execPath, ['--test', ...testFiles], {
  stdio: 'inherit',
  windowsHide: true,
})

if (result.error) throw result.error
if (result.signal) throw new Error(`Ensync Host tests were terminated by ${result.signal}.`)
process.exitCode = result.status ?? 1
