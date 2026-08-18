/**
 * Moved to host/safe-fallback.mjs so the daemon, the connector CLI, and the
 * renderer all decide "was this failure safe to hand to another provider?" with
 * one implementation. host/ is the only source directory the installed app ships
 * beside the daemon, so a copy in src/lib could not be reached from a headless
 * run. Existing renderer imports keep working through this re-export.
 */
export { appendFallbackReason, safeFallbackProof } from '../../host/safe-fallback.mjs'
