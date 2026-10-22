// SPDX-License-Identifier: Apache-2.0
// The meeting dock: the `meeting-dock:*` IPC and its window.
//
// - Gate: `meetingDock.enabled` (Labs, off). Off closes the window.
// - Lifecycle: opens when a note's capture becomes active, follows that note, and
//   closes when capture ends. A stop for system sleep keeps it open as "paused" until the same
//   note resumes. Close hides it for this capture; `ctx.meetingDock.show()` (the tray) and
//   `meeting-dock:show` bring it back.
// - Window: frameless, focusable, on top, off the taskbar, shown inactive, no native
//   resize. macOS: transparent, vibrancy, panel, all workspaces. Windows: opaque dark surface,
//   on-top level `screen-saver`. Geometry is computed here: collapsed 251 × 162,
//   grown 272 × 296 or the remembered size, 24 px from the bottom right of the work area,
//   anchored at the bottom-right corner, re-clamped on display changes. Ctrl/Cmd+W closes.
// - Collapse: when the main window gains focus and the meeting dock has not been used
//   for USE_GRACE_MS, it collapses back to the minimum.
// - Sender checks: `meeting-dock:*` from the meeting-dock window only, except `show`.

import { app, ipcMain, screen, type BrowserWindow, type Rectangle } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeRes, PushChannel, SendChannel } from '@shared/ipc'
import type { Rect } from '@shared/types/common'
import { MEETING_DOCK_GEOMETRY as G, type MeetingDockHistory, type MeetingDockState, type MeetingDockView } from '@shared/types/meeting-dock'
import type { MainContext, MeetingDockApi } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { watchMainWindow } from '../bubble/main-window'
import { runAHarness } from './dev-harness'
import { egressBlocked } from '../privacy'

const USE_GRACE_MS = 30_000
const VIEWS: readonly MeetingDockView[] = ['chat', 'notes', 'transcript']
/** Notula's dark surface (the Windows window is opaque). */
const DARK_SURFACE = '#1d1d1c'

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

export function registerMeetingDock(ctx: MainContext): MeetingDockApi {
  let win: BrowserWindow | null = null
  let enabled = false
  let state: MeetingDockState = { noteId: null, captureState: 'off', expanded: false, view: 'notes', localOnlyBlocked: false }
  /** Closed by the user for this capture. */
  let hiddenForCapture = false
  let sawChunk = false
  let lastUsedAt = 0
  let rememberedSize: { width: number; height: number } | null = null

  const live = (): BrowserWindow | null => (win && !win.isDestroyed() ? win : null)

  function push(): void {
    const w = live()
    if (w && !w.webContents.isDestroyed()) w.webContents.send('meeting-dock:state' satisfies PushChannel, state)
  }

  function setState(patch: Partial<MeetingDockState>): void {
    state = { ...state, ...patch }
    push()
  }

  async function refreshLocalOnly(): Promise<void> {
    const blocked = await egressBlocked(ctx, { kind: 'llm' }).catch(() => false)
    if (blocked !== state.localOnlyBlocked) setState({ localOnlyBlocked: blocked })
  }

  // ---------- geometry ----------

  function workAreaFor(r: Rect | Rectangle | null): Rectangle {
    if (!r) return screen.getPrimaryDisplay().workArea
    return screen.getDisplayMatching({ x: Math.round(r.x), y: Math.round(r.y), width: Math.max(1, Math.round(r.width)), height: Math.max(1, Math.round(r.height)) }).workArea
  }

  /** Keeps a rect inside its work area, never below the minimum and never above the work area. */
  function clamp(r: Rect, wa: Rectangle): Rectangle {
    const width = Math.round(Math.min(Math.max(r.width, G.minWidth), wa.width))
    const height = Math.round(Math.min(Math.max(r.height, G.minHeight), wa.height))
    const x = Math.round(Math.min(Math.max(r.x, wa.x), wa.x + wa.width - width))
    const y = Math.round(Math.min(Math.max(r.y, wa.y), wa.y + wa.height - height))
    return { x, y, width, height }
  }

  function docked(size: { width: number; height: number }): Rectangle {
    const wa = screen.getPrimaryDisplay().workArea
    return clamp({ x: wa.x + wa.width - size.width - G.margin, y: wa.y + wa.height - size.height - G.margin, ...size }, wa)
  }

  /** Resizes keeping the bottom-right corner where it is. */
  function anchoredResize(size: { width: number; height: number }): void {
    const w = live()
    if (!w) return
    const b = w.getBounds()
    const right = b.x + b.width
    const bottom = b.y + b.height
    w.setBounds(clamp({ x: right - size.width, y: bottom - size.height, ...size }, workAreaFor(b)))
  }

  function grownSize(): { width: number; height: number } {
    return rememberedSize ?? { width: G.grownWidth, height: G.grownHeight }
  }

  function reclamp(): void {
    const w = live()
    if (!w) return
    const b = w.getBounds()
    const next = clamp(b, workAreaFor(b))
    if (next.x !== b.x || next.y !== b.y || next.width !== b.width || next.height !== b.height) w.setBounds(next)
  }

  // ---------- the window ----------

  function create(): BrowserWindow {
    const mac = process.platform === 'darwin'
    const bounds = docked({ width: G.minWidth, height: G.minHeight })
    const w = ctx.windows.createSecondary({
      kind: 'meeting-dock',
      route: '/meeting-dock',
      title: 'Notula meeting dock',
      ...bounds,
      minWidth: G.minWidth,
      minHeight: G.minHeight,
      frame: false,
      resizable: false,
      focusable: true,
      acceptFirstMouse: true,
      alwaysOnTop: true,
      skipTaskbar: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      ...(mac
        ? { transparent: true, backgroundColor: '#00000000', vibrancy: 'under-window' as const, type: 'panel', visualEffectState: 'active' as const }
        : { backgroundColor: DARK_SURFACE })
    })
    if (mac) {
      w.setAlwaysOnTop(true, 'floating')
      w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    } else {
      w.setAlwaysOnTop(true, 'screen-saver')
    }
    // The window keeps its own title.
    w.on('page-title-updated', (e) => e.preventDefault())
    // Ctrl+W (Windows) or Cmd+W (macOS) closes it.
    w.webContents.on('before-input-event', (e, input) => {
      if (input.type === 'keyDown' && input.key.toLowerCase() === 'w' && (mac ? input.meta : input.control) && !input.alt && !input.shift) {
        e.preventDefault()
        hide('shortcut')
      }
    })
    w.on('closed', () => {
      if (win === w) win = null
    })
    w.once('ready-to-show', () => {
      if (w.isDestroyed() || !shouldShow()) return
      // Windows rescales a window created on a display with another scale factor: set it again.
      w.setBounds(docked({ width: G.minWidth, height: G.minHeight }))
      w.showInactive()
    })
    log('info', 'meeting-dock:opened', { noteId: state.noteId })
    return w
  }

  const shouldShow = (): boolean => enabled && state.noteId !== null && state.captureState !== 'off' && !hiddenForCapture

  function open(): void {
    if (!shouldShow()) return
    const w = live()
    if (!w) {
      state = { ...state, expanded: false, view: 'notes' }
      win = create()
      return
    }
    if (!w.isVisible()) {
      w.setBounds(docked({ width: G.minWidth, height: G.minHeight }))
      state = { ...state, expanded: false }
      w.showInactive()
    }
    push()
  }

  function hide(why: string): void {
    hiddenForCapture = true
    const w = live()
    if (w?.isVisible()) w.hide()
    log('info', 'meeting-dock:hidden', { why })
  }

  function destroy(): void {
    const w = live()
    win = null
    if (w) w.destroy()
  }

  // ---------- lifecycle ----------

  async function onCaptureStarted(noteId: string): Promise<void> {
    if (state.noteId !== noteId || state.captureState === 'off') {
      // A new transcription session mounts it afresh.
      hiddenForCapture = false
      destroy()
    }
    sawChunk = ctx.transcription.liveChunks(noteId).length > 0
    setState({ noteId, captureState: sawChunk ? 'on' : 'starting' })
    await refreshLocalOnly()
    open()
  }

  function onCaptureStopped(noteId: string, reason: string): void {
    if (state.noteId !== noteId) return
    if (reason === 'system_sleep') {
      setState({ captureState: 'paused' })
      return
    }
    setState({ noteId: null, captureState: 'off' })
    hiddenForCapture = false
    destroy()
  }

  ctx.bus.on('capture:started', (e) => void onCaptureStarted(e.noteId))
  ctx.bus.on('capture:stopped', (e) => onCaptureStopped(e.noteId, e.reason))
  ctx.bus.on('transcript:changed', (e) => {
    if (sawChunk || e.noteId !== state.noteId || e.upserted.length === 0) return
    sawChunk = true
    if (state.captureState === 'starting') setState({ captureState: 'on' })
  })
  ctx.bus.on('settings:changed', (e) => {
    if (e.keys.includes('meetingDock.enabled')) {
      enabled = e.settings['meetingDock.enabled']
      const noteId = ctx.capture.currentNoteId()
      if (!enabled) destroy()
      else if (ctx.capture.isCapturing() && noteId) void onCaptureStarted(noteId)
    }
    if (e.keys.includes('meetingDock.size')) rememberedSize = e.settings['meetingDock.size']
    if (e.keys.some((k) => k === 'privacy.localOnly' || k.startsWith('llm.'))) void refreshLocalOnly()
  })
  void ctx.settings
    .getAll()
    .then((all) => {
      enabled = all['meetingDock.enabled']
      rememberedSize = all['meetingDock.size']
      const noteId = ctx.capture.currentNoteId()
      if (enabled && ctx.capture.isCapturing() && noteId) void onCaptureStarted(noteId)
    })
    .catch((err: unknown) => log('warn', 'meeting-dock:settings-failed', { err }))

  for (const ev of ['display-metrics-changed', 'display-added', 'display-removed'] as const) {
    screen.on(ev as 'display-added', () => setImmediate(reclamp))
  }

  // Collapse when the main window regains focus and the meeting dock was not in use.
  watchMainWindow(ctx, {
    attached: (main) => {
      main.on('focus', () => {
        const w = live()
        if (!w || !state.expanded || w.isFocused() || Date.now() - lastUsedAt < USE_GRACE_MS) return
        anchoredResize({ width: G.minWidth, height: G.minHeight })
        setState({ expanded: false })
      })
    },
    closed: () => {}
  })

  // ---------- IPC ----------

  const fromDock = (sender: Electron.WebContents): boolean => ctx.windows.kindOf(sender) === 'meeting-dock'
  const used = (): void => {
    lastUsedAt = Date.now()
  }

  ipcMain.handle('meeting-dock:show' satisfies InvokeChannel, async (e): Promise<InvokeRes<'meeting-dock:show'>> => {
    if (ctx.windows.kindOf(e.sender) === null) return
    await api.show()
  })

  ipcMain.handle('meeting-dock:close' satisfies InvokeChannel, (e): InvokeRes<'meeting-dock:close'> => {
    if (!fromDock(e.sender)) return
    hide('close')
  })

  ipcMain.on('meeting-dock:set-bounds' satisfies SendChannel, (e, p: unknown) => {
    if (!fromDock(e.sender)) return
    const w = live()
    if (!w || !isObject(p)) return
    const r = { x: Number(p['x']), y: Number(p['y']), width: Number(p['width']), height: Number(p['height']) }
    if (![r.x, r.y, r.width, r.height].every(Number.isFinite)) return
    used()
    const before = w.getBounds()
    const next = clamp(r, workAreaFor(r))
    w.setBounds(next)
    // A size chosen by resizing is remembered for later growth.
    if (next.width !== before.width || next.height !== before.height) {
      rememberedSize = { width: Math.min(next.width, 2_000), height: Math.min(next.height, 2_000) }
      if (!state.expanded) setState({ expanded: true })
      scheduleSizeSave()
    }
  })

  let sizeTimer: NodeJS.Timeout | null = null
  function scheduleSizeSave(): void {
    if (sizeTimer) clearTimeout(sizeTimer)
    sizeTimer = setTimeout(() => {
      sizeTimer = null
      if (rememberedSize) void ctx.settings.set('meetingDock.size', rememberedSize).catch((err: unknown) => log('warn', 'meeting-dock:size-save-failed', { err }))
    }, 500)
  }

  ipcMain.on('meeting-dock:set-view' satisfies SendChannel, (e, p: unknown) => {
    if (!fromDock(e.sender) || !isObject(p)) return
    const view = VIEWS.includes(p['view'] as MeetingDockView) ? (p['view'] as MeetingDockView) : state.view
    const expanded = p['expanded'] === true
    used()
    if (expanded !== state.expanded) anchoredResize(expanded ? grownSize() : { width: G.minWidth, height: G.minHeight })
    setState({ expanded, view })
  })

  ipcMain.handle('meeting-dock:get-state' satisfies InvokeChannel, async (e): Promise<InvokeRes<'meeting-dock:get-state'>> => {
    if (!fromDock(e.sender)) throw expected(notulaError('invalid-input', 'Not the meeting dock'))
    await refreshLocalOnly()
    return state
  })

  ipcMain.handle('meeting-dock:history-get' satisfies InvokeChannel, async (e, p: unknown): Promise<InvokeRes<'meeting-dock:history-get'>> => {
    if (!fromDock(e.sender)) throw expected(notulaError('invalid-input', 'Not the meeting dock'))
    const noteId = isObject(p) && typeof p['noteId'] === 'string' ? p['noteId'] : ''
    if (!noteId) throw expected(notulaError('invalid-input', 'noteId is required'))
    return ctx.storage.getMeetingDockHistory(noteId)
  })

  ipcMain.handle('meeting-dock:history-save' satisfies InvokeChannel, async (e, p: unknown): Promise<InvokeRes<'meeting-dock:history-save'>> => {
    if (!fromDock(e.sender)) throw expected(notulaError('invalid-input', 'Not the meeting dock'))
    if (!isObject(p) || typeof p['noteId'] !== 'string') throw expected(notulaError('invalid-input', 'noteId is required'))
    used()
    await ctx.storage.saveMeetingDockHistory(p as unknown as MeetingDockHistory)
  })

  // Dev only: the assistants' smoke harness (dev-harness.ts), started once the context is wired.
  if (!app.isPackaged && process.env['NOTULA_DEV_A_HARNESS'] === '1') setTimeout(() => void runAHarness(ctx), 3_000)

  const api: MeetingDockApi = {
    isAvailable: () => enabled && state.noteId !== null && state.captureState !== 'off' && !live()?.isVisible(),
    show: async () => {
      if (!enabled || state.noteId === null || state.captureState === 'off') return
      hiddenForCapture = false
      open()
    }
  }
  return api
}
