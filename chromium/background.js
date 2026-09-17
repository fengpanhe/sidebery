import {
  TREE_STORAGE_KEY,
  SNAPSHOT_STORAGE_KEY,
  MAX_SNAPSHOTS,
  GROUP_COLORS,
  normalizeTree,
  planMove,
  descendantIds,
  removeBranchFromTree,
  removeFromTree,
  createSnapshot,
  validateSnapshot,
} from './model.js'

// No DOM or Firefox API dependency: all listeners register synchronously on every worker wake.
export function createBackground(api) {
  let tree = { parents: {}, folded: {} }
  let queue = Promise.resolve()
  const replacements = new Map()
  let restoringSnapshotTabs = false
  const listeners = []
  const sidePanelSupported = Boolean(api.sidePanel?.open)
  const listen = (event, handler) => {
    if (!event) return
    event.addListener(handler)
    listeners.push(() => event.removeListener?.(handler))
  }
  const broadcast = windowId =>
    api.runtime.sendMessage({ type: 'sidebery:changed', windowId }).catch(() => {})
  const persist = () => api.storage.session.set({ [TREE_STORAGE_KEY]: tree })
  const remapTab = (added, removed) => {
    if (tree.parents[removed] !== undefined) tree.parents[added] = tree.parents[removed]
    for (const id of Object.keys(tree.parents)) {
      if (tree.parents[id] === removed) tree.parents[id] = added
    }
    if (tree.folded[removed]) tree.folded[added] = true
    delete tree.parents[removed]
    delete tree.folded[removed]
  }
  const reconcile = async () => {
    const tabs = await api.tabs.query({})
    // Structural events can arrive while an API mutation is still awaiting its result.
    // Apply replacements before removing IDs which are no longer in the live tab list.
    for (const [removed, added] of replacements) remapTab(added, removed)
    replacements.clear()
    tree = normalizeTree(tabs, tree)
    await persist()
  }
  const enqueue = work => {
    const result = queue.then(() => ready).then(work)
    queue = result.catch(() => {})
    return result
  }
  const onChange = windowId => {
    void enqueue(async () => {
      await reconcile()
      await broadcast(windowId)
    }).catch(report)
  }
  const report = error => console.warn('Sidebery Chromium:', error?.message || error)
  const requireId = (id, label = 'tab') => {
    if (!Number.isInteger(id) || id < 0) throw new Error(`Invalid ${label} ID`)
    return id
  }
  const normalWindow = async id => {
    const window =
      Number.isInteger(id) && id >= 0
        ? await api.windows.get(id)
        : await api.windows.getLastFocused({ windowTypes: ['normal'] })
    if (window.type !== 'normal') throw new Error('Open the sidebar in a normal browser window')
    return window.id
  }
  const getTab = id => api.tabs.get(requireId(id))
  const getGroups = windowId => api.tabGroups.query({ windowId })
  const getSnapshotList = async () => {
    const stored = (await api.storage.local.get(SNAPSHOT_STORAGE_KEY))[SNAPSHOT_STORAGE_KEY]
    if (!Array.isArray(stored)) return []
    return stored.slice(0, MAX_SNAPSHOTS).flatMap(value => {
      try {
        return [validateSnapshot(value)]
      } catch {
        return []
      }
    })
  }
  const writeSnapshots = snapshots => api.storage.local.set({ [SNAPSHOT_STORAGE_KEY]: snapshots })
  const verifyOrder = async (windowId, desired) => {
    const actual = (await api.tabs.query({ windowId }))
      .sort((a, b) => a.index - b.index)
      .map(tab => tab.id)
    if (actual.length !== desired.length || actual.some((id, index) => id !== desired[index])) {
      throw new Error('Tabs changed during the operation; refresh the sidebar and try again')
    }
  }
  const validateTabIds = async ids => {
    if (!Array.isArray(ids) || !ids.length || ids.length > 1000)
      throw new Error('Choose 1–1000 tabs')
    const tabs = await Promise.all([...new Set(ids)].map(getTab))
    if (tabs.some(tab => tab.windowId !== tabs[0].windowId))
      throw new Error('Choose tabs from one window')
    return tabs
  }
  const groupProperties = message => {
    const properties = {}
    if (message.title !== undefined) {
      if (typeof message.title !== 'string' || message.title.length > 128)
        throw new Error('Group title is too long')
      properties.title = message.title
    }
    if (message.color !== undefined) {
      if (!GROUP_COLORS.includes(message.color)) throw new Error('Invalid group color')
      properties.color = message.color
    }
    if (message.collapsed !== undefined) properties.collapsed = Boolean(message.collapsed)
    return properties
  }

  async function perform(message, sender = {}) {
    await reconcile()
    let data = null
    let windowId = message.windowId ?? sender.tab?.windowId
    switch (message.action) {
      case 'getState': {
        windowId = await normalWindow(windowId)
        await reconcile()
        const [tabs, groups] = await Promise.all([
          api.tabs.query({ windowId }),
          getGroups(windowId),
        ])
        const ids = new Set(tabs.map(tab => String(tab.id)))
        return {
          windowId,
          tabs: tabs.sort((a, b) => a.index - b.index),
          groups,
          sidePanelSupported,
          parents: Object.fromEntries(Object.entries(tree.parents).filter(([id]) => ids.has(id))),
          folded: Object.fromEntries(Object.entries(tree.folded).filter(([id]) => ids.has(id))),
        }
      }
      case 'activate': {
        const tab = await getTab(message.tabId)
        windowId = tab.windowId
        if (tab.groupId !== -1) await api.tabGroups.update(tab.groupId, { collapsed: false })
        let parent = tree.parents[tab.id]
        while (parent !== undefined) {
          delete tree.folded[parent]
          parent = tree.parents[parent]
        }
        data = await api.tabs.update(tab.id, { active: true })
        await api.windows.update(windowId, { focused: true })
        break
      }
      case 'create': {
        windowId = await normalWindow(windowId)
        const parent = message.parentId === undefined ? null : await getTab(message.parentId)
        if (parent && (parent.windowId !== windowId || parent.pinned))
          throw new Error('Invalid parent tab')
        const groupId = message.groupId ?? parent?.groupId ?? -1
        if (groupId !== -1) {
          const group = await api.tabGroups.get(requireId(groupId, 'group'))
          if (group.windowId !== windowId || (parent && parent.groupId !== groupId))
            throw new Error('Invalid parent group')
        }
        const properties = { windowId, active: true }
        if (parent) {
          properties.openerTabId = parent.id
          properties.index = parent.index + 1
        }
        const tab = await api.tabs.create(properties)
        if (groupId !== -1) await api.tabs.group({ tabIds: [tab.id], groupId })
        if (parent) {
          tree.parents[tab.id] = parent.id
          delete tree.folded[parent.id]
        }
        data = await api.tabs.get(tab.id)
        break
      }
      case 'duplicate': {
        const source = await getTab(message.tabId)
        windowId = source.windowId
        const copy = await api.tabs.duplicate(source.id)
        if (!copy || copy.id === source.id) throw new Error('The browser could not copy this tab')
        if (!source.pinned && !copy.pinned) {
          tree.parents[copy.id] = source.id
          delete tree.folded[source.id]
        }
        data = copy
        break
      }
      case 'getWindows': {
        windowId = await normalWindow(windowId)
        const windows = await api.windows.getAll({ populate: true, windowTypes: ['normal'] })
        return windows
          .filter(window => window.type === 'normal' && window.id !== windowId)
          .map(window => {
            const tabs = window.tabs || []
            const active = tabs.find(tab => tab.active) || tabs[0]
            return {
              id: window.id,
              title: active?.title || `窗口 ${window.id}`,
              tabCount: tabs.length,
            }
          })
      }
      case 'moveToWindow': {
        const source = await getTab(message.tabId)
        const sourceWindowId = source.windowId
        const targetWindowId = await normalWindow(message.targetWindowId)
        if (sourceWindowId === targetWindowId) throw new Error('Choose a different browser window')
        tree = removeFromTree(tree, source.id)
        data = await api.tabs.move(source.id, { windowId: targetWindowId, index: -1 })
        windowId = targetWindowId
        await broadcast(sourceWindowId)
        break
      }
      case 'moveToNewWindow': {
        const source = await getTab(message.tabId)
        const sourceWindowId = source.windowId
        tree = removeFromTree(tree, source.id)
        const window = await api.windows.create({ tabId: source.id, focused: true, type: 'normal' })
        windowId = window.id
        data = { windowId, tabId: source.id }
        await broadcast(sourceWindowId)
        break
      }
      case 'close': {
        const tab = await getTab(message.tabId)
        windowId = tab.windowId
        if (tree.folded[tab.id]) {
          const tabs = await api.tabs.query({ windowId })
          const branch = [...descendantIds(tabs, tree.parents, tab.id)]
          tree = removeBranchFromTree(tree, branch)
          await api.tabs.remove(branch)
        } else {
          tree = removeFromTree(tree, tab.id)
          await api.tabs.remove(tab.id)
        }
        break
      }
      case 'pin':
      case 'mute': {
        const tab = await getTab(message.tabId)
        windowId = tab.windowId
        const properties =
          message.action === 'pin'
            ? { pinned: Boolean(message.pinned) }
            : { muted: Boolean(message.muted) }
        data = await api.tabs.update(tab.id, properties)
        break
      }
      case 'discard': {
        const tab = await getTab(message.tabId)
        windowId = tab.windowId
        if (tab.active) throw new Error('Switch to another tab before unloading this one')
        data = await api.tabs.discard(tab.id)
        if (data && data.id !== tab.id) remapTab(data.id, tab.id)
        break
      }
      case 'move': {
        const tabs = await api.tabs.query({})
        const plan = planMove(
          tabs,
          tree,
          requireId(message.tabId),
          requireId(message.targetId),
          message.placement
        )
        windowId = plan.windowId
        const source = tabs.find(tab => tab.id === message.tabId)
        const destination = plan.order.indexOf(message.tabId)
        const offsets = plan.movingIds.map((id, offset) => ({ id, offset }))
        if (destination > source.index) offsets.reverse()
        // Moving unrelated tabs can tear apart their native groups. Move only the dragged branch.
        for (const { id, offset } of offsets) {
          await api.tabs.move(id, { index: destination + offset })
        }
        // Chrome may change group membership while tabs cross a group boundary.
        if (plan.groupId === -1) await api.tabs.ungroup(plan.movingIds)
        else await api.tabs.group({ tabIds: plan.movingIds, groupId: plan.groupId })
        await verifyOrder(windowId, plan.order)
        tree = { parents: plan.parents, folded: plan.folded }
        break
      }
      case 'toggleFold': {
        const tab = await getTab(message.tabId)
        windowId = tab.windowId
        if (tab.pinned) throw new Error('Pinned tabs cannot have children')
        if (tree.folded[tab.id]) delete tree.folded[tab.id]
        else tree.folded[tab.id] = true
        break
      }
      case 'group': {
        const tabs = await validateTabIds(message.tabIds)
        const properties = groupProperties(message)
        if (tabs.some(tab => tab.pinned)) throw new Error('Unpin tabs before grouping them')
        windowId = tabs[0].windowId
        const groupId = await api.tabs.group({ tabIds: tabs.map(tab => tab.id) })
        data = await api.tabGroups.update(groupId, properties)
        break
      }
      case 'updateGroup': {
        const group = await api.tabGroups.get(requireId(message.groupId, 'group'))
        windowId = group.windowId
        data = await api.tabGroups.update(group.id, groupProperties(message))
        break
      }
      case 'ungroup': {
        const tabs = await validateTabIds(message.tabIds)
        windowId = tabs[0].windowId
        await api.tabs.ungroup(tabs.map(tab => tab.id))
        break
      }
      case 'saveSnapshot': {
        windowId = await normalWindow(windowId)
        if (message.name !== undefined && typeof message.name !== 'string')
          throw new Error('Invalid snapshot name')
        const [tabs, groups, snapshots] = await Promise.all([
          api.tabs.query({ windowId }),
          getGroups(windowId),
          getSnapshotList(),
        ])
        data = createSnapshot(tabs, groups, tree, { name: message.name })
        await writeSnapshots([data, ...snapshots].slice(0, MAX_SNAPSHOTS))
        break
      }
      case 'getSnapshots':
        return getSnapshotList()
      case 'deleteSnapshot': {
        const snapshots = await getSnapshotList()
        await writeSnapshots(snapshots.filter(snapshot => snapshot.id !== message.snapshotId))
        break
      }
      case 'restoreSnapshot': {
        const snapshots = await getSnapshotList()
        const found = snapshots.find(snapshot => snapshot.id === message.snapshotId)
        if (!found) throw new Error('Snapshot not found or contains unsupported data')
        const snapshot = validateSnapshot(found)
        // Validate everything before opening a window. A partial restore is left visible on API failure.
        let restored
        restoringSnapshotTabs = true
        try {
          const window = await api.windows.create({
            url: snapshot.tabs[0].url,
            focused: true,
            type: 'normal',
          })
          windowId = window.id
          const first = window.tabs?.[0] ?? (await api.tabs.query({ windowId }))[0]
          restored = [first]
          if (snapshot.tabs[0].pinned) await api.tabs.update(first.id, { pinned: true })
          for (let index = 1; index < snapshot.tabs.length; index++) {
            const tab = snapshot.tabs[index]
            restored.push(
              await api.tabs.create({
                windowId,
                url: tab.url,
                pinned: tab.pinned,
                active: false,
                index,
              })
            )
          }
        } finally {
          restoringSnapshotTabs = false
        }
        for (let index = 0; index < snapshot.groups.length; index++) {
          const ids = restored
            .filter((_, at) => snapshot.tabs[at].group === index)
            .map(tab => tab.id)
          if (!ids.length) continue
          const groupId = await api.tabs.group({ tabIds: ids })
          await api.tabGroups.update(groupId, snapshot.groups[index])
        }
        await verifyOrder(
          windowId,
          restored.map(tab => tab.id)
        )
        snapshot.tabs.forEach((tab, index) => {
          if (tab.parent !== null) tree.parents[restored[index].id] = restored[tab.parent].id
          if (tab.folded) tree.folded[restored[index].id] = true
        })
        const activeIndex = Math.max(
          0,
          snapshot.tabs.findIndex(tab => tab.active)
        )
        await api.tabs.update(restored[activeIndex].id, { active: true })
        data = { windowId, tabCount: restored.length }
        break
      }
      default:
        throw new Error('Unknown sidebar action')
    }
    await reconcile()
    await broadcast(windowId)
    return data
  }

  const dispatch = (message, sender) => enqueue(() => perform(message, sender))
  listen(api.runtime.onMessage, (message, sender, sendResponse) => {
    if (message?.type !== 'sidebery' || (sender?.id && sender.id !== api.runtime.id)) return false
    dispatch(message, sender).then(
      data => sendResponse({ ok: true, data }),
      error => sendResponse({ ok: false, error: error?.message || 'The operation failed' })
    )
    return true
  })
  listen(api.tabs.onCreated, tab => {
    const shouldSkipExternalPlacement = restoringSnapshotTabs
    void enqueue(async () => {
      let tabs = await api.tabs.query({})
      const current = tabs.find(item => item.id === tab.id)
      const source = tabs.find(item => item.id === tab.openerTabId)
      if (
        current &&
        source &&
        !current.pinned &&
        !source.pinned &&
        current.windowId === source.windowId &&
        current.groupId === source.groupId &&
        tree.parents[current.id] === undefined
      )
        // Tabs with an explicit browser opener belong directly beneath that opener.
        tree.parents[current.id] = source.id
      else if (
        current &&
        tab.openerTabId === undefined &&
        !shouldSkipExternalPlacement &&
        tree.parents[current.id] === undefined &&
        !current.pinned
      ) {
        // OS/app links have no opener: keep them as root tabs at the end of the list.
        await api.tabs.move(current.id, { index: -1 })
        tabs = await api.tabs.query({})
      }
      tree = normalizeTree(tabs, tree)
      await persist()
      await broadcast(tab.windowId)
    }).catch(report)
  })
  listen(api.tabs.onRemoved, (id, info) => {
    void enqueue(async () => {
      if (tree.folded[id]) {
        const tabs = await api.tabs.query({})
        const descendants = [...descendantIds(tabs, tree.parents, id)].filter(tabId => tabId !== id)
        tree = removeBranchFromTree(tree, [id, ...descendants])
        if (descendants.length) await api.tabs.remove(descendants)
      } else tree = removeFromTree(tree, id)
      await reconcile()
      await broadcast(info.windowId)
    }).catch(report)
  })
  listen(api.tabs.onUpdated, (_id, _info, tab) => onChange(tab.windowId))
  listen(api.tabs.onMoved, (_id, info) => onChange(info.windowId))
  listen(api.tabs.onAttached, (_id, info) => onChange(info.newWindowId))
  listen(api.tabs.onDetached, (_id, info) => onChange(info.oldWindowId))
  listen(api.tabs.onActivated, info => {
    void enqueue(async () => {
      await reconcile()
      let parent = tree.parents[info.tabId]
      while (parent !== undefined) {
        delete tree.folded[parent]
        parent = tree.parents[parent]
      }
      await persist()
      await broadcast(info.windowId)
    }).catch(report)
  })
  listen(api.tabs.onReplaced, (added, removed) => {
    replacements.set(removed, added)
    onChange()
  })
  for (const event of ['onCreated', 'onUpdated', 'onMoved', 'onRemoved']) {
    listen(api.tabGroups[event], group => onChange(group.windowId))
  }
  listen(api.windows.onRemoved, () => onChange())

  function openSidebar(windowId) {
    if (sidePanelSupported && Number.isInteger(windowId)) {
      return api.sidePanel.open({ windowId })
    }
    return normalWindow(windowId).then(id =>
      sidePanelSupported
        ? api.sidePanel.open({ windowId: id })
        : api.windows.create({
            url: api.runtime.getURL(`sidebar.html?windowId=${id}`),
            type: 'popup',
            width: 420,
            height: 800,
          })
    )
  }
  listen(api.commands?.onCommand, (command, tab) => {
    if (command === 'open-sidebar') void openSidebar(tab?.windowId).catch(report)
  })
  if (sidePanelSupported) {
    void api.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(report)
  } else {
    listen(api.action.onClicked, tab => {
      void openSidebar(tab?.windowId).catch(report)
    })
  }

  const ready = (async () => {
    const stored = await api.storage.session.get(TREE_STORAGE_KEY)
    const value = stored[TREE_STORAGE_KEY]
    // Preserve removed IDs until the event which woke the worker can reparent/remap them.
    // Ordinary requests and non-structural events reconcile against live tabs before use.
    tree = {
      parents: Object.fromEntries(
        Object.entries(value?.parents ?? {}).filter(
          ([id, parent]) => /^\d+$/.test(id) && Number.isInteger(parent) && parent >= 0
        )
      ),
      folded: Object.fromEntries(
        Object.entries(value?.folded ?? {}).filter(
          ([id, folded]) => /^\d+$/.test(id) && folded === true
        )
      ),
    }
  })()
  // The session area intentionally survives worker suspension, but not a browser relaunch.
  void ready.catch(report)
  return {
    dispatch,
    ready,
    idle: () => queue,
    dispose: () => listeners.forEach(remove => remove()),
  }
}

if (globalThis.chrome?.runtime?.onMessage) createBackground(globalThis.chrome)
