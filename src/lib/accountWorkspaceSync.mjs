// The account workspace merge rules live beside the Host so the packaged Host
// (which does not ship src/) applies exactly the same semantics when it writes
// a brokered reply into the encrypted workspace document.
export * from '../../host/account-workspace.mjs'
