// SPDX-License-Identifier: Apache-2.0
// registerScreenCapture(): screenshots to notes (Labs `screenCapture.enabled`, Windows and
// macOS) and the `screen-capture:*` IPC.
//
// - While the switch is on, main holds the global shortcut `ctx.shortcuts.effective('screenCapture')`
//   (`screenCapture.shortcut`, default CommandOrControl+Shift+2) through the shortcut
//   registry, whose clash check refuses another Notula shortcut. Off unregisters it.
// - A press while voice typing records or processes does nothing (`screen-capture:skipped-dictation`).
//   So does a press while Notula is locked.
// - A grab hides Notula's visible windows, waits 200 ms, then runs the snapshot overlay on
//   the display under the cursor: a dragged region, or (Space) a window from its list,
//   grabbed at full size. Escape keeps nothing. Without Screen Recording permission on
//   macOS the screen guide opens instead.
// - Each image is scaled to fit 1,600 px and encoded as JPEG at quality 0.85, in memory.
//   The panel (kind `screen-capture`, 560 × 140, centred 16 px above the work area's
//   bottom) holds up to 4 with an optional note; nothing touches the disk before Save.
// - Save goes to the note being transcribed, else the note open in the main window, else a
//   new "Screenshots <date and time>" note, as ordinary encrypted note images counted toward
//   the 10-image limit, each with its `capture` details. Without room, nothing is added.
// - The source app and window title come from the foreground-app reader voice typing uses;
//   no text is read from other apps. Logs carry no image bytes and no note text.

import { randomUUID } from 'node:crypto'
import { basename } from 'node:path'
import { app, BrowserWindow, globalShortcut, ipcMain, screen, type NativeImage, type WebContents } from 'electron'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel, SendChannel, SendPayload } from '@shared/ipc'
import { ATTACHMENT_LIMITS, CAPTURE_NOTE_MAX, type AttachmentCapture } from '@shared/types/attachments'
import type { IsoTime } from '@shared/types/common'
import {
  SCREEN_CAPTURE_LIMITS as L,
  type ScreenCaptureMode,
  type ScreenCaptureSaveResult,
  type ScreenCaptureState,
  type ScreenCaptureTakeResult
} from '@shared/types/screen-capture'
import type { MainContext } from '../context'
import { dictationBusy } from '../dictation/activity'
import { Desk } from '../dictation/desk'
import { showMainWindow } from '../lifecycle'
import { log } from '../log'
import { fit } from '../snapshots/frames'
import { regionSnapshots } from '../snapshots/region'

const SUPPORTED = process.platform === 'win32' || process.platform === 'darwin'
const FOREGROUND_TIMEOUT_MS = 500

interface Shot {
  jpeg: Buffer
  preview: string
  width: number
  height: number
  mode: ScreenCaptureMode
  sourceApp: string | null
  sourceTitle: string | null
}

interface Session {
  id: string
  /** The first grab: every image of one capture shares it. */
  capturedAt: IsoTime
  shots: Shot[]
  /** The app in front when the shortcut was pressed. */
  source: { app: string | null; title: string | null }
  grabbing: boolean
  saving: boolean
  /** Saved: the panel only shows where the images went. */
  saved: boolean
}

const validId = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 200

/** Notula itself in front (the main window, a dev run) is not a source. */
function appName(raw: string): string | null {
  const own = basename(process.execPath).toLowerCase()
  const name = raw.trim()
  if (!name || name.toLowerCase() === own) return null
  return name.replace(/\.exe$/i, '').slice(0, 200)
}

export function registerScreenCapture(ctx: MainContext): void {
  let enabled = false
  let registered: string | null = null
  let session: Session | null = null
  let panel: BrowserWindow | null = null
  let desk: Desk | null = null

  const alive = (w: BrowserWindow | null): w is BrowserWindow => w !== null && !w.isDestroyed()
  const fromPanel = (wc: WebContents): boolean => alive(panel) && panel.webContents.id === wc.id
  const ours = (captureId: unknown): Session | null => (session && captureId === session.id ? session : null)

  const stateOf = (s: Session): ScreenCaptureState => ({
    captureId: s.id,
    images: s.shots.map((x) => ({ preview: x.preview, width: x.width, height: x.height, mode: x.mode }))
  })

  // ---------- the source app ----------

  async function foreground(): Promise<{ app: string | null; title: string | null }> {
    if (!desk) desk = new Desk()
    const timeout = new Promise<null>((r) => setTimeout(() => r(null), FOREGROUND_TIMEOUT_MS))
    const fg = await Promise.race([desk.foreground(FOREGROUND_TIMEOUT_MS).catch(() => null), timeout])
    if (!fg) return { app: null, title: null }
    const name = appName(fg.process)
    return { app: name, title: name ? fg.title.trim().slice(0, 1_000) || null : null }
  }

  // ---------- the panel ----------

  function ensurePanel(captureId: string): BrowserWindow {
    if (alive(panel)) return panel
    const a = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea
    const w = ctx.windows.createSecondary({
      kind: 'screen-capture',
      route: `/screen-capture?captureId=${encodeURIComponent(captureId)}`,
      title: 'Screenshot',
      x: Math.round(a.x + (a.width - L.panel.width) / 2),
      y: a.y + a.height - L.panel.height - L.panel.bottomInset,
      width: L.panel.width,
      height: L.panel.height,
      frame: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      roundedCorners: true,
      backgroundColor: '#1c1c1f'
    })
    w.setAlwaysOnTop(true, 'floating')
    w.on('closed', () => {
      if (panel === w) panel = null
    })
    panel = w
    return w
  }

  function showPanel(s: Session): void {
    const w = ensurePanel(s.id)
    const reveal = (): void => {
      if (w.isDestroyed()) return
      w.show()
      w.focus()
      w.webContents.send('screen-capture:open' satisfies PushChannel, { captureId: s.id })
    }
    if (w.webContents.isLoading()) w.once('ready-to-show', reveal)
    else reveal()
  }

  function end(why: string): void {
    session = null
    if (alive(panel)) panel.destroy()
    panel = null
    log('debug', 'screen-capture:closed', { why })
  }

  // ---------- grabbing ----------

  /** Notula's visible windows, hidden for the grab; the returned function shows them again. */
  async function hideOwnWindows(): Promise<() => void> {
    const shown = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.isVisible())
    const focused = shown.find((w) => w.isFocused()) ?? null
    for (const w of shown) w.hide()
    if (shown.length) await new Promise((r) => setTimeout(r, L.hideDelayMs))
    return () => {
      for (const w of shown) {
        if (w.isDestroyed() || w.isVisible()) continue
        if (w === focused) w.show()
        else w.showInactive()
      }
    }
  }

  async function grab(s: Session, mode: ScreenCaptureMode): Promise<ScreenCaptureTakeResult['status']> {
    if (s.shots.length >= L.images) return 'full'
    const region = regionSnapshots()
    if (!region) return 'failed'
    s.grabbing = true
    const restore = await hideOwnWindows()
    try {
      const r = await region.grab(`/screen-capture-region?mode=${mode}`)
      if (r.status === 'cancelled') return 'cancelled'
      if (r.status === 'failed') {
        if (r.error === 'permission-denied') return 'permission-denied'
        log('warn', 'screen-capture:failed', { stage: 'grab', error: r.error })
        return 'failed'
      }
      s.shots.push(encode(r.image, r.mode, r.mode === 'window' ? { app: null, title: r.sourceName?.slice(0, 1_000) ?? null } : s.source))
      return 'added'
    } catch (err) {
      log('warn', 'screen-capture:failed', { stage: 'grab', err })
      return 'failed'
    } finally {
      s.grabbing = false
      restore()
    }
  }

  function encode(image: NativeImage, mode: ScreenCaptureMode, source: { app: string | null; title: string | null }): Shot {
    const fitted = fit(image, L.maxSide)
    const { width, height } = fitted.getSize()
    const preview = fit(fitted, L.previewSide).toJPEG(80).toString('base64')
    return {
      jpeg: fitted.toJPEG(L.jpegQuality),
      preview: `data:image/jpeg;base64,${preview}`,
      width,
      height,
      mode,
      sourceApp: source.app,
      sourceTitle: source.title
    }
  }

  /** The shortcut: a new capture, or another image for the open one. */
  async function press(): Promise<void> {
    if (!enabled) return
    if (dictationBusy()) {
      log('info', 'screen-capture:skipped-dictation')
      return
    }
    if (ctx.deviceLock.isLocked()) return
    // A saved capture is done: the shortcut starts the next one.
    if (session?.saved) end('next-capture')
    if (session) {
      if (session.grabbing || session.saving) return
      const s = session
      await grab(s, 'region')
      if (session === s) showPanel(s)
      return
    }
    const s: Session = { id: randomUUID(), capturedAt: new Date().toISOString(), shots: [], source: { app: null, title: null }, grabbing: false, saving: false, saved: false }
    session = s
    log('info', 'screen-capture:opened')
    s.source = await foreground()
    const status = await grab(s, 'region')
    if (session !== s) return
    if (s.shots.length === 0) {
      end(status)
      return
    }
    showPanel(s)
  }

  // ---------- saving ----------

  /** The note being transcribed, else the note open in the main window, else none. */
  async function destination(): Promise<{ id: string; title: string } | null> {
    for (const id of [ctx.capture.isCapturing() ? ctx.capture.currentNoteId() : null, ctx.ui.viewingNoteId()]) {
      if (!id) continue
      const note = await ctx.storage.getNote(id).catch(() => null)
      if (note && !note.deleted_at) return { id: note.id, title: note.title?.trim() || 'Untitled' }
    }
    return null
  }

  async function room(noteId: string): Promise<number> {
    const rows = await ctx.storage.listAttachments({ parentType: 'note', parentId: noteId })
    return ATTACHMENT_LIMITS.noteImages - rows.filter((a) => a.kind === 'image' && a.counted).length
  }

  async function save(s: Session, rawNote: string): Promise<ScreenCaptureSaveResult> {
    if (s.shots.length === 0 || s.saving || s.grabbing || s.saved) return { status: 'failed' }
    s.saving = true
    const note = rawNote.trim() ? rawNote.trim().slice(0, CAPTURE_NOTE_MAX) : null
    const added: string[] = []
    try {
      let target = await destination()
      let created = false
      if (target) {
        const left = await room(target.id)
        if (left < s.shots.length) return { status: 'limit', room: Math.max(0, left) }
      } else {
        const when = new Intl.DateTimeFormat(app.getLocale() || undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(s.capturedAt))
        const n = await ctx.storage.createNote({
          origin: 'unknown',
          title: `Screenshots ${when}`,
          transcribe: false,
          created_via: process.platform === 'darwin' ? 'macOS' : 'Windows'
        })
        target = { id: n.id, title: n.title ?? 'Screenshots' }
        created = true
      }
      const stamp = s.capturedAt.slice(11, 19).replace(/:/g, '.')
      for (const [i, shot] of s.shots.entries()) {
        const capture: AttachmentCapture = {
          captured_at: s.capturedAt,
          mode: shot.mode,
          note,
          source_app: shot.sourceApp,
          source_title: shot.sourceTitle
        }
        const a = await ctx.attachments.addNoteImage(
          target.id,
          { bytes: shot.jpeg, mimeType: 'image/jpeg', fileName: `Screenshot ${stamp}${s.shots.length > 1 ? ` (${i + 1})` : ''}.jpg` },
          { countTowardLimit: true, capture }
        )
        added.push(a.id)
      }
      log('info', 'screen-capture:saved', { noteId: target.id, images: added.length, created, withNote: note !== null })
      return { status: 'saved', noteId: target.id, title: target.title, created }
    } catch (err) {
      // All or nothing: a capture is never split across a failure.
      for (const id of added) await ctx.attachments.remove(id).catch(() => undefined)
      log('warn', 'screen-capture:failed', { stage: 'save', err })
      return { status: 'failed' }
    } finally {
      s.saving = false
    }
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
      ok = globalShortcut.register(accelerator, () => void press())
    } catch (err) {
      log('warn', 'screen-capture:shortcut-failed', { accelerator, err: err instanceof Error ? err.message : String(err) })
      return { ok: false, error: 'That shortcut can’t be used.' }
    }
    if (!ok) {
      log('warn', 'screen-capture:shortcut-failed', { accelerator })
      return { ok: false, error: 'This shortcut is used by another app.' }
    }
    registered = accelerator
    return { ok: true, error: null }
  }

  function apply(on: boolean): void {
    enabled = on && SUPPORTED
    if (enabled) {
      register(ctx.shortcuts.effective('screenCapture'))
      return
    }
    unregister()
    end('disabled')
    desk?.stop()
    desk = null
  }

  ctx.shortcuts.registerApplier('screenCapture', async (accelerator) => {
    if (!enabled) return { ok: true, error: null }
    const previous = registered
    const r = register(accelerator)
    if (!r.ok && previous) register(previous)
    return r
  })

  void app.whenReady().then(async () => {
    try {
      apply((await ctx.settings.get('screenCapture.enabled')) === true)
    } catch (err) {
      log('warn', 'screen-capture:read-failed', { err })
    }
  })
  ctx.bus.on('settings:changed', (e) => {
    if (e.keys.includes('screenCapture.enabled')) apply(e.settings['screenCapture.enabled'] === true)
    else if (e.keys.includes('screenCapture.shortcut') && enabled) {
      const next = ctx.shortcuts.effective('screenCapture')
      if (next !== registered) register(next)
    }
  })
  app.on('will-quit', () => {
    unregister()
    desk?.stop()
  })

  // ---------- IPC: the panel ----------

  ipcMain.handle('screen-capture:get-state' satisfies InvokeChannel, (e, req: InvokeReq<'screen-capture:get-state'>): InvokeRes<'screen-capture:get-state'> => {
    const s = fromPanel(e.sender) ? ours(req?.captureId) : null
    return s ? stateOf(s) : null
  })

  ipcMain.handle(
    'screen-capture:take' satisfies InvokeChannel,
    async (e, req: InvokeReq<'screen-capture:take'>): Promise<InvokeRes<'screen-capture:take'>> => {
      const s = fromPanel(e.sender) ? ours(req?.captureId) : null
      if (!s) return { status: 'failed', state: { captureId: validId(req?.captureId) ? req.captureId : '', images: [] } }
      const mode: ScreenCaptureMode = req.mode === 'window' ? 'window' : 'region'
      if (s.grabbing || s.saving || s.saved) return { status: 'failed', state: stateOf(s) }
      if (dictationBusy()) {
        log('info', 'screen-capture:skipped-dictation')
        return { status: 'cancelled', state: stateOf(s) }
      }
      const status = await grab(s, mode)
      if (session === s && alive(panel)) {
        panel.show()
        panel.focus()
      }
      return { status, state: stateOf(s) }
    }
  )

  ipcMain.handle(
    'screen-capture:remove-image' satisfies InvokeChannel,
    (e, req: InvokeReq<'screen-capture:remove-image'>): InvokeRes<'screen-capture:remove-image'> => {
      const s = fromPanel(e.sender) ? ours(req?.captureId) : null
      if (!s) return { captureId: '', images: [] }
      const i = req.index
      if (Number.isInteger(i) && i >= 0 && i < s.shots.length && !s.saving) s.shots.splice(i, 1)
      return stateOf(s)
    }
  )

  ipcMain.handle(
    'screen-capture:save' satisfies InvokeChannel,
    async (e, req: InvokeReq<'screen-capture:save'>): Promise<InvokeRes<'screen-capture:save'>> => {
      const s = fromPanel(e.sender) ? ours(req?.captureId) : null
      if (!s) return { status: 'failed' }
      const note = typeof req.note === 'string' ? req.note.slice(0, CAPTURE_NOTE_MAX) : ''
      const r = await save(s, note)
      // The saved images leave memory; the panel keeps only its "saved" state.
      if (r.status === 'saved') {
        s.shots = []
        s.saved = true
      }
      return r
    }
  )

  ipcMain.handle('screen-capture:close' satisfies InvokeChannel, (e, req: InvokeReq<'screen-capture:close'>): void => {
    if (fromPanel(e.sender) && ours(req?.captureId)) end('closed')
  })

  ipcMain.handle('screen-capture:open-note' satisfies InvokeChannel, (e, req: InvokeReq<'screen-capture:open-note'>): void => {
    if (!fromPanel(e.sender) || !ours(req?.captureId) || !validId(req.noteId)) return
    end('open-note')
    const main = showMainWindow()
    if (!main || ctx.ui.viewingNoteId() === req.noteId) return
    main.webContents.send('deeplink:received' satisfies PushChannel, { type: 'show-note', data: { documentId: req.noteId, openSource: 'notification' } })
  })

  // ---------- IPC: the overlay's window list ----------

  ipcMain.handle('snapshot-region:list-windows' satisfies InvokeChannel, async (e): Promise<InvokeRes<'snapshot-region:list-windows'>> => {
    const region = regionSnapshots()
    if (!region?.isOverlay(e.sender.id)) return []
    return region.listWindows().catch((err: unknown) => {
      log('warn', 'screen-capture:list-windows-failed', { err })
      return []
    })
  })

  ipcMain.on('snapshot-region:pick-window' satisfies SendChannel, (e, raw: SendPayload<'snapshot-region:pick-window'>) => {
    const region = regionSnapshots()
    if (!region?.isOverlay(e.sender.id)) return
    if (typeof raw?.sourceId === 'string' && raw.sourceId && raw.sourceId.length <= 300) region.pickWindow(raw.sourceId)
  })
}
