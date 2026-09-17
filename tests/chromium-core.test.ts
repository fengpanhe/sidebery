import { describe, expect, test, vi } from 'vitest'
import {
  TREE_STORAGE_KEY,
  SNAPSHOT_STORAGE_KEY,
  normalizeTree,
  planMove,
  removeBranchFromTree,
  removeFromTree,
  createSnapshot,
  validateSnapshot,
  isSafeSnapshotUrl,
} from '../chromium/model.js'
import { createBackground } from '../chromium/background.js'

function tab(id: number, index: number, extra: Record<string, unknown> = {}) {
  return {
    id,
    index,
    windowId: 1,
    groupId: -1,
    pinned: false,
    active: false,
    url: `https://example.com/${id}`,
    title: `Tab ${id}`,
    ...extra,
  }
}

describe('Chromium tree model', () => {
  test('keeps contiguous descendants and removes stale, cyclic, cross-window/group and pinned parents', () => {
    const tabs = [
      tab(1, 0),
      tab(2, 1),
      tab(3, 2),
      tab(4, 3),
      tab(5, 4),
      tab(6, 5, { groupId: 7 }),
      tab(7, 6, { pinned: true }),
      tab(8, 0, { windowId: 2 }),
    ]
    expect(
      normalizeTree(tabs, {
        parents: { 1: 2, 2: 1, 3: 2, 5: 1, 6: 5, 7: 6, 8: 1, 999: 1 },
        folded: { 1: true, 7: true, 999: true },
      })
    ).toEqual({ parents: { 2: 1, 3: 2 }, folded: { 1: true } })
    expect(normalizeTree(tabs, null)).toEqual({ parents: {}, folded: {} })
  })

  test('moves a complete branch and attaches it after the target descendants', () => {
    const tabs = [1, 2, 3, 4, 5].map((id, index) => tab(id, index))
    const tree = { parents: { 2: 1, 3: 2, 5: 4 }, folded: { 1: true } }
    const result = planMove(tabs, tree, 2, 4, 'inside')
    expect(result.order).toEqual([1, 4, 5, 2, 3])
    expect(result.movingIds).toEqual([2, 3])
    expect(result.parents).toEqual({ 2: 4, 3: 2, 5: 4 })
    expect(planMove(tabs, tree, 2, 4, 'after').parents).toEqual({ 3: 2, 5: 4 })
    expect(tree.parents).toEqual({ 2: 1, 3: 2, 5: 4 })
  })

  test('rejects moves into descendants, between windows, and into pinned tabs', () => {
    const tabs = [tab(1, 0), tab(2, 1), tab(3, 0, { windowId: 2 }), tab(4, 2, { pinned: true })]
    expect(() => planMove(tabs, { parents: { 2: 1 } }, 1, 2, 'inside')).toThrow('own branch')
    expect(() => planMove(tabs, {}, 1, 3, 'before')).toThrow('same window')
    expect(() => planMove(tabs, {}, 1, 4, 'inside')).toThrow('Pinned')
  })

  test('reparents direct children when their parent closes', () => {
    expect(removeFromTree({ parents: { 2: 1, 3: 2, 4: 3 }, folded: { 2: true } }, 2)).toEqual({
      parents: { 3: 1, 4: 3 },
      folded: {},
    })
  })

  test('removes a folded branch without retaining its children or descendants', () => {
    expect(
      removeBranchFromTree(
        { parents: { 2: 1, 3: 2, 4: 3, 5: 1 }, folded: { 2: true, 3: true, 5: true } },
        [2, 3, 4]
      )
    ).toEqual({ parents: { 5: 1 }, folded: { 5: true } })
  })
})

describe('Chromium snapshots', () => {
  test('preserves tree, group and selected tab; normalizes Brave new tabs', () => {
    const result = createSnapshot(
      [
        tab(1, 0, { url: 'brave://newtab/', pinned: true }),
        tab(2, 1, { groupId: 42, active: true }),
        tab(3, 2, { groupId: 42 }),
      ],
      [{ id: 42, title: 'Work', color: 'blue', collapsed: false }],
      {
        parents: { 3: 2 },
        folded: { 2: true },
      },
      { id: 'snapshot-1', name: 'Work', createdAt: 123 }
    )
    expect(result.tabs[0].url).toBe('chrome://newtab/')
    expect(result.tabs[2]).toMatchObject({ parent: 1, group: 0 })
    expect(result.tabs[1]).toMatchObject({ folded: true, active: true })
    expect(result.groups).toEqual([{ title: 'Work', color: 'blue', collapsed: false }])
  })

  test('rejects unsupported source pages instead of silently losing their URLs', () => {
    expect(() =>
      createSnapshot([tab(1, 0, { url: 'chrome://settings/' })], [], {}, { id: 'unsafe' })
    ).toThrow('1 tab(s) use unsupported URLs')
  })

  test.each([
    'javascript:alert(1)',
    'data:text/html,hello',
    'file:///etc/passwd',
    'chrome://settings/',
    'https://user:secret@example.com',
    'not a URL',
  ])('rejects unsafe URL %s', url => {
    expect(isSafeSnapshotUrl(url)).toBe(false)
    const snapshot = createSnapshot([tab(1, 0)], [], {}, { id: 'safe' })
    snapshot.tabs[0].url = url
    expect(() => validateSnapshot(snapshot)).toThrow('Invalid snapshot tab')
  })

  test('rejects malformed parents, split native groups, and excessive tab counts before restore', () => {
    const snapshot = createSnapshot([tab(1, 0), tab(2, 1), tab(3, 2)], [], {}, { id: 'safe' })
    snapshot.tabs[0].parent = 1
    expect(() => validateSnapshot(snapshot)).toThrow('Invalid snapshot tab')
    snapshot.tabs[0].parent = null
    snapshot.groups.push({ title: 'Group', color: 'blue', collapsed: false })
    snapshot.tabs[0].group = 0
    snapshot.tabs[2].group = 0
    expect(() => validateSnapshot(snapshot)).toThrow('Invalid group order')
    snapshot.tabs = Array.from({ length: 1001 }, () => snapshot.tabs[0])
    expect(() => validateSnapshot(snapshot)).toThrow('Invalid snapshot')
  })
})

function event() {
  const listeners = new Set<(...args: any[]) => any>()
  return {
    addListener: (listener: (...args: any[]) => any) => listeners.add(listener),
    removeListener: (listener: (...args: any[]) => any) => listeners.delete(listener),
    emit: (...args: any[]) => [...listeners].map(listener => listener(...args)),
    listeners,
  }
}

function storageArea(initial: Record<string, any> = {}) {
  const data = structuredClone(initial)
  return {
    data,
    get: vi.fn(async (key: string) => ({ [key]: structuredClone(data[key]) })),
    set: vi.fn(async (values: object) => Object.assign(data, structuredClone(values))),
  }
}

function mockChrome(initialTabs: ReturnType<typeof tab>[], metadata = {}) {
  let tabs: any[] = structuredClone(initialTabs)
  let nextTabId = Math.max(...tabs.map(tab => tab.id)) + 1
  let nextWindowId = 2
  let nextGroupId = 50
  const groups: any[] = []
  const reindex = () => {
    const indices: Record<number, number> = {}
    for (const tab of tabs) ((tab.index = indices[tab.windowId] ??= 0), indices[tab.windowId]++)
  }
  const api: any = {
    runtime: {
      id: 'test-extension',
      onMessage: event(),
      sendMessage: vi.fn(async () => {}),
      getURL: (path: string) => `chrome-extension://test/${path}`,
    },
    storage: { session: storageArea({ [TREE_STORAGE_KEY]: metadata }), local: storageArea() },
    tabs: {
      onCreated: event(),
      onUpdated: event(),
      onRemoved: event(),
      onMoved: event(),
      onAttached: event(),
      onDetached: event(),
      onActivated: event(),
      onReplaced: event(),
      query: vi.fn(async (query: any) =>
        structuredClone(
          tabs.filter(tab => query.windowId === undefined || tab.windowId === query.windowId)
        )
      ),
      get: vi.fn(async (id: number) => {
        const tab = tabs.find(tab => tab.id === id)
        if (!tab) throw new Error('No tab with id')
        return structuredClone(tab)
      }),
      create: vi.fn(async (properties: any) => {
        const inWindow = tabs.filter(tab => tab.windowId === properties.windowId)
        const created = tab(nextTabId++, properties.index ?? inWindow.length, properties)
        const next = inWindow[created.index]
        if (next) tabs.splice(tabs.indexOf(next), 0, created)
        else tabs.push(created)
        reindex()
        api.tabs.onCreated.emit(structuredClone(created))
        return structuredClone(created)
      }),
      duplicate: vi.fn(async (id: number) => {
        const source = tabs.find(tab => tab.id === id)
        if (!source) throw new Error('No tab with id')
        return api.tabs.create({
          windowId: source.windowId,
          url: source.url,
          active: false,
          index: source.index + 1,
          openerTabId: source.id,
        })
      }),
      update: vi.fn(async (id: number, properties: any) => {
        const tab = tabs.find(tab => tab.id === id)
        Object.assign(tab, properties)
        api.tabs.onUpdated.emit(id, properties, structuredClone(tab))
        return structuredClone(tab)
      }),
      move: vi.fn(async (id: number, properties: any) => {
        const from = tabs.findIndex(tab => tab.id === id)
        const [moving] = tabs.splice(from, 1)
        const oldWindowId = moving.windowId
        if (properties.windowId !== undefined && properties.windowId !== moving.windowId) {
          moving.windowId = properties.windowId
          moving.groupId = -1
          api.tabs.onDetached.emit(id, { oldWindowId })
          api.tabs.onAttached.emit(id, { newWindowId: moving.windowId })
        }
        const windowTabs = tabs.filter(tab => tab.windowId === moving.windowId)
        const target = properties.index < 0 ? undefined : windowTabs[properties.index]
        if (target) tabs.splice(tabs.indexOf(target), 0, moving)
        else tabs.push(moving)
        reindex()
        api.tabs.onMoved.emit(id, { windowId: moving.windowId })
        return structuredClone(moving)
      }),
      remove: vi.fn(async (ids: number | number[]) => {
        for (const id of Array.isArray(ids) ? ids : [ids]) {
          const removed = tabs.find(tab => tab.id === id)
          if (!removed) continue
          tabs = tabs.filter(tab => tab.id !== id)
          reindex()
          api.tabs.onRemoved.emit(id, { windowId: removed.windowId })
        }
      }),
      group: vi.fn(async ({ tabIds, groupId }: any) => {
        const id = groupId ?? nextGroupId++
        if (groupId === undefined)
          groups.push({
            id,
            windowId: tabs.find(tab => tab.id === tabIds[0]).windowId,
            title: '',
            color: 'grey',
            collapsed: false,
          })
        for (const tab of tabs.filter(tab => tabIds.includes(tab.id))) tab.groupId = id
        return id
      }),
      ungroup: vi.fn(async (ids: number[]) => {
        for (const tab of tabs) if (ids.includes(tab.id)) tab.groupId = -1
      }),
      discard: vi.fn(async (id: number) => {
        tabs.find(tab => tab.id === id).discarded = true
      }),
    },
    tabGroups: {
      onCreated: event(),
      onUpdated: event(),
      onRemoved: event(),
      onMoved: event(),
      query: vi.fn(async ({ windowId }: any) =>
        structuredClone(groups.filter(group => group.windowId === windowId))
      ),
      get: vi.fn(async (id: number) => structuredClone(groups.find(group => group.id === id))),
      update: vi.fn(async (id: number, properties: any) =>
        Object.assign(
          groups.find(group => group.id === id),
          properties
        )
      ),
    },
    windows: {
      onRemoved: event(),
      get: vi.fn(async (id: number) => ({ id, type: 'normal' })),
      getLastFocused: vi.fn(async () => ({ id: 1, type: 'normal' })),
      getAll: vi.fn(async ({ populate }: any = {}) =>
        [...new Set(tabs.map(tab => tab.windowId))].map(id => ({
          id,
          type: 'normal',
          ...(populate ? { tabs: structuredClone(tabs.filter(tab => tab.windowId === id)) } : {}),
        }))
      ),
      update: vi.fn(async () => {}),
      create: vi.fn(async (properties: any) => {
        const id = nextWindowId++
        if (properties.tabId !== undefined) {
          const moving = tabs.find(tab => tab.id === properties.tabId)
          if (!moving) throw new Error('No tab with id')
          const oldWindowId = moving.windowId
          moving.windowId = id
          moving.groupId = -1
          reindex()
          api.tabs.onDetached.emit(moving.id, { oldWindowId })
          api.tabs.onAttached.emit(moving.id, { newWindowId: id })
          return { id, type: properties.type ?? 'normal', tabs: [structuredClone(moving)] }
        }
        const tab = await api.tabs.create({ windowId: id, url: properties.url, active: true })
        return { id, type: properties.type ?? 'normal', tabs: [tab] }
      }),
    },
    commands: { onCommand: event() },
    action: { onClicked: event() },
    sidePanel: { open: vi.fn(async () => {}), setPanelBehavior: vi.fn(async () => {}) },
  }
  return api
}

describe('MV3 background lifecycle and operations', () => {
  test('remaps a replacement event on worker cold start before pruning missing IDs', async () => {
    const api = mockChrome([tab(1, 0), tab(20, 1), tab(3, 2)], {
      parents: { 2: 1, 3: 2 },
      folded: { 2: true },
    })
    const worker = createBackground(api)
    api.tabs.onReplaced.emit(20, 2)
    await worker.idle()
    const state = await worker.dispatch({ action: 'getState', windowId: 1 })
    expect(state.parents).toEqual({ 20: 1, 3: 20 })
    expect(state.folded).toEqual({ 20: true })
    worker.dispose()
  })

  test('preserves the hierarchy when Brave discard replaces a tab ID during an action', async () => {
    const api = mockChrome([tab(1, 0), tab(2, 1), tab(3, 2)], {
      parents: { 2: 1, 3: 2 },
      folded: { 2: true },
    })
    api.tabs.discard.mockImplementation(async () => {
      const tabs = [tab(1, 0), tab(20, 1, { discarded: true }), tab(3, 2)]
      api.tabs.query.mockImplementation(async () => structuredClone(tabs))
      api.tabs.onReplaced.emit(20, 2)
      return tabs[1]
    })
    const worker = createBackground(api)
    await worker.dispatch({ action: 'discard', tabId: 2 })
    await worker.idle()
    const state = await worker.dispatch({ action: 'getState', windowId: 1 })
    expect(state.parents).toEqual({ 20: 1, 3: 20 })
    expect(state.folded).toEqual({ 20: true })
    worker.dispose()
  })

  test('external activation unfolds ancestors without changing parent links', async () => {
    const api = mockChrome([tab(1, 0), tab(2, 1)], { parents: { 2: 1 }, folded: { 1: true } })
    const worker = createBackground(api)
    api.tabs.onActivated.emit({ tabId: 2, windowId: 1 })
    await worker.idle()
    const state = await worker.dispatch({ action: 'getState', windowId: 1 })
    expect(state.parents).toEqual({ 2: 1 })
    expect(state.folded).toEqual({})
    worker.dispose()
  })

  test('registers listeners immediately and recovers tree state across worker suspension', async () => {
    const api = mockChrome([tab(1, 0), tab(2, 1)], { parents: { 2: 1 }, folded: {} })
    const worker = createBackground(api)
    expect(api.runtime.onMessage.listeners.size).toBe(1)
    expect(api.tabs.onCreated.listeners.size).toBe(1)
    await worker.dispatch({ action: 'toggleFold', tabId: 1 })
    expect(api.storage.session.data[TREE_STORAGE_KEY]).toEqual({
      parents: { 2: 1 },
      folded: { 1: true },
    })
    worker.dispose()
    const awakened = createBackground(api)
    const state = await awakened.dispatch({ action: 'getState', windowId: 1 })
    expect(state.parents).toEqual({ 2: 1 })
    expect(state.folded).toEqual({ 1: true })
    expect(api.runtime.onMessage.listeners.size).toBe(1)
    awakened.dispose()
  })

  test('serializes branch moves with native tab events and persists the final hierarchy', async () => {
    const api = mockChrome(
      [1, 2, 3, 4].map((id, index) => tab(id, index)),
      { parents: { 2: 1, 3: 2 } }
    )
    const worker = createBackground(api)
    await worker.dispatch({ action: 'move', tabId: 2, targetId: 4, placement: 'inside' })
    await worker.idle()
    const state = await worker.dispatch({ action: 'getState', windowId: 1 })
    expect(state.tabs.map((tab: any) => tab.id)).toEqual([1, 4, 2, 3])
    expect(state.parents).toEqual({ 2: 4, 3: 2 })
    expect(api.storage.session.data[TREE_STORAGE_KEY].parents).toEqual({ 2: 4, 3: 2 })
    worker.dispose()
  })

  test('external closing reparents children and explicit closing removes only the selected tab', async () => {
    const api = mockChrome(
      [1, 2, 3, 4].map((id, index) => tab(id, index)),
      { parents: { 2: 1, 3: 2, 4: 3 } }
    )
    const worker = createBackground(api)
    await worker.ready
    await api.tabs.remove(2)
    await worker.idle()
    expect(api.storage.session.data[TREE_STORAGE_KEY].parents).toEqual({ 3: 1, 4: 3 })
    await worker.dispatch({ action: 'close', tabId: 3 })
    await worker.idle()
    expect(
      (await worker.dispatch({ action: 'getState', windowId: 1 })).tabs.map((tab: any) => tab.id)
    ).toEqual([1, 4])
    expect(api.storage.session.data[TREE_STORAGE_KEY].parents).toEqual({ 4: 1 })
    worker.dispose()
  })

  test('closing a folded parent removes every descendant from both the sidebar and browser', async () => {
    const api = mockChrome(
      [1, 2, 3, 4, 5].map((id, index) => tab(id, index)),
      { parents: { 2: 1, 3: 2, 4: 3, 5: 1 }, folded: { 2: true } }
    )
    const worker = createBackground(api)
    await worker.dispatch({ action: 'close', tabId: 2 })
    await worker.idle()
    const state = await worker.dispatch({ action: 'getState', windowId: 1 })
    expect(state.tabs.map((tab: any) => tab.id)).toEqual([1, 5])
    expect(state.parents).toEqual({ 5: 1 })
    expect(api.tabs.remove).toHaveBeenCalledWith([2, 3, 4])
    worker.dispose()
  })

  test('closing a folded parent from the native browser UI also removes its descendants', async () => {
    const api = mockChrome(
      [1, 2, 3, 4].map((id, index) => tab(id, index)),
      { parents: { 2: 1, 3: 2, 4: 3 }, folded: { 2: true } }
    )
    const worker = createBackground(api)
    await api.tabs.remove(2)
    await worker.idle()
    expect(
      (await worker.dispatch({ action: 'getState', windowId: 1 })).tabs.map((tab: any) => tab.id)
    ).toEqual([1])
    expect(api.tabs.remove).toHaveBeenCalledWith([3, 4])
    worker.dispose()
  })

  test('browser-created tabs become children of their opener', async () => {
    const api = mockChrome([tab(1, 0), tab(2, 1, { active: true })], { parents: { 2: 1 } })
    const worker = createBackground(api)
    const created = await api.tabs.create({ windowId: 1, openerTabId: 2, active: true })
    await worker.idle()
    const state = await worker.dispatch({ action: 'getState', windowId: 1 })
    expect(state.parents).toEqual({ 2: 1, [created.id]: 2 })
    worker.dispose()
  })

  test('keeps opener-less external tabs at the end as root tabs', async () => {
    const api = mockChrome([tab(1, 0), tab(2, 1, { active: true })], { parents: { 2: 1 } })
    const worker = createBackground(api)
    const created = await api.tabs.create({ windowId: 1, index: 1, active: true })
    await worker.idle()
    const state = await worker.dispatch({ action: 'getState', windowId: 1 })
    expect(state.tabs.map((tab: any) => tab.id)).toEqual([1, 2, created.id])
    expect(state.parents).toEqual({ 2: 1 })
    expect(api.tabs.move).toHaveBeenCalledWith(created.id, { index: -1 })
    worker.dispose()
  })

  test('copies a tab into its branch and can move the tab into another browser window', async () => {
    const api = mockChrome([tab(1, 0, { active: true }), tab(2, 0, { windowId: 2, active: true })])
    const worker = createBackground(api)
    const copy = await worker.dispatch({ action: 'duplicate', tabId: 1 })
    await worker.idle()
    expect(copy.id).toBe(3)
    expect((await worker.dispatch({ action: 'getState', windowId: 1 })).parents).toEqual({ 3: 1 })
    await expect(worker.dispatch({ action: 'getWindows', windowId: 1 })).resolves.toEqual([
      { id: 2, title: 'Tab 2', tabCount: 1 },
    ])

    await worker.dispatch({ action: 'moveToWindow', tabId: 1, targetWindowId: 2 })
    await worker.idle()
    expect(
      (await worker.dispatch({ action: 'getState', windowId: 2 })).tabs.map((tab: any) => tab.id)
    ).toEqual([2, 1])
    expect((await worker.dispatch({ action: 'getState', windowId: 2 })).parents).toEqual({})
    expect(api.tabs.move).toHaveBeenCalledWith(1, { windowId: 2, index: -1 })
    worker.dispose()
  })

  test('saves native groups and restores a snapshot into a new window with remapped IDs', async () => {
    const api = mockChrome([tab(1, 0), tab(2, 1)], { parents: { 2: 1 }, folded: { 1: true } })
    const worker = createBackground(api)
    await worker.dispatch({ action: 'group', tabIds: [1, 2], title: 'Work', color: 'blue' })
    const snapshot = await worker.dispatch({
      action: 'saveSnapshot',
      windowId: 1,
      name: 'Saved work',
    })
    expect(snapshot.tabs[1].parent).toBe(0)
    const restored = await worker.dispatch({ action: 'restoreSnapshot', snapshotId: snapshot.id })
    await worker.idle()
    expect(restored).toEqual({ windowId: 2, tabCount: 2 })
    const state = await worker.dispatch({ action: 'getState', windowId: 2 })
    expect(state.parents).toEqual({ [state.tabs[1].id]: state.tabs[0].id })
    expect(state.groups).toHaveLength(1)
    expect(state.groups[0]).toMatchObject({ title: 'Work', color: 'blue' })
    expect((await worker.dispatch({ action: 'getState', windowId: 1 })).tabs).toHaveLength(2)
    worker.dispose()
  })

  test('caps saved snapshots and refuses tampered unsafe data without opening a window', async () => {
    const api = mockChrome([tab(1, 0)])
    const worker = createBackground(api)
    for (let index = 0; index < 22; index++)
      await worker.dispatch({ action: 'saveSnapshot', windowId: 1, name: `Snapshot ${index}` })
    const snapshots = await worker.dispatch({ action: 'getSnapshots' })
    expect(snapshots).toHaveLength(20)
    expect(snapshots[0].name).toBe('Snapshot 21')
    api.storage.local.data[SNAPSHOT_STORAGE_KEY][0].tabs[0].url = 'javascript:alert(1)'
    await expect(
      worker.dispatch({ action: 'restoreSnapshot', snapshotId: snapshots[0].id })
    ).rejects.toThrow('Snapshot not found')
    expect(api.windows.create).not.toHaveBeenCalled()
    worker.dispose()
  })

  test('responds to runtime messages with the stable envelope and keeps a failed action out of the queue', async () => {
    const api = mockChrome([tab(1, 0)])
    const worker = createBackground(api)
    const response = vi.fn()
    expect(
      api.runtime.onMessage.emit(
        { type: 'sidebery', action: 'close', tabId: -1 },
        { id: api.runtime.id },
        response
      )
    ).toEqual([true])
    await worker.idle()
    await Promise.resolve()
    expect(response).toHaveBeenCalledWith({ ok: false, error: 'Invalid tab ID' })
    expect((await worker.dispatch({ action: 'getState', windowId: 1 })).tabs).toHaveLength(1)
    worker.dispose()
  })

  test('opens a separate popup for browsers without the sidePanel API', async () => {
    const api = mockChrome([tab(1, 0)])
    delete api.sidePanel
    const worker = createBackground(api)
    const state = await worker.dispatch({ action: 'getState', windowId: 1 })
    expect(state.sidePanelSupported).toBe(false)
    api.action.onClicked.emit({ windowId: 1 })
    await vi.waitFor(() =>
      expect(api.windows.create).toHaveBeenCalledWith({
        url: 'chrome-extension://test/sidebar.html?windowId=1',
        type: 'popup',
        width: 420,
        height: 800,
      })
    )
    worker.dispose()
  })
})
