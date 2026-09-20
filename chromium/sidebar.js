const $ = selector => document.querySelector(selector)
const colors = {
  grey: '#697b81',
  blue: '#286de9',
  red: '#d93945',
  yellow: '#9b7700',
  green: '#248652',
  pink: '#df2396',
  purple: '#a13bbb',
  cyan: '#147f91',
  orange: '#b35c13',
}
let state = { tabs: [], groups: [], parents: {}, folded: {} }
let windowId
let selected = new Set()
let anchorId
let visibleTabs = []
let dragIds = []
let refreshTimer
let refreshVersion = 0
let editingGroup
let groupTabIds = []
let customStyle
let childrenByParent = new Map()

function el(tag, className, text) {
  const node = document.createElement(tag)
  if (className) node.className = className
  if (text !== undefined) node.textContent = text
  return node
}
function button(text, label, handler, className = 'icon-btn') {
  const node = el('button', className, text)
  node.type = 'button'
  node.title = label
  node.setAttribute('aria-label', label)
  node.addEventListener('click', event => {
    event.stopPropagation()
    run(() => handler(event))
  })
  return node
}
function showError(error) {
  const dialog = document.querySelector('dialog[open]')
  if (dialog) {
    let notice = dialog.querySelector('.dialog-error')
    if (!notice) {
      notice = el('p', 'dialog-error')
      notice.setAttribute('role', 'alert')
      dialog.append(notice)
    }
    notice.textContent = error?.message || String(error)
    return
  }
  $('#error span').textContent = error?.message || String(error)
  $('#error').hidden = false
}
async function run(fn) {
  try {
    await fn()
  } catch (error) {
    showError(error)
  }
}
async function request(action, args = {}) {
  const response = await chrome.runtime.sendMessage({ type: 'sidebery', action, windowId, ...args })
  if (!response?.ok) throw new Error(response?.error || '后台未响应，请重新打开侧边栏。')
  return response.data
}
async function mutate(action, args) {
  const result = await request(action, args)
  await refresh()
  return result
}
async function refresh() {
  if (windowId === undefined) return
  const version = ++refreshVersion
  const next = await request('getState')
  if (version !== refreshVersion) return
  state = next
  state.parents ||= {}
  state.folded ||= {}
  selected = new Set([...selected].filter(id => state.tabs.some(tab => tab.id === id)))
  $('#compatibility').hidden = state.sidePanelSupported !== false
  render()
}
function scheduleRefresh() {
  clearTimeout(refreshTimer)
  refreshTimer = setTimeout(() => run(refresh), 70)
}
function descendants(id) {
  const found = new Set()
  let next = [id]
  while (next.length) {
    const parent = next.pop()
    for (const child of childrenByParent.get(parent) || []) {
      if (!found.has(child)) {
        found.add(child)
        next.push(child)
      }
    }
  }
  return found
}
function level(tab) {
  const seen = new Set([tab.id])
  let parent = state.parents[tab.id]
  let depth = 0
  while (parent !== undefined && !seen.has(Number(parent))) {
    seen.add(Number(parent))
    depth++
    parent = state.parents[parent]
  }
  return Math.min(depth, 12)
}
function isHidden(tab) {
  const seen = new Set([tab.id])
  let parent = state.parents[tab.id]
  while (parent !== undefined && !seen.has(Number(parent))) {
    if (state.folded[parent]) return true
    seen.add(Number(parent))
    parent = state.parents[parent]
  }
  return false
}
function selectTab(tab, event) {
  if (event.shiftKey && anchorId !== undefined) {
    const from = visibleTabs.findIndex(t => t.id === anchorId)
    const to = visibleTabs.findIndex(t => t.id === tab.id)
    if (from >= 0 && to >= 0)
      for (const t of visibleTabs.slice(Math.min(from, to), Math.max(from, to) + 1))
        selected.add(t.id)
    render()
  } else if (event.metaKey || event.ctrlKey) {
    if (selected.has(tab.id)) selected.delete(tab.id)
    else selected.add(tab.id)
    anchorId = tab.id
    render()
  } else {
    selected.clear()
    anchorId = tab.id
    run(() => mutate('activate', { tabId: tab.id }))
  }
}
function createTabRow(tab) {
  const row = el('div', 'Tab')
  row.dataset.id = tab.id
  row.dataset.active = !!tab.active
  row.dataset.discarded = !!tab.discarded
  row.dataset.selected = selected.has(tab.id)
  row.setAttribute('role', 'listitem')
  row.setAttribute('aria-label', `${tab.title || '新标签页'}${tab.active ? '，当前标签' : ''}`)
  row.tabIndex = 0
  row.draggable = true
  row.title = `${tab.title || ''}\n${tab.url || ''}`
  const body = el('div', 'body')
  body.style.setProperty('--level', level(tab))
  const children = descendants(tab.id)
  row.dataset.parent = String(children.size > 0 && !tab.pinned)
  const iconBox = el('span', 'tab-icon')
  let favicon
  // Only display browser-supplied raster/HTTP icons; never interpolate tab titles as HTML.
  if (tab.favIconUrl && /^(https?:|data:image\/|chrome-extension:)/i.test(tab.favIconUrl)) {
    favicon = el('img', 'favicon')
    favicon.src = tab.favIconUrl
    favicon.referrerPolicy = 'no-referrer'
    favicon.alt = ''
    favicon.draggable = false
    favicon.addEventListener(
      'error',
      () => favicon.replaceWith(el('span', 'favicon favicon-fallback', '◇')),
      { once: true }
    )
  } else favicon = el('span', 'favicon favicon-fallback', tab.pinned ? '◆' : '◇')
  iconBox.append(favicon)
  if (children.size && !tab.pinned) {
    iconBox.append(
      button(
        state.folded[tab.id] ? '▶' : '▼',
        '折叠或展开子标签',
        () => mutate('toggleFold', { tabId: tab.id }),
        'fold'
      )
    )
    if (state.folded[tab.id]) iconBox.append(el('span', 'desc-count', children.size))
  }
  body.append(iconBox)
  if (!tab.pinned) {
    body.append(el('span', 'title', tab.title || '新标签页'))
    if (tab.audible || tab.mutedInfo?.muted)
      body.append(
        button(
          tab.mutedInfo?.muted ? '静音' : '声音',
          tab.mutedInfo?.muted ? '取消静音' : '静音',
          () => mutate('mute', { tabId: tab.id, muted: !tab.mutedInfo?.muted }),
          'audio'
        )
      )
    body.append(button('×', '关闭标签页', () => mutate('close', { tabId: tab.id }), 'close'))
  }
  row.append(body)
  row.addEventListener('click', event => selectTab(tab, event))
  row.addEventListener('auxclick', event => {
    if (event.button === 1) {
      event.preventDefault()
      run(() => mutate('close', { tabId: tab.id }))
    }
  })
  row.addEventListener('contextmenu', event => {
    event.preventDefault()
    openMenu(tab, event.clientX, event.clientY)
  })
  row.addEventListener('keydown', event => onTabKey(event, tab))
  row.addEventListener('dragstart', event => {
    dragIds =
      selected.size > 1 && selected.has(tab.id)
        ? state.tabs.filter(item => selected.has(item.id)).map(item => item.id)
        : [tab.id]
    event.dataTransfer.effectAllowed = 'move'
    event.dataTransfer.setData('text/plain', dragIds.join(','))
    $('#context-menu').hidden = true
  })
  row.addEventListener('dragover', event => {
    if (!dragIds.length || dragIds.includes(tab.id)) return
    event.preventDefault()
    const rect = row.getBoundingClientRect()
    const fraction = (event.clientY - rect.top) / rect.height
    row.dataset.drop =
      dragIds.length > 1
        ? 'inside'
        : fraction < 0.25
          ? 'before'
          : fraction > 0.75
            ? 'after'
            : 'inside'
  })
  row.addEventListener('dragleave', event => {
    if (!row.contains(event.relatedTarget)) delete row.dataset.drop
  })
  row.addEventListener('drop', event => {
    event.preventDefault()
    const placement = row.dataset.drop
    delete row.dataset.drop
    if (dragIds.length && placement)
      run(() =>
        dragIds.length > 1
          ? mutate('moveMany', { tabIds: [...dragIds], targetId: tab.id })
          : mutate('move', { tabId: dragIds[0], targetId: tab.id, placement })
      )
  })
  row.addEventListener('dragend', () => {
    dragIds = []
    document.querySelectorAll('[data-drop]').forEach(node => delete node.dataset.drop)
  })
  return row
}
function onTabKey(event, tab) {
  if (event.target !== event.currentTarget) return
  const rows = [...$('#tabs').querySelectorAll('.Tab')]
  const index = rows.indexOf(event.currentTarget)
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    rows[
      Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))
    ]?.focus()
  } else if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault()
    selectTab(tab, event)
  } else if (event.key === 'Delete') {
    event.preventDefault()
    run(() => mutate('close', { tabId: tab.id }))
  } else if (
    (event.key === 'ArrowLeft' && !state.folded[tab.id]) ||
    (event.key === 'ArrowRight' && state.folded[tab.id])
  ) {
    if (descendants(tab.id).size) {
      event.preventDefault()
      run(() => mutate('toggleFold', { tabId: tab.id }))
    }
  } else if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
    event.preventDefault()
    const rect = event.currentTarget.getBoundingClientRect()
    openMenu(tab, rect.left + 12, rect.bottom)
  }
}
function createGroup(group, tabs) {
  const section = el('section', 'group')
  section.style.setProperty('--group-color', colors[group.color] || colors.grey)
  const header = el('div', 'group-header')
  const chip = button(
    '',
    `${group.collapsed ? '展开' : '折叠'}分组 ${group.title || '未命名'}`,
    () => mutate('updateGroup', { groupId: group.id, collapsed: !group.collapsed }),
    'group-chip'
  )
  chip.setAttribute('aria-expanded', String(!group.collapsed))
  chip.append(
    el('span', '', group.collapsed ? '▶' : '▼'),
    el('span', 'group-label', group.title || '未命名'),
    el('span', 'group-count', tabs.length)
  )
  header.append(
    chip,
    el('div', 'spacer'),
    button('+', '在分组中新建标签', () => mutate('create', { groupId: group.id })),
    button('✎', '编辑分组', () => showGroupDialog(group))
  )
  section.append(header)
  const content = el('div', 'group-tabs')
  content.setAttribute('role', 'list')
  if (!group.collapsed)
    for (const tab of tabs) {
      if (isHidden(tab)) continue
      visibleTabs.push(tab)
      content.append(createTabRow(tab))
    }
  section.append(content)
  return section
}
function render() {
  childrenByParent = new Map()
  for (const [child, parent] of Object.entries(state.parents)) {
    if (!childrenByParent.has(parent)) childrenByParent.set(parent, [])
    childrenByParent.get(parent).push(Number(child))
  }
  const focused = document.activeElement?.closest('.Tab')?.dataset.id
  const tabs = state.tabs
  const fragment = document.createDocumentFragment()
  visibleTabs = []
  const pinned = tabs.filter(t => t.pinned)
  if (pinned.length) {
    const bar = el('div', 'pinned')
    bar.setAttribute('role', 'list')
    bar.setAttribute('aria-label', '固定标签')
    for (const tab of pinned) {
      visibleTabs.push(tab)
      bar.append(createTabRow(tab))
    }
    fragment.append(bar)
  }
  const renderedGroups = new Set()
  for (const tab of tabs.filter(t => !t.pinned)) {
    const group = state.groups.find(group => group.id === tab.groupId)
    if (group) {
      if (!renderedGroups.has(group.id)) {
        fragment.append(
          createGroup(
            group,
            tabs.filter(t => t.groupId === group.id)
          )
        )
        renderedGroups.add(group.id)
      }
    } else if (!isHidden(tab)) {
      visibleTabs.push(tab)
      fragment.append(createTabRow(tab))
    }
  }
  if (!tabs.length) fragment.append(el('p', 'empty', '窗口中还没有标签页'))
  $('#tabs').replaceChildren(fragment)
  if (focused)
    $('#tabs')
      .querySelector(`[data-id="${Number(focused)}"]`)
      ?.focus({ preventScroll: true })
  $('#selection-bar').hidden = !selected.size
  $('#selection-count').textContent = `已选 ${selected.size} 项`
}
function showGroupDialog(group, ids = [...selected]) {
  $('#group-dialog .dialog-error')?.remove()
  editingGroup = group
  groupTabIds = ids
  $('#group-dialog-title').textContent = group ? '编辑分组' : '新建分组'
  $('#group-name').value = group?.title || ''
  $('#group-color').value = group?.color || 'blue'
  $('#group-dialog').showModal()
  $('#group-name').focus()
}
function positionMenu(menu, x, y) {
  menu.style.left = `${Math.max(4, Math.min(x, innerWidth - menu.offsetWidth - 4))}px`
  menu.style.top = `${Math.max(4, Math.min(y, innerHeight - menu.offsetHeight - 4))}px`
}
function addMenuItem(menu, label, action, options = {}) {
  const item = button(
    label,
    options.title || label,
    action,
    `menu-item${options.className ? ` ${options.className}` : ''}`
  )
  item.setAttribute('role', 'menuitem')
  if (options.detail) item.append(el('span', 'menu-detail', options.detail))
  if (options.trailing) item.append(el('span', 'menu-trailing', options.trailing))
  menu.append(item)
  return item
}
function addMenuSeparator(menu) {
  const separator = el('div', 'menu-separator')
  separator.setAttribute('role', 'separator')
  menu.append(separator)
}
function openWindowMenu(tab, x, y) {
  const menu = $('#context-menu')
  menu.replaceChildren()
  addMenuItem(menu, '‹ 返回标签操作', () => openMenu(tab, x, y))
  addMenuSeparator(menu)
  addMenuItem(
    menu,
    '移到新窗口',
    () => {
      menu.hidden = true
      return mutate('moveToNewWindow', { tabId: tab.id })
    },
    { detail: '将这个标签单独放到一个窗口' }
  )
  const loading = el('p', 'menu-status', '正在读取其他窗口…')
  menu.append(loading)
  menu.hidden = false
  positionMenu(menu, x, y)
  request('getWindows')
    .then(windows => {
      if (menu.dataset.tabId !== String(tab.id)) return
      loading.remove()
      if (!windows.length) {
        menu.append(el('p', 'menu-status', '没有其他可用窗口'))
      } else {
        addMenuSeparator(menu)
        for (const target of windows)
          addMenuItem(
            menu,
            target.title,
            () => {
              menu.hidden = true
              return mutate('moveToWindow', { tabId: tab.id, targetWindowId: target.id })
            },
            { detail: `${target.tabCount} 个标签页` }
          )
      }
      positionMenu(menu, x, y)
    })
    .catch(showError)
}
function openMenu(tab, x, y) {
  const menu = $('#context-menu')
  menu.dataset.tabId = String(tab.id)
  menu.replaceChildren()
  const closeMenuThen = action => () => {
    menu.hidden = true
    return action()
  }
  addMenuItem(
    menu,
    '新建子标签',
    closeMenuThen(() => mutate('create', { parentId: tab.id }))
  )
  addMenuSeparator(menu)
  addMenuItem(
    menu,
    '复制当前标签',
    closeMenuThen(() => mutate('duplicate', { tabId: tab.id }))
  )
  addMenuItem(menu, '移动到另一个窗口', () => openWindowMenu(tab, x, y), { trailing: '›' })
  addMenuSeparator(menu)
  addMenuItem(
    menu,
    tab.pinned ? '取消固定' : '固定标签',
    closeMenuThen(() => mutate('pin', { tabId: tab.id, pinned: !tab.pinned }))
  )
  addMenuItem(
    menu,
    tab.mutedInfo?.muted ? '取消静音' : '静音',
    closeMenuThen(() => mutate('mute', { tabId: tab.id, muted: !tab.mutedInfo?.muted }))
  )
  addMenuItem(
    menu,
    '休眠标签',
    closeMenuThen(() => mutate('discard', { tabId: tab.id }))
  )
  addMenuSeparator(menu)
  addMenuItem(
    menu,
    '新建分组…',
    closeMenuThen(() => showGroupDialog(undefined, selected.has(tab.id) ? [...selected] : [tab.id]))
  )
  if (tab.groupId >= 0)
    addMenuItem(
      menu,
      '移出分组',
      closeMenuThen(() => mutate('ungroup', { tabIds: [tab.id] }))
    )
  addMenuSeparator(menu)
  addMenuItem(
    menu,
    '关闭标签',
    closeMenuThen(() => mutate('close', { tabId: tab.id })),
    {
      className: 'danger',
    }
  )
  menu.hidden = false
  positionMenu(menu, x, y)
  menu.firstElementChild.focus()
}
async function renderSnapshots() {
  $('#snapshots-dialog .dialog-error')?.remove()
  const snapshots = await request('getSnapshots')
  const list = $('#snapshots-list')
  list.replaceChildren()
  if (!snapshots.length) list.append(el('p', 'muted', '还没有快照'))
  for (const snapshot of snapshots) {
    const item = el('div', 'snapshot')
    item.append(
      el('strong', '', snapshot.name || new Date(snapshot.createdAt).toLocaleString()),
      el(
        'span',
        'muted',
        `${snapshot.tabs.length} 个标签 · ${new Date(snapshot.createdAt).toLocaleString()}`
      )
    )
    item.append(
      button(
        '恢复到新窗口',
        '恢复到新窗口',
        async () => {
          await request('restoreSnapshot', { snapshotId: snapshot.id })
          $('#snapshots-dialog').close()
        },
        ''
      )
    )
    item.append(
      button(
        '删除',
        '删除快照',
        async () => {
          if (!confirm('删除这份快照？已打开的标签不会受影响。')) return
          await request('deleteSnapshot', { snapshotId: snapshot.id })
          await renderSnapshots()
        },
        ''
      )
    )
    list.append(item)
  }
}
function applySettings(settings = {}) {
  document.documentElement.dataset.theme = settings.theme === 'dark' ? 'dark' : 'blue-grey'
  document.documentElement.dataset.density = ['compact', 'comfortable'].includes(settings.density)
    ? settings.density
    : 'default'
  if (!customStyle) {
    customStyle = el('style')
    document.head.append(customStyle)
  }
  customStyle.textContent = typeof settings.customCSS === 'string' ? settings.customCSS : ''
}

$('#new-tab').addEventListener('click', () => run(() => mutate('create')))
$('#fold-other-trees').addEventListener('click', () => run(() => mutate('foldOtherTrees')))
$('#dismiss-error').addEventListener('click', () => {
  $('#error').hidden = true
})
$('#clear-selection').addEventListener('click', () => {
  selected.clear()
  render()
})
$('#group-btn').addEventListener('click', () => showGroupDialog())
$('#ungroup-btn').addEventListener('click', () =>
  run(() => mutate('ungroup', { tabIds: [...selected] }))
)
$('#cancel-group').addEventListener('click', () => $('#group-dialog').close())
$('#group-form').addEventListener('submit', event => {
  event.preventDefault()
  run(async () => {
    const submit = $('#group-form button[type="submit"]')
    submit.disabled = true
    try {
      const args = {
        title: $('#group-name').value.trim() || '未命名',
        color: $('#group-color').value,
      }
      if (editingGroup) await mutate('updateGroup', { ...args, groupId: editingGroup.id })
      else await mutate('group', { ...args, tabIds: groupTabIds })
      selected.clear()
      $('#group-dialog').close()
      render()
    } finally {
      submit.disabled = false
    }
  })
})
$('#save-snapshot').addEventListener('click', () =>
  run(async () => {
    $('#save-snapshot').disabled = true
    try {
      await request('saveSnapshot')
      await renderSnapshots()
    } finally {
      $('#save-snapshot').disabled = false
    }
  })
)
$('#close-snapshots').addEventListener('click', () => $('#snapshots-dialog').close())
$('#help-btn').addEventListener('click', () => $('#help-dialog').showModal())
$('#close-help').addEventListener('click', () => $('#help-dialog').close())
document.addEventListener('click', event => {
  if (!$('#context-menu').contains(event.target)) $('#context-menu').hidden = true
})
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    if (document.querySelector('dialog[open]')) return
    if (!$('#context-menu').hidden) {
      $('#context-menu').hidden = true
      return
    }
    selected.clear()
    render()
  }
})
$('#context-menu').addEventListener('keydown', event => {
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return
  event.preventDefault()
  const items = [...$('#context-menu').querySelectorAll('button')]
  const index = items.indexOf(document.activeElement)
  items[(index + (event.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus()
})
chrome.runtime.onMessage.addListener(message => {
  if (message.type === 'sidebery:changed' && (!message.windowId || message.windowId === windowId))
    scheduleRefresh()
})
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.chromiumSettings) applySettings(changes.chromiumSettings.newValue)
})
run(async () => {
  const id = new URLSearchParams(location.search).get('windowId')
  windowId = id !== null && /^\d+$/.test(id) ? Number(id) : (await chrome.windows.getCurrent()).id
  const stored = await chrome.storage.local.get('chromiumSettings')
  applySettings(stored.chromiumSettings)
  await refresh()
  $('#tabs .Tab[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
})
