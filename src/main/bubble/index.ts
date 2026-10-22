// SPDX-License-Identifier: Apache-2.0
// registerBubble(): the floating live-meeting pill and its panels, and the `bubble:*` IPC;
// every window comes from `ctx.windows.createSecondary`.
//
// - Shows (inactive, never focused) while transcribing and the main window is not in
//   front, unless "Live meeting indicator" is off (`bubble.blocked`); hides when the
//   main window gains focus or the meeting ends.
// - Hover: main polls the cursor every 100 ms while the bubble is visible; the
//   transcript panel opens after 150 ms and closes 100 ms after the hover ends.
// - Drag: main moves the window with the cursor every 16 ms between drag-start and
//   drag-end; the renderer applies the 3 px click threshold.
// - The position lives in the main-only setting `bubble.position` (per device).

import { app, ipcMain, screen, type BrowserWindow, type Point, type Rectangle, type WebContents } from 'electron'
import type { InvokeChannel, InvokeRes, PushChannel, SendChannel, SendPayload } from '@shared/ipc'
import type { BubbleDocument, BubblePosition } from '@shared/types/bubble'
import { BUBBLE_SIZE } from '@shared/types/bubble'
import { BUBBLE_SNAPSHOT_LIMITS } from '@shared/types/snapshots'
import type { MainContext } from '../context'
import { log } from '../log'
import { bubbleHub } from './hub'
import { keepTransparent, reapplyTransparent, watchMainWindow } from './main-window'
import {
  clampToDisplay,
  contains,
  currentPillHeight,
  defaultBounds,
  displayOf,
  inactivityBounds,
  panelBounds,
  restoredBounds,
  setPillHeight
} from './position'

const HOVER_POLL_MS = 100
const PANEL_OPEN_DELAY_MS = 150
const PANEL_CLOSE_DELAY_MS = 100
const DRAG_FOLLOW_MS = 16
const SAVE_THROTTLE_MS = 250

/** A light shape check: the main window's renderer is trusted, but its payload is still rebuilt. */
function parseDocument(raw: unknown): BubbleDocument | null | undefined {
  if (raw === null) return null
  if (!raw || typeof raw !== 'object') return undefined
  const d = raw as Record<string, unknown>
  if (d['kind'] !== 'transcribing' || typeof d['noteId'] !== 'string' || !d['noteId']) return undefined
  const transcription = d['transcription']
  if (transcription !== 'inactive' && transcription !== 'starting' && transcription !== 'active' && transcription !== 'error') {
    return undefined
  }
  const inactivity = d['inactivity'] as BubbleDocument['inactivity'] | undefined
  return {
    kind: 'transcribing',
    noteId: d['noteId'],
    title: typeof d['title'] === 'string' ? d['title'].slice(0, 500) : null,
    event: d['event'] && typeof d['event'] === 'object' ? (d['event'] as BubbleDocument['event']) : null,
    transcription,
    warning: typeof d['warning'] === 'string' ? d['warning'].slice(0, 300) : null,
    inactivity:
      inactivity && typeof inactivity === 'object' && typeof inactivity.noteId === 'string' ? inactivity : null
  }
}

/**
 * The bubble's bounds at its fixed size. On fractional display scales Windows reports a
 * pixel more than was set, and feeding that back in would grow the pill on every move.
 */
function sized(r: Rectangle): Rectangle {
  return { x: r.x, y: r.y, width: BUBBLE_SIZE.width, height: currentPillHeight() }
}

const SIDE_WINDOW = {
  frame: false,
  transparent: true,
  backgroundColor: '#00000000',
  hasShadow: false,
  resizable: false,
  minimizable: false,
  maximizable: false,
  fullscreenable: false,
  alwaysOnTop: true,
  skipTaskbar: true,
  ...(process.platform === 'darwin' ? { type: 'panel' } : {})
} as const

export function registerBubble(ctx: MainContext): void {
  let doc: BubbleDocument | null = null
  let blocked = false
  let visible = false
  let hovered = false
  let bubble: BrowserWindow | null = null
  let panel: BrowserWindow | null = null
  let inactivity: BrowserWindow | null = null
  let mainWin: BrowserWindow | null = null
  /** The saved position is used once per session. */
  let restoreTried = false
  /** The bubble has been placed at least once this session. */
  let visibleOnce = false
  let savedPosition: BubblePosition | null = null
  let hoverTimer: ReturnType<typeof setInterval> | null = null
  let panelOpenTimer: ReturnType<typeof setTimeout> | null = null
  let panelCloseTimer: ReturnType<typeof setTimeout> | null = null
  let drag: { timer: ReturnType<typeof setInterval>; dx: number; dy: number } | null = null
  let saveTimer: ReturnType<typeof setTimeout> | null = null
  let pendingSave: BubblePosition | null = null

  void ctx.settings
    .getAll()
    .then((s) => {
      blocked = s['bubble.blocked']
      savedPosition = s['bubble.position']
      applyPillHeight(s['bubbleSnapshots.enabled'])
    })
    .catch((err: unknown) => log('warn', 'bubble:settings-read-failed', { err }))

  const alive = (w: BrowserWindow | null): w is BrowserWindow => w !== null && !w.isDestroyed()

  const mainFocused = (): boolean =>
    alive(mainWin) && mainWin.isVisible() && !mainWin.isMinimized() && mainWin.isFocused()

  /** The snapshot button makes the pill 130 px tall. */
  function applyPillHeight(snapshots: boolean): void {
    const h = snapshots ? BUBBLE_SNAPSHOT_LIMITS.pillHeight : BUBBLE_SIZE.height
    if (h === currentPillHeight()) return
    setPillHeight(h)
    if (alive(bubble)) {
      bubble.setBounds(clampToDisplay(sized(bubble.getBounds())))
      if (alive(panel) && panel.isVisible()) panel.setBounds(panelBounds(bubble.getBounds()))
      if (alive(inactivity) && inactivity.isVisible()) inactivity.setBounds(inactivityBounds(bubble.getBounds()))
    }
  }

  function sendTo(w: BrowserWindow | null, push: () => void): void {
    if (alive(w) && !w.webContents.isDestroyed()) push()
  }

  function pushVisible(): void {
    const p = { visible }
    bubbleHub.visible = visible
    bubbleHub.emit('visible', visible)
    sendTo(bubble, () => bubble?.webContents.send('bubble:shown' satisfies PushChannel, p))
    sendTo(mainWin, () => mainWin?.webContents.send('bubble:shown' satisfies PushChannel, p))
  }

  function pushHover(): void {
    sendTo(bubble, () => bubble?.webContents.send('bubble:hovered' satisfies PushChannel, { hovered }))
  }

  function pushDocument(): void {
    for (const w of [bubble, panel, inactivity]) {
      sendTo(w, () => w?.webContents.send('bubble:note' satisfies PushChannel, doc))
    }
    // The captions window follows the same document (its status line and title).
    for (const wc of ctx.windows.targets()) {
      if (ctx.windows.kindOf(wc) === 'captions') wc.send('bubble:note' satisfies PushChannel, doc)
    }
    bubbleHub.doc = doc
    bubbleHub.emit('document', doc)
  }

  // ---------- windows ----------

  function ensureBubble(): BrowserWindow {
    if (alive(bubble)) return bubble
    const win = ctx.windows.createSecondary({
      kind: 'bubble',
      route: '/bubble',
      title: 'Meeting bubble',
      width: BUBBLE_SIZE.width,
      height: currentPillHeight(),
      ...SIDE_WINDOW,
      roundedCorners: false,
      movable: true,
      focusable: false
    })
    keepTransparent(win)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    if (process.platform === 'darwin') win.setHiddenInMissionControl(true)
    win.on('closed', () => {
      flushSave()
      if (bubble === win) bubble = null
      if (bubbleHub.bubble === win) bubbleHub.bubble = null
      visible = false
      stopHover()
      stopDrag()
    })
    bubble = win
    bubbleHub.bubble = win
    return win
  }

  function ensurePanel(): BrowserWindow {
    if (alive(panel)) return panel
    const win = ctx.windows.createSecondary({
      kind: 'bubble-transcript',
      route: '/bubble-transcript',
      title: 'Meeting bubble transcript',
      width: 300,
      height: 350,
      ...SIDE_WINDOW,
      movable: false
    })
    keepTransparent(win)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    if (process.platform === 'darwin') win.setHiddenInMissionControl(true)
    win.on('closed', () => {
      if (panel === win) panel = null
    })
    panel = win
    return win
  }

  function ensureInactivity(): BrowserWindow {
    if (alive(inactivity)) return inactivity
    const win = ctx.windows.createSecondary({
      kind: 'bubble-inactivity',
      route: '/bubble-inactivity',
      title: 'Are you still there?',
      width: 336,
      height: 196,
      ...SIDE_WINDOW,
      movable: false
    })
    keepTransparent(win)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    if (process.platform === 'darwin') win.setHiddenInMissionControl(true)
    win.on('closed', () => {
      if (inactivity === win) inactivity = null
    })
    inactivity = win
    return win
  }

  // ---------- show and hide ----------

  /**
   * Transcribing is the only reason to show. An inactivity warning overrides
   * "Live meeting indicator" off: it is the only surface the warning has while
   * Notula is in the background.
   */
  const shouldShow = (): boolean => ctx.capture.isCapturing() && (!blocked || doc?.inactivity != null)

  function targetBounds(win: BrowserWindow): Rectangle {
    if (!restoreTried) {
      restoreTried = true
      const restored = restoredBounds(savedPosition)
      if (restored) return restored
    }
    // The display nearest the main window, else the primary one.
    const display = alive(mainWin) ? displayOf(mainWin.getBounds()) : screen.getPrimaryDisplay()
    const current = sized(win.getBounds())
    if (current.width > 0 && displayOf(current).id === display.id && visibleOnce) return clampToDisplay(current)
    return defaultBounds(display)
  }

  function show(why: string): void {
    if (!shouldShow() || visible) return
    const win = ensureBubble()
    win.setBounds(targetBounds(win))
    visibleOnce = true
    reapplyTransparent(win)
    win.setIgnoreMouseEvents(false)
    win.showInactive()
    visible = true
    log('debug', 'bubble:show', { why })
    pushVisible()
    startHover()
    syncInactivityWindow()
  }

  function hide(why: string): void {
    if (!visible) return
    visible = false
    stopDrag()
    stopHover()
    if (hovered) {
      hovered = false
      pushHover()
    }
    closePanel()
    if (alive(inactivity)) inactivity.hide()
    if (alive(bubble)) {
      bubble.setIgnoreMouseEvents(true)
      bubble.hide()
    }
    log('debug', 'bubble:hide', { why })
    pushVisible()
  }

  function destroyAll(): void {
    hide('teardown')
    for (const w of [panel, inactivity, bubble]) if (alive(w)) w.destroy()
    panel = null
    inactivity = null
    bubble = null
  }

  // ---------- hover and the transcript panel ----------

  function startHover(): void {
    if (hoverTimer) return
    hoverTimer = setInterval(pollHover, HOVER_POLL_MS)
  }

  function stopHover(): void {
    if (hoverTimer) clearInterval(hoverTimer)
    hoverTimer = null
    clearPanelTimers()
  }

  function pollHover(): void {
    if (!visible || !alive(bubble)) return
    let p: Point
    try {
      p = screen.getCursorScreenPoint()
    } catch (err) {
      log('warn', 'bubble:hovered-read-failed', { err })
      return
    }
    // The open panel counts as part of the hover, so the cursor can move into it.
    const over = contains(bubble.getBounds(), p) || (alive(panel) && panel.isVisible() && contains(panel.getBounds(), p))
    if (over === hovered) return
    hovered = over
    pushHover()
    clearPanelTimers()
    if (hovered) {
      panelOpenTimer = setTimeout(openPanel, PANEL_OPEN_DELAY_MS)
    } else {
      panelCloseTimer = setTimeout(closePanel, PANEL_CLOSE_DELAY_MS)
    }
  }

  function clearPanelTimers(): void {
    if (panelOpenTimer) clearTimeout(panelOpenTimer)
    if (panelCloseTimer) clearTimeout(panelCloseTimer)
    panelOpenTimer = null
    panelCloseTimer = null
  }

  function openPanel(): void {
    panelOpenTimer = null
    // Never during a drag or an inactivity warning.
    if (!visible || !hovered || drag || doc?.inactivity || bubbleHub.snapshotNotice || !alive(bubble)) return
    const win = ensurePanel()
    win.setBounds(panelBounds(bubble.getBounds()))
    reapplyTransparent(win)
    if (!win.isVisible()) win.showInactive()
  }

  function closePanel(): void {
    panelCloseTimer = null
    if (alive(panel) && panel.isVisible()) panel.hide()
  }

  // ---------- inactivity window ----------

  function syncInactivityWindow(): void {
    // The same side card carries the screen-snapshot notices when there is no warning.
    const want = visible && (doc?.inactivity != null || bubbleHub.snapshotNotice) && alive(bubble)
    if (!want) {
      if (alive(inactivity) && inactivity.isVisible()) inactivity.hide()
      return
    }
    closePanel()
    const win = ensureInactivity()
    if (alive(bubble)) win.setBounds(inactivityBounds(bubble.getBounds()))
    reapplyTransparent(win)
    if (!win.isVisible()) win.showInactive()
  }

  // ---------- drag ----------

  function startDrag(): void {
    if (!alive(bubble) || drag) return
    const c = screen.getCursorScreenPoint()
    const b = bubble.getBounds()
    clearPanelTimers()
    closePanel()
    drag = {
      dx: c.x - b.x,
      dy: c.y - b.y,
      timer: setInterval(() => {
        if (!alive(bubble) || !drag) return
        const p = screen.getCursorScreenPoint()
        // setBounds at the fixed size: setPosition grows the window on fractional scales.
        bubble.setBounds(sized({ x: p.x - drag.dx, y: p.y - drag.dy, width: 0, height: 0 }))
        if (alive(inactivity) && inactivity.isVisible()) inactivity.setBounds(inactivityBounds(bubble.getBounds()))
      }, DRAG_FOLLOW_MS)
    }
  }

  function stopDrag(): boolean {
    if (!drag) return false
    clearInterval(drag.timer)
    drag = null
    return true
  }

  function endDrag(): void {
    if (!stopDrag() || !alive(bubble)) return
    const b = clampToDisplay(sized(bubble.getBounds()))
    bubble.setBounds(b)
    if (alive(inactivity) && inactivity.isVisible()) inactivity.setBounds(inactivityBounds(b))
    scheduleSave({ bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, display: displayOf(b).bounds })
    // Re-send the hover state after the drag.
    pollHover()
    pushHover()
  }

  function scheduleSave(p: BubblePosition): void {
    pendingSave = p
    savedPosition = p
    if (saveTimer) return
    saveTimer = setTimeout(flushSave, SAVE_THROTTLE_MS)
  }

  function flushSave(): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    const p = pendingSave
    pendingSave = null
    if (!p) return
    void ctx.settings.set('bubble.position', p).catch((err: unknown) => log('warn', 'bubble:position-save-failed', { err }))
  }

  // ---------- triggers ----------

  watchMainWindow(ctx, {
    attached: (win) => {
      mainWin = win
      const onAway = (why: string) => (): void => {
        if (!mainFocused()) show(why)
      }
      win.on('blur', onAway('main-blur'))
      win.on('hide', onAway('main-hide'))
      win.on('minimize', onAway('main-minimize'))
      win.on('focus', () => hide('main-focus'))
    },
    closed: () => {
      mainWin = null
      destroyAll()
    }
  })

  // Capture starting while the main window is not in front shows the bubble.
  ctx.bus.on('capture:started', () => {
    if (!mainFocused()) show('capture-started')
  })
  ctx.bus.on('capture:stopped', () => {
    if (!ctx.capture.isCapturing()) hide('capture-stopped')
  })
  bubbleHub.on('side-card', () => syncInactivityWindow())
  ctx.bus.on('settings:changed', ({ keys, settings }) => {
    if (keys.includes('bubbleSnapshots.enabled')) applyPillHeight(settings['bubbleSnapshots.enabled'])
    if (!keys.includes('bubble.blocked')) return
    blocked = settings['bubble.blocked']
    if (blocked && !doc?.inactivity) hide('blocked')
    else if (!mainFocused()) show('unblocked')
  })

  const reclamp = (): void => {
    if (!alive(bubble)) return
    bubble.setBounds(clampToDisplay(sized(bubble.getBounds())))
    if (alive(panel) && panel.isVisible()) panel.setBounds(panelBounds(bubble.getBounds()))
    if (alive(inactivity) && inactivity.isVisible()) inactivity.setBounds(inactivityBounds(bubble.getBounds()))
  }
  screen.on('display-added', reclamp)
  screen.on('display-removed', reclamp)
  screen.on('display-metrics-changed', reclamp)
  app.on('will-quit', destroyAll)

  // ---------- IPC ----------

  const fromBubble = (wc: WebContents): boolean => alive(bubble) && bubble.webContents.id === wc.id

  ipcMain.handle('bubble:get-state' satisfies InvokeChannel, (): InvokeRes<'bubble:get-state'> => ({
    visible,
    hovered,
    document: doc
  }))

  ipcMain.on('bubble:set-document' satisfies SendChannel, (event, raw: SendPayload<'bubble:set-document'>) => {
    // Only the main window computes the document.
    if (ctx.windows.kindOf(event.sender) !== 'main') return
    const next = parseDocument(raw)
    if (next === undefined) {
      log('warn', 'bubble:note-invalid')
      return
    }
    doc = next
    pushDocument()
    if (!doc) {
      if (!ctx.capture.isCapturing()) hide('document-cleared')
    } else if (blocked && !doc.inactivity) {
      // Shown only for an inactivity warning, which has ended.
      hide('blocked')
    } else if (!mainFocused()) {
      show('document')
    }
    syncInactivityWindow()
  })

  ipcMain.on('bubble:drag-start' satisfies SendChannel, (event) => {
    if (fromBubble(event.sender)) startDrag()
  })

  ipcMain.on('bubble:drag-end' satisfies SendChannel, (event) => {
    if (fromBubble(event.sender)) endDrag()
  })

  ipcMain.on('bubble:open-note' satisfies SendChannel, (event, raw: SendPayload<'bubble:open-note'>) => {
    if (!fromBubble(event.sender)) return
    const noteId = raw?.noteId
    if (typeof noteId !== 'string' || !noteId || noteId.length > 200) return
    const main = ctx.windows.main()
    if (!main) {
      log('warn', 'bubble:open-note-no-window')
      return
    }
    if (main.isMinimized()) main.restore()
    main.show()
    main.focus()
    // Already showing that note: only focus. Otherwise open it.
    if (ctx.ui.viewingNoteId() === noteId) return
    main.webContents.send('deeplink:received' satisfies PushChannel, {
      type: 'show-note',
      data: { documentId: noteId, openSource: 'bubble_open_document' }
    })
  })
}
