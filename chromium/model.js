// Browser-independent tree and snapshot rules shared by the MV3 worker and tests.
export const TREE_STORAGE_KEY = 'sidebery.chromium.tree.v1'
export const SNAPSHOT_STORAGE_KEY = 'sidebery.chromium.snapshots.v1'
export const GROUP_COLORS = [
  'grey',
  'blue',
  'red',
  'yellow',
  'green',
  'pink',
  'purple',
  'cyan',
  'orange',
]
export const MAX_SNAPSHOTS = 20
export const MAX_SNAPSHOT_TABS = 1000

export function normalizeTree(tabs, metadata = {}) {
  metadata ??= {}
  const parents = {}
  const folded = {}
  const byId = new Map(tabs.map(tab => [tab.id, tab]))
  const ordered = [...tabs].sort((a, b) => a.windowId - b.windowId || a.index - b.index)
  let ancestors = []
  let windowId
  for (const tab of ordered) {
    if (tab.windowId !== windowId) ancestors = []
    windowId = tab.windowId
    const parentId = metadata.parents?.[tab.id]
    const parent = byId.get(parentId)
    const at = ancestors.indexOf(parentId)
    if (
      parent &&
      !tab.pinned &&
      !parent.pinned &&
      parent.windowId === tab.windowId &&
      parent.groupId === tab.groupId &&
      parent.index < tab.index &&
      at !== -1
    ) {
      parents[tab.id] = parentId
      ancestors.length = at + 1
    } else {
      ancestors = []
    }
    ancestors.push(tab.id)
    if (!tab.pinned && metadata.folded?.[tab.id] === true) folded[tab.id] = true
  }
  return { parents, folded }
}

export function descendantIds(tabs, parents, tabId) {
  const result = new Set([tabId])
  // The visited set also makes this safe for malformed input with a cycle.
  let changed = true
  while (changed) {
    changed = false
    for (const tab of tabs) {
      if (!result.has(tab.id) && result.has(parents[tab.id])) {
        result.add(tab.id)
        changed = true
      }
    }
  }
  return result
}

export function planMove(tabs, metadata, tabId, targetId, placement) {
  if (!['before', 'after', 'inside'].includes(placement)) throw new Error('Invalid drop position')
  const source = tabs.find(tab => tab.id === tabId)
  const target = tabs.find(tab => tab.id === targetId)
  if (!source || !target) throw new Error('The tab no longer exists')
  if (source.windowId !== target.windowId) throw new Error('Move tabs within the same window')
  if (source.pinned !== target.pinned || (source.pinned && placement === 'inside')) {
    throw new Error('Pinned tabs cannot be nested or mixed with unpinned tabs')
  }
  const tree = normalizeTree(tabs, metadata)
  const branch = descendantIds(tabs, tree.parents, tabId)
  if (branch.has(targetId)) throw new Error('A tab cannot be moved into its own branch')
  const ordered = tabs
    .filter(tab => tab.windowId === source.windowId)
    .sort((a, b) => a.index - b.index)
  const moving = ordered.filter(tab => branch.has(tab.id))
  const remaining = ordered.filter(tab => !branch.has(tab.id))
  let insertion = remaining.findIndex(tab => tab.id === targetId)
  if (placement !== 'before') {
    const targetBranch = descendantIds(remaining, tree.parents, targetId)
    while (insertion < remaining.length && targetBranch.has(remaining[insertion].id)) insertion++
  }
  const parentId = placement === 'inside' ? targetId : tree.parents[targetId]
  if (parentId === undefined) delete tree.parents[tabId]
  else tree.parents[tabId] = parentId
  remaining.splice(insertion, 0, ...moving)
  return {
    windowId: source.windowId,
    movingIds: moving.map(tab => tab.id),
    order: remaining.map(tab => tab.id),
    groupId: target.groupId,
    parents: tree.parents,
    folded: tree.folded,
  }
}

export function removeFromTree(metadata, tabId) {
  const parents = { ...metadata.parents }
  const folded = { ...metadata.folded }
  for (const [child, parent] of Object.entries(parents)) {
    if (parent !== tabId) continue
    if (parents[tabId] === undefined) delete parents[child]
    else parents[child] = parents[tabId]
  }
  delete parents[tabId]
  delete folded[tabId]
  return { parents, folded }
}

export function removeBranchFromTree(metadata, tabIds) {
  const removed = new Set(tabIds)
  const parents = {}
  const folded = {}
  for (const [child, parent] of Object.entries(metadata.parents)) {
    if (!removed.has(Number(child)) && !removed.has(parent)) parents[child] = parent
  }
  for (const [id, value] of Object.entries(metadata.folded)) {
    if (!removed.has(Number(id)) && value === true) folded[id] = true
  }
  return { parents, folded }
}

export function isSafeSnapshotUrl(value) {
  if (typeof value !== 'string' || value.length > 8192) return false
  if (['chrome://newtab/', 'chrome://newtab', 'brave://newtab/', 'brave://newtab'].includes(value))
    return true
  try {
    const url = new URL(value)
    return (url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password
  } catch {
    return false
  }
}

export function createSnapshot(tabs, groups, metadata, options = {}) {
  if (!tabs.length || tabs.length > MAX_SNAPSHOT_TABS)
    throw new Error('A snapshot supports 1–1000 tabs')
  const unsupported = tabs.filter(tab => !isSafeSnapshotUrl(tab.url))
  if (unsupported.length)
    throw new Error(
      `Cannot save snapshot: ${unsupported.length} tab(s) use unsupported URLs. Snapshots support HTTP(S) pages and new tabs.`
    )
  const ordered = [...tabs].sort((a, b) => a.index - b.index)
  const tree = normalizeTree(ordered, metadata)
  const tabIndices = new Map(ordered.map((tab, index) => [tab.id, index]))
  const relevantGroups = groups.filter(group => ordered.some(tab => tab.groupId === group.id))
  const groupIndices = new Map(relevantGroups.map((group, index) => [group.id, index]))
  return validateSnapshot({
    id: options.id ?? crypto.randomUUID(),
    name: (options.name || `Snapshot ${new Date().toLocaleString()}`).slice(0, 128),
    createdAt: options.createdAt ?? Date.now(),
    tabs: ordered.map(tab => ({
      url: tab.url.startsWith('brave://newtab') ? 'chrome://newtab/' : tab.url,
      title: (tab.title || 'New tab').slice(0, 512),
      pinned: Boolean(tab.pinned),
      active: Boolean(tab.active),
      parent: tabIndices.get(tree.parents[tab.id]) ?? null,
      group: groupIndices.get(tab.groupId) ?? null,
      folded: Boolean(tree.folded[tab.id]),
    })),
    groups: relevantGroups.map(group => ({
      title: (group.title || '').slice(0, 128),
      color: GROUP_COLORS.includes(group.color) ? group.color : 'grey',
      collapsed: Boolean(group.collapsed),
    })),
  })
}

export function validateSnapshot(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    typeof value.id !== 'string' ||
    !value.id ||
    value.id.length > 128 ||
    typeof value.name !== 'string' ||
    value.name.length > 128 ||
    !Number.isFinite(value.createdAt) ||
    !Array.isArray(value.tabs) ||
    !value.tabs.length ||
    value.tabs.length > MAX_SNAPSHOT_TABS ||
    !Array.isArray(value.groups) ||
    value.groups.length > MAX_SNAPSHOT_TABS
  )
    throw new Error('Invalid snapshot')
  const groups = value.groups.map(group => {
    if (
      !group ||
      typeof group.title !== 'string' ||
      group.title.length > 128 ||
      !GROUP_COLORS.includes(group.color)
    )
      throw new Error('Invalid snapshot group')
    return { title: group.title, color: group.color, collapsed: group.collapsed === true }
  })
  const tabs = value.tabs.map((tab, index) => {
    if (
      !tab ||
      !isSafeSnapshotUrl(tab.url) ||
      typeof tab.title !== 'string' ||
      tab.title.length > 512 ||
      !(
        tab.parent === null ||
        (Number.isInteger(tab.parent) && tab.parent >= 0 && tab.parent < index)
      ) ||
      !(
        tab.group === null ||
        (Number.isInteger(tab.group) && tab.group >= 0 && tab.group < groups.length)
      ) ||
      (tab.pinned && (tab.parent !== null || tab.group !== null))
    )
      throw new Error('Invalid snapshot tab')
    if (tab.parent !== null) {
      const parent = value.tabs[tab.parent]
      if (parent.pinned || parent.group !== tab.group) throw new Error('Invalid snapshot parent')
    }
    return {
      url: tab.url.startsWith('brave://newtab') ? 'chrome://newtab/' : tab.url,
      title: tab.title,
      parent: tab.parent,
      group: tab.group,
      pinned: tab.pinned === true,
      active: tab.active === true,
      folded: tab.folded === true,
    }
  })
  // Validate native group contiguity and the pinned prefix before creating any browser state.
  let sawUnpinned = false
  let previousGroup = null
  const completedGroups = new Set()
  for (const tab of tabs) {
    if (!tab.pinned) sawUnpinned = true
    else if (sawUnpinned) throw new Error('Invalid pinned tab order')
    if (tab.group !== previousGroup) {
      if (previousGroup !== null) completedGroups.add(previousGroup)
      if (tab.group !== null && completedGroups.has(tab.group))
        throw new Error('Invalid group order')
      previousGroup = tab.group
    }
  }
  return { id: value.id, name: value.name, createdAt: value.createdAt, tabs, groups }
}
