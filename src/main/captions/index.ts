// SPDX-License-Identifier: Apache-2.0
// registerCaptions(): the live-captions window and the `captions:*` IPC.
//
// - Captions are on for every transcribing note while `captions.alwaysOn` is on, unless the user turned
//   them off for that note: an in-memory off list that resets with the app.
// - Main owns one window (kind `captions`, route `/captions`), shown while a note is transcribing and
//   captions are active for it, whatever the bubble's visibility. It is not parented to
//   the bubble. It is non-focusable except while search is open.
// - Geometry: on the bubble's display (else the main window's). The compact window is sized
//   for the tallest caption (label, 3 lines, padding); the page bottom-aligns its card, so the visible
//   strip follows the caption.

import { app, ipcMain, screen, type BrowserWindow, type Rectangle } from 'electron'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel } from '@shared/ipc'
import { CAPTIONS_GEOMETRY, type CaptionsState } from '@shared/types/captions'
import type { MainContext } from '../context'
import { log } from '../log'
import { bubbleHub } from '../bubble/hub'
import { keepTransparent, reapplyTransparent } from '../bubble/main-window'

const LABEL_PX = 18
const PADDING_PX = 32
/** Label + 3 lines × 28 + 3 + padding. */
const COMPACT_MAX = LABEL_PX + CAPTIONS_GEOMETRY.visibleLines * CAPTIONS_GEOMETRY.lineHeight + 3 + PADDING_PX

export function registerCaptions(ctx: MainContext): void {
  let alwaysOn = false
  let win: BrowserWindow | null = null
  let mode: CaptionsState['mode'] = 'compact'
  let searching = false
  const off = new Set<string>()

  const alive = (w: BrowserWindow | null): w is BrowserWindow => w !== null && !w.isDestroyed()
  const noteId = (): string | null => (ctx.capture.isCapturing() ? ctx.capture.currentNoteId() : null)
  const active = (): boolean => {
    const id = noteId()
    return alwaysOn && id !== null && !off.has(id)
  }

  function state(): CaptionsState {
    return { noteId: noteId(), active: active(), alwaysOn, mode, searching }
  }

  function push(): void {
    const s = state()
    bubbleHub.captionsActive = s.active
    bubbleHub.emit('side-card')
    for (const wc of ctx.windows.targets()) wc.send('captions:state' satisfies PushChannel, s)
  }

  function display(): Electron.Display {
    const anchor = alive(bubbleHub.bubble) ? bubbleHub.bubble : ctx.windows.main()
    return anchor && !anchor.isDestroyed() ? screen.getDisplayMatching(anchor.getBounds()) : screen.getPrimaryDisplay()
  }

  /** The window bounds against the display's available area. */
  function bounds(): Rectangle {
    const a = display().workArea
    const width = Math.min(CAPTIONS_GEOMETRY.width, a.width - CAPTIONS_GEOMETRY.screenInset)
    const height =
      mode === 'expanded'
        ? Math.min(CAPTIONS_GEOMETRY.expandedHeight, a.height - CAPTIONS_GEOMETRY.screenInset)
        : Math.max(CAPTIONS_GEOMETRY.compactHeight, COMPACT_MAX)
    return {
      x: Math.round(a.x + (a.width - width) / 2),
      y: Math.round(a.y + a.height - CAPTIONS_GEOMETRY.bottomMargin - height),
      width: Math.round(width),
      height: Math.round(height)
    }
  }

  function ensure(): BrowserWindow {
    if (alive(win)) return win
    const w = ctx.windows.createSecondary({
      kind: 'captions',
      route: '/captions',
      title: 'Live captions',
      ...bounds(),
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
      hasShadow: false,
      roundedCorners: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      focusable: false,
      ...(process.platform === 'darwin' ? { type: 'panel' } : {})
    })
    keepTransparent(w)
    w.setAlwaysOnTop(true, 'screen-saver')
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    if (process.platform === 'darwin') w.setHiddenInMissionControl(true)
    w.on('closed', () => {
      if (win === w) win = null
    })
    win = w
    return w
  }

  function sync(): void {
    if (!active()) {
      if (alive(win) && win.isVisible()) win.hide()
      if (!alive(win) || !win.isVisible()) {
        mode = 'compact'
        searching = false
      }
      return
    }
    const w = ensure()
    w.setBounds(bounds())
    reapplyTransparent(w)
    if (!w.isVisible()) w.showInactive()
  }

  function update(): void {
    sync()
    push()
  }

  void ctx.settings
    .get('captions.alwaysOn')
    .then((v) => {
      alwaysOn = v
      update()
    })
    .catch((err: unknown) => log('warn', 'captions:settings-read-failed', { err }))

  ctx.bus.on('settings:changed', ({ keys, settings }) => {
    if (!keys.includes('captions.alwaysOn')) return
    alwaysOn = settings['captions.alwaysOn']
    update()
  })
  ctx.bus.on('capture:started', update)
  ctx.bus.on('capture:stopped', update)

  const reposition = (): void => {
    if (alive(win) && win.isVisible()) win.setBounds(bounds())
  }
  screen.on('display-added', reposition)
  screen.on('display-removed', reposition)
  screen.on('display-metrics-changed', reposition)
  bubbleHub.on('visible', reposition)
  app.on('will-quit', () => {
    if (alive(win)) win.destroy()
  })

  // ---------- IPC ----------

  ipcMain.handle('captions:get-state' satisfies InvokeChannel, (): InvokeRes<'captions:get-state'> => state())

  ipcMain.handle('captions:set-enabled' satisfies InvokeChannel, (_e, req: InvokeReq<'captions:set-enabled'>): void => {
    const id = req?.noteId
    if (typeof id !== 'string' || !id || id.length > 200 || typeof req.enabled !== 'boolean') return
    // Turning captions on is possible only while the setting is on.
    if (req.enabled) {
      if (!alwaysOn) return
      off.delete(id)
    } else {
      off.add(id)
    }
    log('debug', 'captions:toggled', { enabled: req.enabled })
    update()
  })

  ipcMain.handle('captions:set-mode' satisfies InvokeChannel, (e, req: InvokeReq<'captions:set-mode'>): void => {
    if (!alive(win) || e.sender.id !== win.webContents.id) return
    if ((req?.mode !== 'compact' && req?.mode !== 'expanded') || typeof req.searching !== 'boolean') return
    mode = req.mode
    searching = req.mode === 'expanded' && req.searching
    win.setBounds(bounds())
    // Focusable only while search is open.
    win.setFocusable(searching)
    if (searching) win.focus()
    push()
  })
}
