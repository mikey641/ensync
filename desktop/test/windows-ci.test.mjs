import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const desktopRoot = resolve(fileURLToPath(new URL('..', import.meta.url)))
const repositoryRoot = resolve(desktopRoot, '..')

test('desktop CI can manually package, launch-smoke, and retain unsigned Windows evidence', async () => {
  const [workflow, packageJson] = await Promise.all([
    readFile(resolve(repositoryRoot, '.github', 'workflows', 'desktop-ci.yml'), 'utf8'),
    readFile(resolve(desktopRoot, 'package.json'), 'utf8').then(JSON.parse),
  ])

  assert.match(workflow, /^\s{2}workflow_dispatch:\s*$/m)
  assert.match(workflow, /os: \[macos-14, windows-2025\]/)
  assert.match(workflow, /node desktop\/scripts\/package-native\.mjs --platform windows/)
  assert.match(workflow, /node desktop\/scripts\/attest-build\.mjs --platform windows/)
  assert.match(workflow, /npm --prefix desktop run smoke:win-packaged/)
  assert.match(workflow, /actions\/upload-artifact@v4/)
  assert.match(workflow, /desktop\/release\/\*\.exe/)
  assert.match(workflow, /desktop\/release\/\*\.zip/)
  assert.match(workflow, /desktop\/release\/attestation-windows\.json/)

  const verifyIndex = workflow.indexOf('npm --prefix desktop run verify')
  const packageIndex = workflow.indexOf('package-native.mjs --platform windows')
  const attestIndex = workflow.indexOf('attest-build.mjs --platform windows')
  const smokeIndex = workflow.indexOf('npm --prefix desktop run smoke:win-packaged')
  const uploadIndex = workflow.indexOf('actions/upload-artifact@v4')
  assert.ok(verifyIndex < packageIndex)
  assert.ok(packageIndex < attestIndex)
  assert.ok(attestIndex < smokeIndex)
  assert.ok(smokeIndex < uploadIndex)
  assert.equal(
    packageJson.scripts['smoke:win-packaged'],
    'node scripts/smoke-windows-package.mjs',
  )
})
