/**
 * Ensync's stand-in for the `update.mode` / `update.channel` settings upstream
 * registers in `src/vs/platform/update/common/update.config.contribution.ts` and
 * reads through `IConfigurationService`.
 *
 * The values and their meanings are upstream's; the storage is Ensync's
 * per-device preferences file. Upstream additionally allows an administrator
 * policy to pin `update.mode`; Ensync has no policy layer, so `inspect()` never
 * reports a policy value.
 */

import { Emitter } from './base.mjs'
import { normalizeUpdateChannel, normalizeUpdateMode, UpdateChannel, UpdateMode } from './update.mjs'

export const UPDATE_MODE_DESCRIPTIONS = Object.freeze({
  [UpdateMode.None]: 'Disable updates.',
  [UpdateMode.Manual]: 'Disable automatic background update checks. Updates will be available if you manually check for updates.',
  [UpdateMode.Start]: 'Check for updates only on startup. Disable automatic background update checks.',
  [UpdateMode.Default]: 'Enable automatic update checks. Ensync will check for updates automatically and periodically.',
})

/**
 * @param read - returns `{ updateChannel, updateMode }`, normally the device
 *               preferences store's `get()`.
 */
export function createUpdateConfiguration(read) {
  const emitter = new Emitter()

  const value = (key) => {
    const preferences = read() ?? {}
    if (key === 'update.mode') return normalizeUpdateMode(preferences.updateMode) ?? UpdateMode.Default
    if (key === 'update.channel') return normalizeUpdateChannel(preferences.updateChannel) ?? UpdateChannel.Stable
    return undefined
  }

  return Object.freeze({
    getValue: value,
    inspect: (key) => ({ value: value(key), policyValue: undefined }),
    onDidChangeConfiguration: emitter.event,
    /** Called after a preference write so the service reconfigures without a restart. */
    notifyChanged(...keys) {
      emitter.fire({ affectsConfiguration: (key) => keys.includes(key) })
    },
    dispose() {
      emitter.dispose()
    },
  })
}
