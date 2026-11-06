// SPDX-License-Identifier: Apache-2.0
// registerBubble(): the floating live-meeting pill, its cards and its panels, and the
// `bubble:*` IPC; every window comes from `ctx.windows.createSecondary`.
//
// - Shows (inactive, never focused) while transcribing and the main window is not in
//   front, unless "Live meeting indicator" is off (`bubble.blocked`); hides when the
//   main window gains focus or the meeting ends. The privacy card (off the record: the
//   open choice, then the paused card until dismissed) shows it even over a focused main
//   window, unless that window shows the very note.
// - Cards (the inactivity warning, the screen-snapshot notices, off the record) render
//   inside the bubble window. The classic pill window grows to hold the card beside the
//   pill, the pill keeping its place on screen; it ignores the mouse outside the two.
//   No hover panel opens while a card shows.
// - Classic hover: main polls the cursor every 100 ms while the bubble is visible; the
//   transcript panel window opens after 150 ms and closes 100 ms after the hover ends.
// - Classic drag: main moves the window with the cursor every 16 ms between drag-start
//   and drag-end; the renderer applies the 3 px click threshold.
// - The pill's position lives in the main-only setting `bubble.position` (per device):
//   always the pill's bounds, never the grown window's.
// - Labs `bubble.dock` turns the window into a strip on a display edge (dock.ts);
//   switching it while the bubble shows rebuilds the bubble in the new mode.

import { app, ipcMain, screen, type BrowserWindow, type Point, type Rectangle, type WebContents } from 'electron'
import type { InvokeChannel, InvokeRes, PushChannel, SendChannel, SendPayload } from '@shared/ipc'
import type {
  BubbleDockAnchor,
  BubbleDockRect,
  BubbleDocument,
  BubbleLayout,
  BubblePanelEdge,
  BubblePanelSize,
  BubblePosition
} from '@shared/types/bubble'
import { BUBBLE_DOCK, BUBBLE_SIZE } from '@shared/types/bubble'
import { BUBBLE_SNAPSHOT_LIMITS } from '@shared/types/snapshots'
import type { MainContext } from '../context'
import { log } from '../log'
import { BubbleDock } from './dock'
import { bubbleHub } from './hub'
import { keepTransparent, reapplyTransparent, watchMainWindow } from './main-window'
import {
  cardBounds,
  clampToDisplay,
  contains,
  currentPillHeight,
  defaultBounds,
  displayOf,
  panelBounds,
  relative,
  restoredBounds,
  setPillHeight,
  union
} from './position'

const HOVER_POLL_MS = 100
const PANEL_OPEN_DELAY_MS = 150
const PANEL_CLOSE_DELAY_MS = 100
const DRAG_FOLLOW_MS = 16
const SAVE_THROTTLE_MS = 250
const MAX_DOCK_RECTS = 16
const PANEL_EDGES: readonly BubblePanelEdge[] = ['top', 'bottom', 'outer', 'top-outer', 'bottom-outer']

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
 * The pill's bounds at its fixed size. On fractional display scales Windows reports a
 * pixel more than was set, and feeding that back in would grow the pill on every move.
 */
function sized(r: Rectangle): Rectangle {
  return { x: r.x, y: r.y, width: BUBBLE_SIZE.width, height: currentPillHeight() }
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** The renderer's rectangles, rebuilt; anything malformed drops the report. */
function parseRects(raw: unknown): BubbleDockRect[] | null {
  const list = (raw as { rects?: unknown } | null)?.rects
  if (!Array.isArray(list) || list.length > MAX_DOCK_RECTS) return null
  const out: BubbleDockRect[] = []
  for (const r of list) {
    const o = r as Record<string, unknown> | null
    if (!o || !finite(o['x']) || !finite(o['y']) || !finite(o['width']) || !finite(o['height'])) return null
    const part = o['part']
    if (part !== 'pill' && part !== 'panel' && part !== 'card') return null
    out.push({ x: o['x'], y: o['y'], width: Math.max(0, o['width']), height: Math.max(0, o['height']), part })
  }
  return out
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
  let docked = false
  let visible = false
  let hovered = false
  let bubble: BrowserWindow | null = null
  let panel: BrowserWindow | null = null
  let mainWin: BrowserWindow | null = null
  /** The classic pill's on-screen bounds; the window is these, or these and a card. */
  let pill: Rectangle | null = null
  /** The card's on-screen bounds while one shows in the classic window. */
  let card: Rectangle | null = null
  /** The classic window takes the mouse only over the pill and the card; null = unknown. */
  let ignoring: boolean | null = null
  /** The saved position is used once per session. */
  let restoreTried = false
  /** The bubble has been placed at least once this session. */
  let visibleOnce = false
  let savedPosition: BubblePosition | null = null
  let hoverTimer: ReturnType<typeof setInterval> | null = null
  let panelOpenTimer: ReturnType<typeof setTimeout> | null = null
  let panelCloseTimer: ReturnType<typeof setTimeout> | null = null
  let drag: { timer: ReturnType<typeof setInterval>; dx: number; dy: number } | null = null
  const saves = new Map<'bubble.position' | 'bubble.dockAnchor' | 'bubble.panelSize', { value: unknown; timer: ReturnType<typeof setTimeout> }>()

  const alive = (w: BrowserWindow | null): w is BrowserWindow => w !== null && !w.isDestroyed()

  const mainFocused = (): boolean =>
    alive(mainWin) && mainWin.isVisible() && !mainWin.isMinimized() && mainWin.isFocused()

  /** Any card: the inactivity warning, a snapshot notice, or the privacy card (asking or paused). */
  const cardWanted = (): boolean => doc?.inactivity != null || bubbleHub.snapshotNotice || bubbleHub.offRecord !== null

  /** The privacy card, asking or paused, shows the bubble over everything but its own note. */
  const offRecordForced = (): boolean => {
    const o = bubbleHub.offRecord
    return o !== null && ctx.ui.viewingNoteId() !== o.noteId
  }

  const dock = new BubbleDock({
    window: () => (alive(bubble) ? bubble : null),
    visible: () => visible && docked,
    cardUp: () => visible && cardWanted(),
    hovered: (h) => {
      hovered = h
      pushHover()
    },
    saveAnchor: (a) => scheduleSave('bubble.dockAnchor', a),
    savePanel: (p) => scheduleSave('bubble.panelSize', p)
  })

  void ctx.settings
    .getAll()
    .then((s) => {
      blocked = s['bubble.blocked']
      savedPosition = s['bubble.position']
      dock.restore(s['bubble.dockAnchor'], s['bubble.panelSize'])
      applyPillHeight(s['bubbleSnapshots.enabled'])
      if (s['bubble.dock'] !== docked) rebuild(s['bubble.dock'])
    })
    .catch((err: unknown) => log('warn', 'bubble:settings-read-failed', { err }))

  /** The snapshot button makes the classic pill 130 px tall. */
  function applyPillHeight(snapshots: boolean): void {
    const h = snapshots ? BUBBLE_SNAPSHOT_LIMITS.pillHeight : BUBBLE_SIZE.height
    if (h === currentPillHeight()) return
    setPillHeight(h)
    if (pill && !docked) {
      pill = clampToDisplay(sized(pill))
      applyClassicBounds()
      if (alive(panel) && panel.isVisible()) panel.setBounds(panelBounds(pill))
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
    for (const w of [bubble, panel]) {
      sendTo(w, () => w?.webContents.send('bubble:note' satisfies PushChannel, doc))
    }
    // The captions window follows the same document (its status line and title).
    for (const wc of ctx.windows.targets()) {
      if (ctx.windows.kindOf(wc) === 'captions') wc.send('bubble:note' satisfies PushChannel, doc)
    }
    bubbleHub.doc = doc
    bubbleHub.emit('document', doc)
  }

  function pushOffRecord(): void {
    sendTo(bubble, () => bubble?.webContents.send('bubble:off-record' satisfies PushChannel, bubbleHub.offRecord))
  }

  // ---------- windows ----------

  function ensureBubble(): BrowserWindow {
    if (alive(bubble)) return bubble
    const size = docked ? BUBBLE_DOCK.canvas : { width: BUBBLE_SIZE.width, height: currentPillHeight() }
    const win = ctx.windows.createSecondary({
      kind: 'bubble',
      route: '/bubble',
      title: 'Meeting bubble',
      width: size.width,
      height: size.height,
      ...SIDE_WINDOW,
      roundedCorners: false,
      movable: !docked,
      focusable: false
    })
    keepTransparent(win)
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    if (process.platform === 'darwin') win.setHiddenInMissionControl(true)
    win.on('closed', () => {
      flushSaves()
      if (bubble === win) {
        bubble = null
        visible = false
        stopHover()
        stopDrag()
        dock.hide()
      }
      if (bubbleHub.bubble === win) bubbleHub.bubble = null
    })
    bubble = win
    bubbleHub.bubble = win
    ignoring = null
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

  // ---------- the classic window and its card ----------

  /** The window holds the pill, and the card beside it while one shows. */
  function applyClassicBounds(): void {
    if (!alive(bubble) || !pill || docked) return
    card = visible && cardWanted() ? cardBounds(pill) : null
    const frame = card ? union(pill, card) : pill
    const layout: BubbleLayout = { pill: relative(pill, frame), card: card ? relative(card, frame) : null }
    sendTo(bubble, () => bubble?.webContents.send('bubble:layout' satisfies PushChannel, layout))
    bubble.setBounds(frame)
    if (!card) setIgnore(false)
  }

  function setIgnore(ignore: boolean): void {
    if (!alive(bubble) || ignore === ignoring) return
    ignoring = ignore
    bubble.setIgnoreMouseEvents(ignore)
  }

  // ---------- show and hide ----------

  /**
   * Transcribing is the reason to show. An inactivity warning overrides "Live meeting
   * indicator" off: it is the only surface the warning has while Notula is in the
   * background. The off-the-record card shows the bubble on its own.
   */
  const shouldShow = (): boolean =>
    offRecordForced() || (ctx.capture.isCapturing() && (!blocked || doc?.inactivity != null))

  function targetPill(): Rectangle {
    if (!restoreTried) {
      restoreTried = true
      const restored = restoredBounds(savedPosition)
      if (restored) return restored
    }
    // The display nearest the main window, else the primary one.
    const display = alive(mainWin) ? displayOf(mainWin.getBounds()) : screen.getPrimaryDisplay()
    if (pill && displayOf(pill).id === display.id && visibleOnce) return clampToDisplay(sized(pill))
    return defaultBounds(display)
  }

  function show(why: string): void {
    if (!shouldShow() || visible) return
    const win = ensureBubble()
    visible = true
    reapplyTransparent(win)
    if (docked) {
      dock.show()
    } else {
      pill = targetPill()
      ignoring = null
      applyClassicBounds()
      setIgnore(false)
    }
    visibleOnce = true
    win.showInactive()
    log('debug', 'bubble:show', { why, docked })
    pushVisible()
    pushOffRecord()
    if (!docked) startHover()
    syncCards()
  }

  function hide(why: string): void {
    if (!visible) return
    visible = false
    stopDrag()
    stopHover()
    dock.hide()
    if (hovered) {
      hovered = false
      pushHover()
    }
    closePanel()
    if (alive(bubble)) {
      bubble.setIgnoreMouseEvents(true)
      ignoring = true
      bubble.hide()
    }
    card = null
    log('debug', 'bubble:hide', { why })
    pushVisible()
  }

  /** Shows or hides for the current state: the main window's focus, capture, cards. */
  function reconsider(why: string): void {
    if (!shouldShow()) hide(why)
    else if (offRecordForced() || !mainFocused()) show(why)
    else hide(why)
  }

  function destroyAll(): void {
    hide('teardown')
    for (const w of [panel, bubble]) if (alive(w)) w.destroy()
    panel = null
    bubble = null
  }

  /** `bubble.dock` changed: the bubble comes back in the new mode. */
  function rebuild(next: boolean): void {
    const was = visible
    hide('mode-change')
    for (const w of [panel, bubble]) if (alive(w)) w.destroy()
    panel = null
    bubble = null
    docked = next
    log('info', 'bubble:mode', { docked })
    if (was) show('mode-change')
  }

  // ---------- classic hover and the transcript panel ----------

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
    if (!visible || !alive(bubble) || !pill || docked) return
    let p: Point
    try {
      p = screen.getCursorScreenPoint()
    } catch (err) {
      log('warn', 'bubble:hovered-read-failed', { err })
      return
    }
    // With a card up, the transparent rest of the grown window lets the mouse through.
    if (card && !drag) setIgnore(!contains(pill, p) && !contains(card, p))
    // The open panel counts as part of the hover, so the cursor can move into it.
    const over = contains(pill, p) || (alive(panel) && panel.isVisible() && contains(panel.getBounds(), p))
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
    // Never during a drag or while a card shows.
    if (!visible || !hovered || drag || cardWanted() || !pill || docked) return
    const win = ensurePanel()
    win.setBounds(panelBounds(pill))
    reapplyTransparent(win)
    if (!win.isVisible()) win.showInactive()
  }

  function closePanel(): void {
    panelCloseTimer = null
    if (alive(panel) && panel.isVisible()) panel.hide()
  }

  // ---------- cards ----------

  function syncCards(): void {
    if (!visible) return
    if (cardWanted()) {
      clearPanelTimers()
      closePanel()
    }
    if (docked) dock.syncCard()
    else applyClassicBounds()
  }

  // ---------- classic drag ----------

  function startDrag(): void {
    if (!alive(bubble) || !pill || drag || docked) return
    const c = screen.getCursorScreenPoint()
    const from = pill
    clearPanelTimers()
    closePanel()
    setIgnore(false)
    drag = {
      dx: c.x - from.x,
      dy: c.y - from.y,
      timer: setInterval(() => {
        if (!alive(bubble) || !drag) return
        const p = screen.getCursorScreenPoint()
        // setBounds at the fixed size: setPosition grows the window on fractional scales.
        pill = sized({ x: p.x - drag.dx, y: p.y - drag.dy, width: 0, height: 0 })
        applyClassicBounds()
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
    if (!stopDrag() || !alive(bubble) || !pill) return
    const b = clampToDisplay(sized(pill))
    pill = b
    applyClassicBounds()
    scheduleSave('bubble.position', { bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, display: displayOf(b).bounds })
    // Re-send the hover state after the drag.
    pollHover()
    pushHover()
  }

  // ---------- saves (250 ms, per key) ----------

  function scheduleSave(key: 'bubble.position' | 'bubble.dockAnchor' | 'bubble.panelSize', value: BubblePosition | BubbleDockAnchor | BubblePanelSize | null): void {
    if (key === 'bubble.position') savedPosition = value as BubblePosition
    const pending = saves.get(key)
    if (pending) {
      pending.value = value
      return
    }
    saves.set(key, { value, timer: setTimeout(() => flushSave(key), SAVE_THROTTLE_MS) })
  }

  function flushSave(key: 'bubble.position' | 'bubble.dockAnchor' | 'bubble.panelSize'): void {
    const pending = saves.get(key)
    if (!pending) return
    clearTimeout(pending.timer)
    saves.delete(key)
    const done = (err: unknown): void => log('warn', 'bubble:save-failed', { key, err })
    if (key === 'bubble.position') void ctx.settings.set(key, pending.value as BubblePosition).catch(done)
    else if (key === 'bubble.dockAnchor') void ctx.settings.set(key, pending.value as BubbleDockAnchor).catch(done)
    else void ctx.settings.set(key, pending.value as BubblePanelSize | null).catch(done)
  }

  function flushSaves(): void {
    for (const key of [...saves.keys()]) flushSave(key)
  }

  // ---------- triggers ----------

  watchMainWindow(ctx, {
    attached: (win) => {
      mainWin = win
      win.on('blur', () => reconsider('main-blur'))
      win.on('hide', () => reconsider('main-hide'))
      win.on('minimize', () => reconsider('main-minimize'))
      win.on('focus', () => reconsider('main-focus'))
    },
    closed: () => {
      mainWin = null
      destroyAll()
    }
  })

  // Capture starting while the main window is not in front shows the bubble.
  ctx.bus.on('capture:started', () => reconsider('capture-started'))
  ctx.bus.on('capture:stopped', () => reconsider('capture-stopped'))
  ctx.bus.on('ui:viewing-note', () => {
    if (bubbleHub.offRecord) reconsider('viewing-note')
  })
  bubbleHub.on('side-card', () => {
    pushOffRecord()
    reconsider('side-card')
    syncCards()
  })
  ctx.bus.on('settings:changed', ({ keys, settings }) => {
    if (keys.includes('bubbleSnapshots.enabled')) applyPillHeight(settings['bubbleSnapshots.enabled'])
    if (keys.includes('bubble.dock') && settings['bubble.dock'] !== docked) rebuild(settings['bubble.dock'])
    if (!keys.includes('bubble.blocked')) return
    blocked = settings['bubble.blocked']
    reconsider(blocked ? 'blocked' : 'unblocked')
  })

  const reclamp = (): void => {
    if (docked) {
      dock.reclamp()
      return
    }
    if (!alive(bubble) || !pill) return
    pill = clampToDisplay(sized(pill))
    applyClassicBounds()
    if (alive(panel) && panel.isVisible()) panel.setBounds(panelBounds(pill))
  }
  screen.on('display-added', reclamp)
  screen.on('display-removed', reclamp)
  screen.on('display-metrics-changed', reclamp)
  app.on('will-quit', destroyAll)

  // ---------- IPC ----------

  const fromBubble = (wc: WebContents): boolean => alive(bubble) && bubble.webContents.id === wc.id

  ipcMain.handle('bubble:get-state' satisfies InvokeChannel, (): InvokeRes<'bubble:get-state'> => {
    const frame = card && pill ? union(pill, card) : pill
    return {
      visible,
      hovered,
      document: doc,
      layout: !docked && pill && frame ? { pill: relative(pill, frame), card: card ? relative(card, frame) : null } : null,
      docked: docked ? dock.layout() : null,
      offRecord: bubbleHub.offRecord
    }
  })

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
    reconsider('document')
    syncCards()
  })

  ipcMain.on('bubble:drag-start' satisfies SendChannel, (event) => {
    if (fromBubble(event.sender)) startDrag()
  })

  ipcMain.on('bubble:drag-end' satisfies SendChannel, (event) => {
    if (fromBubble(event.sender)) endDrag()
  })

  ipcMain.on('bubble:dock-region' satisfies SendChannel, (event, raw: SendPayload<'bubble:dock-region'>) => {
    if (!fromBubble(event.sender) || !docked) return
    const rects = parseRects(raw)
    if (rects) dock.setRegion(rects)
  })

  ipcMain.on('bubble:dock-extent' satisfies SendChannel, (event, raw: SendPayload<'bubble:dock-extent'>) => {
    if (!fromBubble(event.sender) || !docked) return
    const mode = raw?.mode
    if ((mode !== 'collapsed' && mode !== 'panel' && mode !== 'held') || !finite(raw.width) || !finite(raw.below)) return
    dock.setExtent({ mode, width: Math.max(0, raw.width), below: Math.max(0, raw.below) })
  })

  ipcMain.on('bubble:dock-move' satisfies SendChannel, (event, raw: SendPayload<'bubble:dock-move'>) => {
    if (!fromBubble(event.sender) || !docked) return
    const phase = raw?.phase
    if ((phase !== 'start' && phase !== 'move' && phase !== 'end') || !finite(raw.dy)) return
    dock.moveEvent(phase, raw.dy)
  })

  ipcMain.on('bubble:panel-resize' satisfies SendChannel, (event, raw: SendPayload<'bubble:panel-resize'>) => {
    if (!fromBubble(event.sender) || !docked) return
    const phase = raw?.phase
    if (phase !== 'start' && phase !== 'move' && phase !== 'end' && phase !== 'reset') return
    if (!PANEL_EDGES.includes(raw.edge) || !finite(raw.dx) || !finite(raw.dy)) return
    dock.resizeEvent(phase, raw.edge, raw.dx, raw.dy)
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
