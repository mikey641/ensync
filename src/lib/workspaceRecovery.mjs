import { reconcileInterruptedWorkspaceState } from './workspacePersistence.mjs'

function serialized(value) {
  try { return JSON.stringify(value) } catch { return '' }
}

function equivalent(left, right) {
  return serialized(left) === serialized(right)
}

function fingerprint(value) {
  const text = serialized(value)
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

function pathIdentity(value) {
  if (typeof value !== 'string') return ''
  const normalized = value.replaceAll('\\', '/').replace(/\/+$/, '')
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized
}

function collisionSafeId(id, value, occupied) {
  if (!occupied.has(id)) return id
  if (equivalent(occupied.get(id), value)) return id
  const base = `${id}-recovered-${fingerprint(value)}`
  let candidate = base
  let suffix = 2
  const valueAt = (candidateId) => value && typeof value === 'object' && !Array.isArray(value)
    ? { ...value, id: candidateId }
    : value
  while (occupied.has(candidate) && !equivalent(occupied.get(candidate), valueAt(candidate))) {
    candidate = `${base}-${suffix}`
    suffix += 1
  }
  return candidate
}

function remapRecord(source, idMap, current = {}) {
  const merged = { ...current }
  for (const [oldId, value] of Object.entries(source ?? {})) {
    const mappedId = idMap.get(oldId)
    if (mappedId && !Object.prototype.hasOwnProperty.call(merged, mappedId)) merged[mappedId] = value
  }
  return merged
}

function remapSplitLayout(current, recovered, tabIdMap) {
  if (!recovered || typeof recovered !== 'object') return current
  const recoveredPaneSizes = Object.fromEntries(
    Object.entries(recovered.paneSizes ?? {})
      .map(([tabId, size]) => [tabIdMap.get(tabId), size])
      .filter(([tabId]) => Boolean(tabId)),
  )
  const recoveredHidden = (Array.isArray(recovered.hiddenTabIds) ? recovered.hiddenTabIds : [])
    .map((tabId) => tabIdMap.get(tabId))
    .filter(Boolean)
  if (!current || typeof current !== 'object') {
    return {
      ...recovered,
      paneSizes: recoveredPaneSizes,
      hiddenTabIds: recoveredHidden,
      maximizedTabId: recovered.maximizedTabId ? tabIdMap.get(recovered.maximizedTabId) ?? null : null,
    }
  }
  return {
    ...current,
    paneSizes: { ...recoveredPaneSizes, ...(current.paneSizes ?? {}) },
    hiddenTabIds: [...new Set([...(current.hiddenTabIds ?? []), ...recoveredHidden])],
    maximizedTabId: current.maximizedTabId ?? null,
  }
}

/**
 * Adds a historical canonical workspace to the current canonical workspace.
 * Current state always wins: active runs, settings, drafts, tabs, projects, and
 * IDs are never replaced. Recovered collisions receive deterministic IDs and
 * every chat/tab-scoped record follows the same remap. Recovered pending runs
 * are reconciled before merge and can therefore never be replayed.
 */
export function mergeRecoveredWorkspaceState(currentState, recoveredState, options = {}) {
  const current = currentState && typeof currentState === 'object' ? currentState : {}
  const recoveredInput = recoveredState && typeof recoveredState === 'object' ? recoveredState : {}
  const recovered = reconcileInterruptedWorkspaceState(recoveredInput, options).state

  const currentProjects = Array.isArray(current.projects) ? current.projects : []
  const projects = [...currentProjects]
  const projectsById = new Map(projects.map((project) => [project.id, project]))
  const projectByPath = new Map(projects.map((project) => [pathIdentity(project.path), project]))
  const projectIdMap = new Map()
  let addedProjects = 0
  for (const sourceProject of Array.isArray(recovered.projects) ? recovered.projects : []) {
    const samePath = projectByPath.get(pathIdentity(sourceProject.path))
    if (samePath) {
      projectIdMap.set(sourceProject.id, samePath.id)
      continue
    }
    const nextId = collisionSafeId(sourceProject.id, sourceProject, projectsById)
    const project = nextId === sourceProject.id ? sourceProject : { ...sourceProject, id: nextId }
    projectIdMap.set(sourceProject.id, nextId)
    if (!projectsById.has(nextId)) {
      projects.push(project)
      projectsById.set(nextId, project)
      projectByPath.set(pathIdentity(project.path), project)
      addedProjects += 1
    }
  }

  const chats = [...(Array.isArray(current.chats) ? current.chats : [])]
  const chatsById = new Map(chats.map((chat) => [chat.id, chat]))
  const chatIdMap = new Map()
  let addedChats = 0
  for (const sourceChat of Array.isArray(recovered.chats) ? recovered.chats : []) {
    const mappedProjectId = projectIdMap.get(sourceChat.projectId) ?? sourceChat.projectId
    const remapped = mappedProjectId === sourceChat.projectId
      ? sourceChat
      : { ...sourceChat, projectId: mappedProjectId }
    const nextId = collisionSafeId(sourceChat.id, remapped, chatsById)
    const chat = nextId === remapped.id ? remapped : { ...remapped, id: nextId }
    chatIdMap.set(sourceChat.id, nextId)
    if (!chatsById.has(nextId)) {
      chats.push(chat)
      chatsById.set(nextId, chat)
      addedChats += 1
    }
  }

  const tabs = [...(Array.isArray(current.tabs) ? current.tabs : [])]
  const tabsById = new Map(tabs.map((tab) => [tab.id, tab]))
  const openChatIds = new Set(tabs.map((tab) => tab.chatId))
  const tabIdMap = new Map()
  let addedTabs = 0
  for (const sourceTab of Array.isArray(recovered.tabs) ? recovered.tabs : []) {
    const mappedChatId = chatIdMap.get(sourceTab.chatId)
    if (!mappedChatId) continue
    const existingForChat = tabs.find((tab) => tab.chatId === mappedChatId)
    if (existingForChat) {
      tabIdMap.set(sourceTab.id, existingForChat.id)
      continue
    }
    const remapped = { ...sourceTab, chatId: mappedChatId }
    const nextId = collisionSafeId(sourceTab.id, remapped, tabsById)
    const tab = nextId === remapped.id ? remapped : { ...remapped, id: nextId }
    tabIdMap.set(sourceTab.id, nextId)
    if (!tabsById.has(nextId) && !openChatIds.has(mappedChatId)) {
      tabs.push(tab)
      tabsById.set(nextId, tab)
      openChatIds.add(mappedChatId)
      addedTabs += 1
    }
  }

  const chatScopedKeys = [
    'chatSessions',
    'readCompletionByChat',
    'executionPanelOpenByChat',
    'drafts',
    'draftAttachments',
    'chatErrors',
    'chatExecutionEvents',
    'promptQueues',
  ]
  const merged = {
    ...recovered,
    ...current,
    projects,
    chats,
    tabs,
    splitLayout: remapSplitLayout(current.splitLayout, recovered.splitLayout, tabIdMap),
    // Only live current runs survive. Historical pending work was reconciled.
    inFlightRuns: { ...(current.inFlightRuns ?? {}) },
  }
  for (const key of chatScopedKeys) {
    merged[key] = remapRecord(recovered[key], chatIdMap, current[key])
  }

  return {
    state: merged,
    summary: {
      addedProjects,
      addedChats,
      addedTabs,
      reconciledRecoveredRuns: Object.keys(recoveredInput.inFlightRuns ?? {}).length,
    },
    mappings: { projectIdMap, chatIdMap, tabIdMap },
  }
}
