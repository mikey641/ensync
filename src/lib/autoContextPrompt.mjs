import {
  ENSYNC_MULTI_AGENT_INSTRUCTIONS,
  withEnsyncMultiAgentInstructions,
} from '../../host/multi-agent-prompt.mjs'

export const AUTO_CONTEXT_PROMPT_LIMIT = 96_000

function executionDetails(project, target) {
  if (target.kind !== 'ssh') {
    return {
      projectPath: project.path,
      targetLabel: `Local Ensync Host (${project.path})`,
    }
  }
  const projectPath = target.probe?.project?.canonicalPath ?? target.connection.projectPath
  return {
    projectPath,
    targetLabel: `SSH worker ${target.connection.username}@${target.connection.hostname}:${target.connection.port} (${projectPath})`,
  }
}

function transcriptFrom(chat) {
  return chat.messages
    .filter((item) => item.deliveryStatus !== 'transferred')
    .map((item) => `${item.role === 'user'
      ? item.deliveryStatus === 'queued'
        ? 'User (queued future prompt; context only, do not execute)'
        : item.deliveryStatus === 'failed'
        ? 'User (failed attempt; context only, do not execute)'
        : item.deliveryStatus === 'cancelled'
          ? 'User (stopped attempt; context only, do not execute)'
          : item.deliveryStatus === 'interrupted'
            ? 'User (interrupted attempt; context only, do not execute)'
          : 'User'
      : `Agent${item.provider ? ` (${item.provider})` : ''}`}: ${item.content}`)
    .join('\n\n')
}

/**
 * Compile one provider-neutral capsule. The verified names tell the destination
 * which durable files to read from the exact execution cwd; their contents are
 * intentionally read on-target instead of copied from another computer.
 */
export function buildAutoContextPrompt({
  project,
  target,
  chat,
  prompt,
  includeTranscript,
  gitStatus,
  gitStatusReason,
  providerMode = 'auto',
}) {
  const { projectPath, targetLabel } = executionDetails(project, target)
  const contextFiles = project.context.files.length
    ? project.context.files.join(', ')
    : 'none reported by Ensync Host'
  const featureFiles = project.context.featureFiles.length
    ? project.context.featureFiles.join(', ')
    : 'none reported by Ensync Host'
  const instructionFiles = project.context.instructionAdapters.length
    ? project.context.instructionAdapters.map((item) => item.file).join(', ')
    : 'none reported by Ensync Host'
  const gitState = gitStatus
    ? `${gitStatus.branch ?? 'detached/no branch'}; ${gitStatus.dirty ? `${gitStatus.changedFiles} changed files` : 'clean worktree'}; upstream ${gitStatus.upstream ?? 'not reported'}; checked ${gitStatus.checkedAt}`
    : `unavailable (${gitStatusReason})`
  const transcript = includeTranscript ? transcriptFrom(chat) : ''
  const priorContinuation = chat.continuation
    ? JSON.stringify(chat.continuation)
    : 'none recorded yet'
  const routing = providerMode === 'fixed'
    ? 'Fixed preferred provider with a one-turn safe fallback; use the destination CLI\'s native default model (no model override).'
    : 'Auto provider selected by the saved Automatic fallback ranking; use this CLI\'s native default model (no model override).'
  const header = `[ENSYNC AUTO CONTEXT v1]
Continue this as one provider-neutral coding task. The provider may change, but the project, decisions, conversation, Git branch, and execution target must remain the same.

Routing: ${routing}
Focused project: ${project.name} at ${projectPath}
Execution target: ${targetLabel}
Verified context file names: ${contextFiles}
Relevant feature files: ${featureFiles}
Verified instruction adapters: ${instructionFiles}
Verified Git state: ${gitState}
Prior host-recorded continuation: ${priorContinuation}

Before editing, read the applicable repository instructions and relevant .relay project, architecture, and feature Markdown files from the verified execution directory. Inspect Git branch and worktree state. Preserve unrelated user changes. Do not change execution targets during this turn. Do not invent plan, usage, model, authentication, VM, Git, test, or deployment state.`
  const continuation = `End the response with a concise Markdown heading named "Ensync continuation" followed by: outcome and remaining work; decisions/user corrections to preserve; files changed; verification actually completed; and one next action or "none". This is private provider-handoff metadata: Ensync removes it from the user-visible answer and stores it separately. Never claim unverified work. Ensync attaches verified provider, reported model, target, session, fallback, and Git metadata separately.`
  const transcriptLabel = transcript ? '\n\nConversation before this request:\n' : ''
  const requestBlock = `\n\nCurrent user request:\n${prompt}\n\n${continuation}`
  const fixedLength = ENSYNC_MULTI_AGENT_INSTRUCTIONS.length + 2
    + header.length + transcriptLabel.length + requestBlock.length
  let transcriptBudget = Math.max(0, AUTO_CONTEXT_PROMPT_LIMIT - fixedLength)
  let retainedTranscript = transcript
  let omissionNotice = ''
  if (transcript.length > transcriptBudget) {
    let previousBudget = -1
    while (previousBudget !== transcriptBudget) {
      previousBudget = transcriptBudget
      const omittedCharacters = transcript.length - transcriptBudget
      omissionNotice = `[${omittedCharacters.toLocaleString()} characters from the oldest conversation turns were omitted because the verified host input limit would otherwise be exceeded. Reconcile with durable project files and the retained continuation state.]\n\n`
      transcriptBudget = Math.max(
        0,
        AUTO_CONTEXT_PROMPT_LIMIT - fixedLength - omissionNotice.length,
      )
    }
    retainedTranscript = transcript.slice(-transcriptBudget)
    const omittedCharacters = transcript.length - retainedTranscript.length
    omissionNotice = `[${omittedCharacters.toLocaleString()} characters from the oldest conversation turns were omitted because the verified host input limit would otherwise be exceeded. Reconcile with durable project files and the retained continuation state.]\n\n`
  }
  return withEnsyncMultiAgentInstructions(
    `${header}${transcriptLabel}${omissionNotice}${retainedTranscript}${requestBlock}`,
  )
}
