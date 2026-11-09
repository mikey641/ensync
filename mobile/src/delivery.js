// Delivery presentation for the phone, mirroring the desktop delivery panel:
// the same labels and the same Saved → Production progress steps. The Host
// sends a bounded summary (see summarizeDelivery in host/sync-broker-host.mjs).

export const DELIVERY_TARGETS = [
  { id: 'production', label: 'Production', detail: 'Merge with Ensync, push the production branch, and verify the deployment' },
  { id: 'protected_branch', label: 'Protected branch only', detail: 'Save the exact commit without merging, pushing, or deploying it' },
]

export const DELIVERY_STEPS = ['Saved', 'Landing', 'Merged', 'Pushed', 'Building', 'Repair', 'Production']

export function deliveryLabel(record) {
  if (!record) return null
  if (record.deliveryTarget === 'protected_branch') return 'Saved only'
  if (record.state === 'landing') {
    if (record.landingState === 'integrating') return 'Merging by Ensync'
    if (record.landingState === 'retry') return 'Merge retry scheduled'
    if (record.landingState === 'landed') return 'Merged · awaiting push'
    if (record.landingState === 'queued') return 'Waiting for Ensync merge'
  }
  return {
    saved: 'Saved',
    landing: 'Landing',
    pushed: 'Pushed',
    building: 'Building',
    failed: 'Deploy failed',
    repairing: record.repairState === 'manual' ? 'Fixing in chat' : 'Auto-fixing',
    production: 'Production',
    unavailable: 'Status unavailable',
  }[record.state] ?? 'Tracked delivery'
}

/** Index into DELIVERY_STEPS that the record has reached (-1 when unknown). */
export function deliveryPosition(record) {
  if (!record) return -1
  if (record.deliveryTarget === 'protected_branch') return 0
  if (record.state === 'landing') return record.landingState === 'landed' ? 2 : 1
  return { saved: 0, pushed: 3, building: 4, failed: 4, repairing: 5, unavailable: 3, production: 6 }[record.state] ?? -1
}

export function deliveryTone(record) {
  if (!record) return ''
  if (record.state === 'failed') return 'error'
  if (record.state === 'production') return 'done'
  if (record.deliveryTarget === 'protected_branch') return 'held'
  return 'active'
}

export function deliveryDetail(record) {
  if (!record) return ''
  const sha = record.savedSha ?? ''
  if (record.deliveryTarget === 'protected_branch') {
    return `Saved at ${sha} on this chat’s protected branch. Merge, push and deployment are off for this prompt.`
  }
  if (record.state === 'production') return `Verified live at ${record.productionCommitSha ?? sha}.`
  if (record.state === 'failed') return `${record.failureMessage ?? 'The deployment failed.'} Ensync will retry repair automatically.`
  if (record.state === 'landing' && record.landingState === 'retry' && record.failureMessage) return record.failureMessage
  if (record.state === 'unavailable') return record.failureMessage ?? 'Production status cannot be verified right now.'
  return record.targetBranch ? `${sha} → ${record.targetBranch}` : sha
}

/** The newest delivery of a conversation, or null. */
export function latestDelivery(delivery) {
  return Array.isArray(delivery?.records) && delivery.records.length ? delivery.records[0] : null
}
