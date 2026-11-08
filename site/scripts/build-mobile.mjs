// Builds the phone PWA from ../mobile and publishes it at /mobile/ so every
// site deploy serves the phone app from the same commit (no hand-copied build).
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const siteRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const mobileRoot = resolve(siteRoot, '..', 'mobile')
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const run = (args) => execFileSync(npm, args, { cwd: mobileRoot, stdio: 'inherit' })

if (!existsSync(resolve(mobileRoot, 'node_modules'))) run(['ci', '--no-audit', '--no-fund'])
run(['run', 'build'])
const target = resolve(siteRoot, 'public', 'mobile')
rmSync(target, { recursive: true, force: true })
cpSync(resolve(mobileRoot, 'dist'), target, { recursive: true })
console.log('Published the phone app at public/mobile/.')
