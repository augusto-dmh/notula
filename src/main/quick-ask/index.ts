// SPDX-License-Identifier: Apache-2.0
// registerQuickAsk(): the quick-ask window and its global shortcut; the `quick-ask:*` IPC.
// The shortcut applier goes to `ctx.shortcuts`.
//
// - Gate: Settings ▸ Labs `quickAsk.enabled`, off by default. While it is on,
//   main holds the global shortcut: `ctx.shortcuts.effective('quickAsk')`, which is
//   `shortcuts.quickAsk` or the platform default (Alt+Space on macOS, Ctrl+Alt+Space on
//   Windows). Off unregisters it and destroys the window; so does quitting.
// - A failed registration is logged and shown by the Labs row (`quick-ask:get-status`).
// - The shortcut hides a visible panel, does nothing while a transcript is capturing, and
//   otherwise shows the panel above the bottom of the display under the pointer.
// - Blur hides after 80 ms, never within 150 ms of showing; focus cancels a pending hide.
// - Submit: the panel hides and the main window comes forward with the message, which the
//   main renderer takes with `quick-ask:get-pending` (a cold window misses no push).

import { app, globalShortcut, ipcMain, screen, type BrowserWindow, type Rectangle } from 'electron'
import type { InvokeChannel, InvokeRes, PushChannel, SendChannel } from '@shared/ipc'
import { QUICK_ASK_GEOMETRY as G, type QuickAskMessage, type QuickAskStatus } from '@shared/types/chat'
import type { MainContext } from '../context'
import { showMainWindow } from '../lifecycle'
import { log } from '../log'

const MAX_MESSAGE = 50_000
/** The panel's top sits 5 % of the work area plus 80 px above its bottom. */
const BOTTOM_SHARE = 0.05
const BOTTOM_OFFSET = 80

/** The "shortcut taken" message, with the accelerator as the user sees it. */
function takenMessage(accelerator: string): string {
  return `${accelerator.replace(/CommandOrControl|CmdOrCtrl/g, process.platform === 'darwin' ? 'Cmd' : 'Ctrl').replace(/Control/g, 'Ctrl')} is used by another app.`
}

/** Without the lifecycle module: the existing main window, shown and focused. */
function focusMain(ctx: MainContext): BrowserWindow | null {
  const m = ctx.windows.main()
  if (m) {
    if (m.isMinimized()) m.restore()
    m.show()
    m.focus()
  }
  return m
}

export function registerQuickAsk(ctx: MainContext): void {
  let enabled = false
  let registered: string | null = null
  let error: string | null = null
  let win: BrowserWindow | null = null
  let shownAt = 0
  let hideTimer: ReturnType<typeof setTimeout> | null = null
  let pending: QuickAskMessage | null = null

  const status = (): QuickAskStatus => ({
    enabled,
    registered: registered !== null,
    accelerator: registered ?? ctx.shortcuts.effective('quickAsk'),
    error
  })

  // ---------- the window ----------

  const live = (): BrowserWindow | null => (win && !win.isDestroyed() ? win : null)

  const bounds = (): Rectangle => {
    // Dev builds pinned to one display (NOTULA_DEV_DISPLAY) keep the panel there.
    const pinned = !app.isPackaged && !!process.env['NOTULA_DEV_DISPLAY']
    const display = pinned ? screen.getPrimaryDisplay() : screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
    const wa = display.workArea
    return {
      x: Math.round(wa.x + (wa.width - G.width) / 2),
      y: wa.y + wa.height - Math.round(wa.height * BOTTOM_SHARE) - BOTTOM_OFFSET,
      width: G.width,
      height: G.height
    }
  }

  const create = (): BrowserWindow => {
    const mac = process.platform === 'darwin'
    const w = ctx.windows.createSecondary({
      kind: 'quick-ask',
      route: '/quick-ask',
      title: 'Quick ask',
      width: G.width,
      height: G.height,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      closable: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: true,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      ...(mac ? { type: 'panel', hiddenInMissionControl: true } : {})
    })
    if (mac) {
      w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      w.setAlwaysOnTop(true, 'floating')
    }
    w.on('blur', () => {
      // A blur inside the grace period is ignored.
      if (Date.now() - shownAt < G.blurGraceMs) return
      if (hideTimer) clearTimeout(hideTimer)
      hideTimer = setTimeout(() => {
        hideTimer = null
        hide('blur')
      }, G.blurHideMs)
    })
    w.on('focus', () => {
      if (hideTimer) clearTimeout(hideTimer)
      hideTimer = null
    })
    w.on('closed', () => {
      if (win === w) win = null
    })
    return w
  }

  const show = (): void => {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = null
    const w = live() ?? (win = create())
    w.setBounds(bounds())
    shownAt = Date.now()
    w.show()
    w.focus()
    w.webContents.focus()
    w.webContents.send('quick-ask:shown' satisfies PushChannel, { visible: true })
    log('debug', 'quick-ask:shown')
  }

  const hide = (reason: string): void => {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = null
    const w = live()
    if (!w || !w.isVisible()) return
    w.webContents.send('quick-ask:shown' satisfies PushChannel, { visible: false })
    w.hide()
    log('debug', 'quick-ask:hidden', { reason })
  }

  const destroy = (): void => {
    const w = live()
    win = null
    if (w) w.destroy()
  }

  const toggle = (): void => {
    if (live()?.isVisible()) {
      hide('shortcut')
      return
    }
    // The panel never opens while a transcript is capturing.
    if (ctx.capture.isCapturing()) {
      log('debug', 'quick-ask:blocked-by-capture')
      return
    }
    show()
  }

  // ---------- the shortcut ----------

  const unregister = (): void => {
    if (registered) globalShortcut.unregister(registered)
    registered = null
  }

  const register = (accelerator: string): { ok: boolean; error: string | null } => {
    unregister()
    let ok = false
    try {
      ok = globalShortcut.register(accelerator, toggle)
    } catch (err) {
      log('warn', 'quick-ask-shortcut-failed', { accelerator, err: err instanceof Error ? err.message : String(err) })
      error = 'That shortcut can’t be used.'
      return { ok: false, error }
    }
    if (!ok) {
      log('warn', 'quick-ask-shortcut-failed', { accelerator })
      error = takenMessage(accelerator)
      return { ok: false, error }
    }
    registered = accelerator
    error = null
    log('info', 'quick-ask:shortcut-registered', { accelerator })
    return { ok: true, error: null }
  }

  const apply = (on: boolean): void => {
    enabled = on
    if (on) {
      register(ctx.shortcuts.effective('quickAsk'))
    } else {
      unregister()
      error = null
      destroy()
    }
  }

  // Settings ▸ Keyboard shortcuts changes the accelerator through the shortcut registry.
  ctx.shortcuts.registerApplier('quickAsk', async (accelerator) => {
    if (!enabled) return { ok: true, error: null }
    const previous = registered
    const r = register(accelerator)
    if (!r.ok && previous) register(previous)
    return r
  })

  void app.whenReady().then(async () => {
    try {
      apply((await ctx.settings.get('quickAsk.enabled')) === true)
    } catch (err) {
      log('warn', 'quick-ask:read-failed', { err })
    }
  })
  ctx.bus.on('settings:changed', (e) => {
    if (e.keys.includes('quickAsk.enabled')) apply(e.settings['quickAsk.enabled'] === true)
    else if (e.keys.includes('shortcuts.quickAsk') && enabled) {
      const next = ctx.shortcuts.effective('quickAsk')
      if (next !== registered) register(next)
    }
  })
  app.on('will-quit', () => {
    unregister()
    destroy()
  })

  // ---------- IPC ----------

  ipcMain.on('quick-ask:close' satisfies SendChannel, (e) => {
    if (ctx.windows.kindOf(e.sender) !== 'quick-ask') return
    hide('escape')
  })

  ipcMain.on('quick-ask:send' satisfies SendChannel, (e, p: unknown) => {
    if (ctx.windows.kindOf(e.sender) !== 'quick-ask') return
    const raw = (p as { message?: unknown } | null)?.message
    const message = typeof raw === 'string' ? raw.trim().slice(0, MAX_MESSAGE) : ''
    hide('submit')
    // An empty message, or one sent while capturing, is dropped.
    if (!message) return
    if (ctx.capture.isCapturing()) {
      log('debug', 'quick-ask:dropped-while-capturing')
      return
    }
    pending = { message, chatSurface: 'quick_ask' }
    const main = showMainWindow() ?? focusMain(ctx)
    // The push wakes a loaded window; a cold one takes the message on mount.
    if (main && !main.webContents.isDestroyed() && !main.webContents.isLoading()) {
      main.webContents.send('quick-ask:send-chat-message' satisfies PushChannel, pending)
    }
    log('info', 'quick-ask:submitted', { chars: message.length })
  })

  ipcMain.handle('quick-ask:get-pending' satisfies InvokeChannel, (e): InvokeRes<'quick-ask:get-pending'> => {
    if (ctx.windows.kindOf(e.sender) !== 'main') return null
    const out = pending
    pending = null
    return out
  })

  ipcMain.handle('quick-ask:get-status' satisfies InvokeChannel, (): InvokeRes<'quick-ask:get-status'> => status())
}
