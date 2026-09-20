import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { JSDOM } from 'jsdom'

const html = readFileSync(new URL('../chromium/sidebar.html', import.meta.url), 'utf8')
const script = readFileSync(new URL('../chromium/sidebar.js', import.meta.url), 'utf8')
const windows: JSDOM[] = []
afterEach(() => {
  for (const dom of windows.splice(0)) dom.window.close()
})

async function setup() {
  const dom = new JSDOM(html, {
    url: 'chrome-extension://test/sidebar.html',
    runScripts: 'outside-only',
  })
  windows.push(dom)
  const window = dom.window as any
  window.HTMLElement.prototype.scrollIntoView = vi.fn()
  window.HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '')
  }
  window.HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open')
  }
  const state = {
    windowId: 1,
    sidePanelSupported: true,
    groups: [],
    tabs: [
      {
        id: 1,
        index: 0,
        windowId: 1,
        groupId: -1,
        title: '<img src=x onerror=alert(1)>',
        url: 'https://example.org',
        active: true,
        pinned: false,
      },
      {
        id: 2,
        index: 1,
        windowId: 1,
        groupId: -1,
        title: 'Hidden child',
        url: 'https://example.org/child',
        active: false,
        pinned: false,
      },
      {
        id: 3,
        index: 2,
        windowId: 1,
        groupId: -1,
        title: 'Independent',
        url: 'https://other.org',
        active: false,
        pinned: false,
      },
      {
        id: 4,
        index: 3,
        windowId: 1,
        groupId: -1,
        title: 'Drop target',
        url: 'https://target.example.org',
        active: false,
        pinned: false,
      },
    ],
    parents: { 2: 1 },
    folded: { 1: true },
  }
  let changeListener: any
  const send = vi.fn(async (message: any) => ({
    ok: true,
    data:
      message.action === 'getState'
        ? structuredClone(state)
        : message.action === 'getWindows'
          ? [{ id: 2, title: '另一个工作窗口', tabCount: 8 }]
          : null,
  }))
  window.chrome = {
    runtime: { sendMessage: send, openOptionsPage: vi.fn(), onMessage: { addListener: vi.fn() } },
    windows: { getCurrent: async () => ({ id: 1 }) },
    storage: {
      local: { get: async () => ({}) },
      onChanged: {
        addListener: (callback: any) => {
          changeListener = callback
        },
      },
    },
  }
  window.eval(script)
  await vi.waitFor(() => expect(window.document.querySelectorAll('.Tab').length).toBe(3))
  return {
    window,
    document: window.document,
    send,
    change: (changes: any) => changeListener(changes, 'local'),
  }
}

describe('Chromium sidebar interaction', () => {
  test('renders only the tab list and keeps folded descendants out of view', async () => {
    const { document } = await setup()
    expect(document.querySelector('.title').textContent).toBe('<img src=x onerror=alert(1)>')
    expect(document.querySelector('.title img')).toBeNull()
    expect(document.querySelector('.toolbar')).toBeNull()
    expect(document.querySelector('.search-box')).toBeNull()
    expect(document.querySelector('.top-actions')).toBeNull()
    expect(document.querySelector('footer #fold-other-trees')).not.toBeNull()
    expect(document.querySelector('main + footer')).not.toBeNull()
    expect([...document.querySelectorAll('.Tab')].map((node: any) => node.dataset.id)).toEqual([
      '1',
      '3',
      '4',
    ])
  })

  test('close and fold buttons never bubble into tab activation', async () => {
    const { document, send } = await setup()
    send.mockClear()
    document.querySelector('.close').click()
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: 'close', tabId: 1 }))
    )
    expect(send.mock.calls.some(([message]) => message.action === 'activate')).toBe(false)
    document.querySelector('.fold').click()
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: 'toggleFold', tabId: 1 }))
    )
    expect(send.mock.calls.some(([message]) => message.action === 'activate')).toBe(false)
  })

  test('top action folds every tree except the active tab tree', async () => {
    const { document, send } = await setup()
    send.mockClear()
    document.querySelector('#fold-other-trees').click()
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: 'foldOtherTrees' }))
    )
  })

  test('overlays a parent fold arrow on its favicon while preserving a larger child indent', async () => {
    const { document } = await setup()
    const parent = document.querySelector('[data-id="1"]')
    const fold = parent.querySelector('.fold')
    expect(parent.dataset.parent).toBe('true')
    expect(parent.querySelector('.tab-icon > .fold')).toBe(fold)
    expect(parent.querySelector('.tab-icon > .favicon')).not.toBeNull()
    expect(parent.querySelector('.tab-icon > .desc-count')?.textContent).toBe('1')
    expect(parent.querySelector('.body > .desc-count')).toBeNull()

    const stylesheet = document.querySelector('link[href="sidebar.css"]')
    expect(stylesheet).not.toBeNull()
    const css = readFileSync(new URL('../chromium/sidebar.css', import.meta.url), 'utf8')
    expect(css).toContain('--frame-bg: #effffd')
    expect(css).toContain('--active-bg: #a5dcda')
    expect(css).toContain('--row-height: 32px')
    expect(css).toContain('font-size: 15px')
    expect(css).toContain('flex: 0 0 auto')
    expect(css).toContain('margin: 1px 0')
    expect(css).toContain('--tree-indent: 26px')
    expect(css).toContain('.tab-icon:hover .fold')
    expect(css).toContain('pointer-events: none')
  })

  test('Ctrl selection groups the chosen tabs, with a visible save result', async () => {
    const { window, document, send } = await setup()
    for (const id of [1, 3])
      document
        .querySelector(`[data-id="${id}"]`)
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true, ctrlKey: true }))
    expect(document.querySelector('#selection-count').textContent).toBe('已选 2 项')
    document.querySelector('#group-btn').click()
    document.querySelector('#group-name').value = 'Work'
    document
      .querySelector('#group-form')
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'group', tabIds: [1, 3], title: 'Work', color: 'blue' })
      )
    )
    await vi.waitFor(() =>
      expect(document.querySelector('#group-dialog').hasAttribute('open')).toBe(false)
    )
  })

  test('dragging multiple selected tabs onto a target makes them direct children', async () => {
    const { window, document, send } = await setup()
    for (const id of [1, 3])
      document
        .querySelector(`[data-id="${id}"]`)
        .dispatchEvent(new window.MouseEvent('click', { bubbles: true, ctrlKey: true }))
    send.mockClear()
    const source = document.querySelector('[data-id="1"]')
    const target = document.querySelector('[data-id="4"]')
    const dataTransfer = { effectAllowed: '', setData: vi.fn() }
    const dragStart = new window.Event('dragstart', { bubbles: true, cancelable: true })
    Object.defineProperty(dragStart, 'dataTransfer', { value: dataTransfer })
    source.dispatchEvent(dragStart)
    target.dispatchEvent(
      new window.MouseEvent('dragover', { bubbles: true, cancelable: true, clientY: 10 })
    )
    target.dispatchEvent(new window.Event('drop', { bubbles: true, cancelable: true }))
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'moveMany', tabIds: [1, 3], targetId: 4 })
      )
    )
  })

  test('updates theme and custom CSS when settings change', async () => {
    const { document, change } = await setup()
    change({
      chromiumSettings: {
        newValue: { theme: 'dark', density: 'compact', customCSS: '.Tab { color: pink; }' },
      },
    })
    expect(document.documentElement.dataset.theme).toBe('dark')
    expect(document.documentElement.dataset.density).toBe('compact')
    expect(document.head.querySelector('style').textContent).toBe('.Tab { color: pink; }')
  })

  test('shows failed operations inside the open dialog', async () => {
    const { window, document, send } = await setup()
    document
      .querySelector('[data-id="1"]')
      .dispatchEvent(new window.MouseEvent('click', { bubbles: true, ctrlKey: true }))
    document.querySelector('#group-btn').click()
    send.mockResolvedValueOnce({ ok: false, error: 'Tab closed during the operation' } as any)
    document.querySelector('#group-name').value = 'Work'
    document
      .querySelector('#group-form')
      .dispatchEvent(new window.Event('submit', { cancelable: true }))
    await vi.waitFor(() =>
      expect(document.querySelector('#group-dialog .dialog-error')?.textContent).toBe(
        'Tab closed during the operation'
      )
    )
    expect(document.querySelector('#group-form button[type="submit"]').disabled).toBe(false)
  })

  test('offers tab copying and a concise move-to-window submenu', async () => {
    const { window, document, send } = await setup()
    const tab = document.querySelector('[data-id="1"]')
    tab.dispatchEvent(
      new window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 })
    )
    expect(document.querySelector('#context-menu').textContent).toContain('复制当前标签')
    expect(document.querySelector('#context-menu').textContent).toContain('移动到另一个窗口')
    ;[...document.querySelectorAll('#context-menu button')]
      .find((item: any) => item.textContent === '复制当前标签')
      .click()
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(expect.objectContaining({ action: 'duplicate', tabId: 1 }))
    )

    tab.dispatchEvent(
      new window.MouseEvent('contextmenu', { bubbles: true, clientX: 40, clientY: 40 })
    )
    ;[...document.querySelectorAll('#context-menu button')]
      .find((item: any) => item.textContent === '移动到另一个窗口›')
      .click()
    await vi.waitFor(() =>
      expect(document.querySelector('#context-menu').textContent).toContain('另一个工作窗口')
    )
    expect(document.querySelector('#context-menu').textContent).toContain('8 个标签页')
    ;[...document.querySelectorAll('#context-menu button')]
      .find((item: any) => item.textContent.includes('另一个工作窗口'))
      .click()
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'moveToWindow', tabId: 1, targetWindowId: 2 })
      )
    )
  })
})
