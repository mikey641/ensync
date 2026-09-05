import { resolveReleaseMode, validateReleasePrerequisites } from './release-prerequisites.mjs'

const errors = validateReleasePrerequisites(process.env)
if (errors.length > 0) {
  console.error(`Ensync ${resolveReleaseMode(process.env)} release prerequisites are incomplete:`)
  for (const error of errors) console.error(`- ${error}`)
  process.exitCode = 1
} else {
  console.log(`Ensync ${resolveReleaseMode(process.env)} release credentials are complete.`)
}
