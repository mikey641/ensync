import { validateReleasePrerequisites } from './release-prerequisites.mjs'

const errors = validateReleasePrerequisites(process.env)
if (errors.length > 0) {
  console.error('Ensync production release prerequisites are incomplete:')
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log('Ensync production release credentials are complete for macOS, Windows, the separate public binary repository, and Vercel.')
}
