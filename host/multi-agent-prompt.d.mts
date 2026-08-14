export const ENSYNC_MULTI_AGENT_MARKER: string
export const ENSYNC_AGENT_COORDINATION_POLICY: 'ensync_agent_coordination_v1'
export const ENSYNC_MULTI_AGENT_INSTRUCTIONS: string
export function withoutLeadingEnsyncMultiAgentInstructions(prompt: unknown): string
export function withEnsyncMultiAgentInstructions(prompt: unknown): string
