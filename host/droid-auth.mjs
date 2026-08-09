import { stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Factory Droid has no non-interactive authentication-status command: `droid`
// with an unrecognised argument drops into the interactive TUI, and the
// stream-jsonrpc `droid.initialize_session` handshake succeeds even against an
// empty Factory home (verified against droid 0.190.0 with
// FACTORY_HOME_OVERRIDE pointed at an empty directory, which still returned a
// session ID and a full availableModels list). Neither can prove an account.
//
// What Droid does expose is the local credential store its own browser login
// writes. Ensync checks only that this file exists and is non-empty; it never
// reads, parses, or transmits its contents, and it never treats the file as
// proof that the credential is still valid. Droid itself re-validates on every
// run, and the exec runner maps a `model_authentication_failed` turn back to
// `provider_not_authenticated`.
const DROID_CREDENTIAL_FILE = 'auth.v2.loginkeychain'
const FACTORY_DIRECTORY = '.factory'

export function droidCredentialPath(environment = process.env, home = homedir()) {
  const factoryHome = environment?.FACTORY_HOME_OVERRIDE || home
  return join(factoryHome, FACTORY_DIRECTORY, DROID_CREDENTIAL_FILE)
}

export function parseDroidCredentialState(credential, checkedAt) {
  if (credential.error) {
    return {
      state: 'unavailable',
      method: null,
      reason: 'Ensync could not check whether a Factory CLI login is stored on this machine.',
      source: 'cli',
      checkedAt,
      exactPlan: null,
    }
  }
  if (!credential.exists || credential.empty) {
    return {
      state: 'not_authenticated',
      method: null,
      reason: 'No stored Factory CLI login was found on this machine. Run droid once to sign in through the browser.',
      source: 'cli',
      checkedAt,
      exactPlan: null,
    }
  }
  return {
    state: 'authenticated',
    method: 'Factory browser login',
    reason: 'A Factory CLI browser login is stored on this machine. Droid revalidates the credential itself when a run starts.',
    source: 'cli',
    checkedAt,
    // Droid reports plan windows only in its interactive /limits view, so
    // Ensync has no exact plan name to publish here.
    exactPlan: null,
  }
}

export async function probeDroidAuthentication(_executable, checkedAt, options = {}) {
  const path = options.credentialPath ?? droidCredentialPath(options.environment, options.home)
  try {
    const info = await stat(path)
    return parseDroidCredentialState({ exists: info.isFile(), empty: info.size === 0 }, checkedAt)
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return parseDroidCredentialState({ exists: false, empty: true }, checkedAt)
    }
    return parseDroidCredentialState({ error: true }, checkedAt)
  }
}
