// SPDX-License-Identifier: Apache-2.0
// registerWindowModes(): the main window's wide, side, mini and mini bottom-left modes, the after-meeting
// reset, the preview window and the macOS screen corner; the `window:*` and
// `screen-corner:*` IPC. Returns `ctx.windowModes`.
//
// - Main owns the mode; the renderer only asks (`window:mode`) and is told
//   (`window:mode-changed`), so it can drop chrome in the small modes.
// - Every move restores a maximized window first and is an animated resize (macOS
//   animates; Windows moves at once). Notula keeps its native frame, so the Windows
//   title-bar-overlay rules have nothing to act on.
// - `join` requests apply only while "Reposition Notula for meetings" is on
//   (`window.repositionForMeetings`); a main-side join applies side bounds only when it
//   also focuses the window. Side and wide cancel the after-meeting reset.
// - The reset is armed by enhance at the end-of-meeting summary step.
// - Mini bottom-left and the preview window have no consumer yet; Settings ▸
//   Developer tools drives them for checks by hand.
// - The screen corner exists on macOS only, behind Labs `screenCorner.enabled`.
// - Mode changes, the reset and the screen corner write local debug lines only.
//
// Handlers and pushes write their channel literal.

import { isAbsolute, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, ipcMain, screen, type Display, type IpcMainEvent } from 'electron'
import type { InvokeChannel, PushChannel, SendChannel } from '@shared/ipc'
import {
  SCREEN_CORNER,
  WINDOW_GEOMETRY as G,
  WINDOW_RESET,
  type WindowMode,
  type WindowModeReason
} from '@shared/types/window-modes'
import type { MainContext, WindowModesApi } from '../context'
import { requestNewNote, showMainWindow } from '../lifecycle'
import { log } from '../log'
import { miniBottomLeftBounds, miniBounds, previewBounds, sideBounds, wideBounds, type Box } from './geometry'

const isMac = process.platform === 'darwin'

const MODES: readonly WindowMode[] = ['wide', 'side', 'mini', 'mini-bottom-left']
const REASONS: readonly WindowModeReason[] = ['join', 'demo', 'guide', 'oauth', 'user']
/**
 * Image paths the preview window may show: assets bundled with the app, as a relative path
 * or a path on the app's own origin (`/…`), never a URL with a scheme or host.
 */
const PREVIEW_SRC = /^(?:\.?\/)?(?:[\w-]+\/)*[\w.-]+\.(?:png|jpe?g|webp|gif|svg)$/i

const IMAGE_EXT = /\.(?:png|jpe?g|webp|gif|svg)$/i

/**
 * The preview shows only an image bundled with the app: a relative asset path, a
 * `file:` URL inside the app's own renderer folder (production), or the dev server's own
 * origin (development). Never a remote URL or another file.
 */
function previewSrcAllowed(src: string): boolean {
  if (src.length > 2_000) return false
  if (PREVIEW_SRC.test(src) && !src.includes('..')) return true
  let url: URL
  try {
    url = new URL(src)
  } catch {
    return false
  }
  if (!IMAGE_EXT.test(url.pathname) || url.search || url.hash) return false
  if (url.protocol === 'file:') {
    let path: string
    try {
      path = fileURLToPath(url)
    } catch {
      return false
    }
    const back = relative(resolve(__dirname, '../renderer'), resolve(path))
    return back !== '' && !back.startsWith('..') && !isAbsolute(back)
  }
  const dev = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && dev && (url.protocol === 'http:' || url.protocol === 'https:')) {
    try {
      return url.origin === new URL(dev).origin
    } catch {
      return false
    }
  }
  return false
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

function center(b: Box): { x: number; y: number } {
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
}

function displayNearestWindow(win: BrowserWindow): Display {
  try {
    return screen.getDisplayNearestPoint(center(win.getBounds()))
  } catch {
    return screen.getPrimaryDisplay()
  }
}

function displayUnderCursor(): Display {
  // Dev and test runs with NOTULA_DEV_DISPLAY keep every window on the chosen display
  // (index.ts answers getPrimaryDisplay with it), wherever the pointer is.
  if (!app.isPackaged && process.env['NOTULA_DEV_DISPLAY']) return screen.getPrimaryDisplay()
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
}

/** The animated move every mode makes; a maximized window is restored first. */
function moveTo(win: BrowserWindow, bounds: Box): void {
  if (win.isMaximized()) win.unmaximize()
  win.setBounds(bounds, true)
}

export function registerWindowModes(ctx: MainContext): WindowModesApi {
  let mode: WindowMode = 'wide'
  /** Only side and wide change it, so side → mini keeps it. */
  let sideMark = false
  let resetTimer: NodeJS.Timeout | null = null
  let reposition = true

  void ctx.settings
    .get('window.repositionForMeetings')
    .then((v) => {
      reposition = v !== false
    })
    .catch((err: unknown) => log('warn', 'window-modes:setting-read-failed', { err }))
  ctx.bus.on('settings:changed', (e) => {
    reposition = e.settings['window.repositionForMeetings'] !== false
  })

  function announce(next: WindowMode, reason: string): void {
    const changed = next !== mode
    mode = next
    log('debug', 'window-modes:mode', { mode: next, reason })
    if (!changed) return
    const win = ctx.windows.main()
    if (win && !win.webContents.isDestroyed()) win.webContents.send('window:mode-changed' satisfies PushChannel, { mode: next })
  }

  function cancelReset(): void {
    if (resetTimer) clearTimeout(resetTimer)
    resetTimer = null
  }

  function focusSoon(win: BrowserWindow): void {
    setTimeout(() => {
      if (win.isDestroyed()) return
      win.show()
      win.focus()
    }, G.focusDelayMs)
  }

  // ---------- the modes ----------

  function applyWide(win: BrowserWindow, focus: boolean, reason: string): void {
    sideMark = false
    moveTo(win, wideBounds(displayNearestWindow(win).workArea))
    win.setMinimumSize(G.minWidth, G.minHeight)
    win.setMaximizable(true)
    win.setMinimizable(true)
    win.setFullScreenable(true)
    win.setAlwaysOnTop(false)
    win.setVisibleOnAllWorkspaces(false)
    if (isMac) win.setWindowButtonVisibility(true)
    if (focus) {
      if (isMac) app.setActivationPolicy('regular')
      win.show()
      win.focus()
    }
    announce('wide', reason)
  }

  function applySide(win: BrowserWindow, focus: boolean, reason: string): void {
    sideMark = true
    // Nothing else changes: the size limits and always-on-top stay as they were.
    moveTo(win, sideBounds(displayNearestWindow(win).workArea))
    if (focus) {
      win.show()
      win.focus()
    }
    announce('side', reason)
  }

  function smallWindowConstraints(win: BrowserWindow, min: { width: number; height: number }): void {
    win.setMinimumSize(min.width, min.height)
    win.setMaximizable(false)
    win.setMinimizable(false)
    win.setFullScreenable(false)
    win.setAlwaysOnTop(true, 'floating')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
  }

  function applyMini(win: BrowserWindow, reason: string): void {
    // Nothing happens while the window is full screen.
    if (win.isFullScreen()) {
      log('debug', 'window-modes:mini-ignored-full-screen', { reason })
      return
    }
    smallWindowConstraints(win, G.mini)
    moveTo(win, miniBounds(displayUnderCursor().workArea))
    focusSoon(win)
    announce('mini', reason)
  }

  async function applyMiniBottomLeft(win: BrowserWindow, reason: string): Promise<void> {
    // macOS leaves full screen first and waits 750 ms.
    if (isMac && win.isFullScreen()) {
      win.setFullScreen(false)
      await sleep(G.fullScreenExitMs)
      if (win.isDestroyed()) return
    }
    smallWindowConstraints(win, G.miniBottomLeft)
    if (isMac) win.setWindowButtonVisibility(false)
    moveTo(win, miniBottomLeftBounds(displayUnderCursor().workArea))
    focusSoon(win)
    announce('mini-bottom-left', reason)
  }

  async function set(next: WindowMode, opts: { focus?: boolean; reason?: WindowModeReason; fromRenderer?: boolean } = {}): Promise<void> {
    const reason = opts.reason ?? 'user'
    if (reason === 'join' && !reposition) {
      log('debug', 'window-modes:join-not-repositioned')
      return
    }
    if (next === 'side' || next === 'wide') cancelReset()
    // A main-side join that does not focus leaves the window where it is.
    if (next === 'side' && reason === 'join' && !opts.focus && !opts.fromRenderer) return
    const win = opts.focus ? showMainWindow() : ctx.windows.main()
    if (!win || win.isDestroyed()) return
    switch (next) {
      case 'wide':
        applyWide(win, opts.focus === true, reason)
        return
      case 'side':
        applySide(win, opts.focus === true, reason)
        return
      case 'mini':
        applyMini(win, reason)
        return
      case 'mini-bottom-left':
        await applyMiniBottomLeft(win, reason)
    }
  }

  // ---------- back to wide after a meeting ----------

  function resetCheck(): void {
    resetTimer = null
    const win = ctx.windows.main()
    if (!win || win.isDestroyed() || !sideMark) return
    if (!reposition) {
      sideMark = false
      return
    }
    if (!win.isFocused()) {
      applyWide(win, false, 'reset')
      log('debug', 'side-window-reset-after-meeting')
      return
    }
    // The user is using it: look again in a minute.
    resetTimer = setTimeout(resetCheck, WINDOW_RESET.recheckMs)
  }

  function scheduleResetAfterMeeting(): void {
    cancelReset()
    resetTimer = setTimeout(resetCheck, WINDOW_RESET.firstCheckMs)
    log('debug', 'window-modes:reset-scheduled')
  }

  // ---------- the preview window ----------

  let preview: BrowserWindow | null = null
  let previewReady = false
  let previewLoadedSrc: string | null = null
  let pending: { src: string; width: number; height: number } | null = null

  function placePreview(): void {
    const main = ctx.windows.main()
    if (!preview || preview.isDestroyed() || !pending || !main || main.isDestroyed()) return
    const mb = main.getBounds()
    const bounds = previewBounds(mb, screen.getDisplayNearestPoint(center(mb)).workArea, pending)
    if (!bounds) return
    preview.setBounds(bounds)
    preview.showInactive()
  }

  function ensurePreview(): BrowserWindow {
    if (preview && !preview.isDestroyed()) return preview
    previewReady = false
    previewLoadedSrc = null
    const win = ctx.windows.createSecondary({
      kind: 'window-preview',
      route: '/window-preview',
      title: 'Notula Preview',
      width: G.preview.requestWidth,
      height: Math.round(G.preview.requestWidth * 0.6),
      frame: false,
      transparent: true,
      hasShadow: false,
      roundedCorners: false,
      ...(isMac ? { type: 'panel' } : {}),
      focusable: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      hiddenInMissionControl: true
    })
    win.setIgnoreMouseEvents(true)
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    win.on('closed', () => {
      if (preview === win) preview = null
    })
    preview = win
    return win
  }

  function sendPreviewSrc(): void {
    if (!preview || preview.isDestroyed() || !pending || !previewReady) return
    if (previewLoadedSrc === pending.src) {
      placePreview()
      return
    }
    preview.webContents.send('window:preview-src' satisfies PushChannel, { src: pending.src })
  }

  // ---------- the screen corner (macOS) ----------

  let poll: NodeJS.Timeout | null = null
  let panel: BrowserWindow | null = null
  let panelVisible = false
  let panelDisplayId: number | null = null
  let hideTimer: NodeJS.Timeout | null = null

  function sendVisible(visible: boolean): void {
    if (panel && !panel.isDestroyed()) panel.webContents.send('screen-corner:visible' satisfies PushChannel, { visible })
  }

  function ensurePanel(display: Display): BrowserWindow {
    const b = display.bounds
    if (!panel || panel.isDestroyed()) {
      panel = ctx.windows.createSecondary({
        kind: 'screen-corner',
        route: '/screen-corner',
        title: 'Notula New Note',
        width: SCREEN_CORNER.window.width,
        height: SCREEN_CORNER.window.height,
        x: b.x,
        y: b.y + b.height - SCREEN_CORNER.window.height,
        frame: false,
        transparent: true,
        hasShadow: false,
        roundedCorners: false,
        type: 'panel',
        focusable: false,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        alwaysOnTop: true,
        skipTaskbar: true,
        hiddenInMissionControl: true
      })
      panel.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
      panelDisplayId = display.id
    } else if (panelDisplayId !== display.id) {
      panel.setBounds({ x: b.x, y: b.y + b.height - SCREEN_CORNER.window.height, width: SCREEN_CORNER.window.width, height: SCREEN_CORNER.window.height })
      panelDisplayId = display.id
    }
    return panel
  }

  function showPanel(display: Display): void {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = null
    const win = ensurePanel(display)
    if (panelVisible) return
    panelVisible = true
    win.showInactive()
    sendVisible(true)
  }

  function hidePanel(): void {
    if (!panelVisible) return
    panelVisible = false
    sendVisible(false)
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      hideTimer = null
      if (!panelVisible && panel && !panel.isDestroyed()) panel.hide()
    }, SCREEN_CORNER.hideDelayMs)
  }

  function tick(): void {
    if (ctx.capture.isCapturing()) {
      hidePanel()
      return
    }
    const p = screen.getCursorScreenPoint()
    const display = screen.getDisplayNearestPoint(p)
    // The full display bounds, not the work area, so the Dock area counts.
    const b = display.bounds
    const distance = Math.max(p.x - b.x, b.y + b.height - 1 - p.y)
    let inside = false
    if (panelVisible && panel && !panel.isDestroyed()) {
      const pb = panel.getBounds()
      inside = p.x >= pb.x && p.x < pb.x + pb.width && p.y >= pb.y && p.y < pb.y + pb.height
    }
    if (distance <= SCREEN_CORNER.triggerPx || inside) showPanel(display)
    else hidePanel()
  }

  function stopScreenCorner(): void {
    if (poll) clearInterval(poll)
    poll = null
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = null
    panelVisible = false
    if (panel && !panel.isDestroyed()) panel.destroy()
    panel = null
    panelDisplayId = null
  }

  function followScreenCorner(on: boolean): void {
    if (!isMac) return
    if (on && !poll) {
      poll = setInterval(tick, SCREEN_CORNER.pollMs)
      log('debug', 'screen-corner:started')
    } else if (!on && poll) {
      stopScreenCorner()
      log('debug', 'screen-corner:stopped')
    }
  }

  if (isMac) {
    void ctx.settings
      .get('screenCorner.enabled')
      .then((on) => followScreenCorner(on === true))
      .catch((err: unknown) => log('warn', 'screen-corner:setting-read-failed', { err }))
    ctx.bus.on('settings:changed', (e) => {
      if (e.keys.includes('screenCorner.enabled')) followScreenCorner(e.settings['screenCorner.enabled'] === true)
    })
  }

  // ---------- IPC ----------

  const fromMain = (e: IpcMainEvent): boolean => ctx.windows.kindOf(e.sender) === 'main'

  ipcMain.on('window:mode' satisfies SendChannel, (e, p: unknown) => {
    const kind = ctx.windows.kindOf(e.sender)
    if (kind !== 'main' && kind !== 'demo') return
    const next = (p as { mode?: unknown } | null)?.mode
    const reason = (p as { reason?: unknown } | null)?.reason
    if (!(MODES as readonly unknown[]).includes(next) || (reason !== undefined && !(REASONS as readonly unknown[]).includes(reason))) {
      log('warn', 'window-modes:invalid-request')
      return
    }
    void set(next as WindowMode, { reason: reason as WindowModeReason | undefined, fromRenderer: true }).catch((err: unknown) =>
      log('error', 'window-modes:set-failed', { err })
    )
  })

  ipcMain.handle('window:get-mode' satisfies InvokeChannel, () => ({ mode }))

  // At least this wide, keeping the position (clamped to the work area).
  ipcMain.on('window:ensure-min-width' satisfies SendChannel, (e, p: unknown) => {
    if (!fromMain(e)) return
    const width = (p as { width?: unknown } | null)?.width
    if (typeof width !== 'number' || !Number.isFinite(width) || width <= 0 || width > 10_000) return
    const win = ctx.windows.main()
    if (!win || win.isDestroyed()) return
    const b = win.getBounds()
    const wanted = Math.min(Math.round(width), displayNearestWindow(win).workArea.width)
    if (b.width >= wanted) return
    if (win.isMaximized()) win.unmaximize()
    win.setBounds({ ...b, width: wanted }, true)
  })

  ipcMain.on('window:preview-show' satisfies SendChannel, (e, p: unknown) => {
    if (!fromMain(e)) return
    const src = (p as { src?: unknown } | null)?.src
    const width = (p as { width?: unknown } | null)?.width
    const height = (p as { height?: unknown } | null)?.height
    // Only an image bundled with the app; never a remote URL or another file.
    if (typeof src !== 'string' || !previewSrcAllowed(src)) {
      log('warn', 'window-modes:preview-src-refused')
      return
    }
    if (typeof width !== 'number' || typeof height !== 'number' || !(width > 0) || !(height > 0) || width > 10_000 || height > 10_000) return
    pending = { src, width, height }
    ensurePreview()
    sendPreviewSrc()
  })

  ipcMain.on('window:preview-hide' satisfies SendChannel, (e) => {
    if (!fromMain(e)) return
    pending = null
    if (preview && !preview.isDestroyed()) preview.hide()
  })

  ipcMain.on('window:preview-ready' satisfies SendChannel, (e) => {
    if (ctx.windows.kindOf(e.sender) !== 'window-preview') return
    previewReady = true
    sendPreviewSrc()
  })

  ipcMain.on('window:preview-loaded' satisfies SendChannel, (e) => {
    if (ctx.windows.kindOf(e.sender) !== 'window-preview') return
    previewLoadedSrc = pending?.src ?? null
    placePreview()
  })

  // macOS only in practice: the panel is never created elsewhere, so the sender check fails.
  ipcMain.on('screen-corner:click' satisfies SendChannel, (e) => {
    if (ctx.windows.kindOf(e.sender) !== 'screen-corner') return
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = null
    panelVisible = false
    sendVisible(false)
    if (panel && !panel.isDestroyed()) panel.hide()
    log('debug', 'screen-corner-hit')
    // The New note path, including its "blocked while capturing" rule; no side placement.
    requestNewNote('screen_corner', { autoTranscribe: true })
  })

  app.on('before-quit', () => {
    cancelReset()
    stopScreenCorner()
  })

  return {
    mode: () => mode,
    set: (next, opts) => set(next, opts),
    scheduleResetAfterMeeting,
    cancelReset
  }
}
