// SPDX-License-Identifier: Apache-2.0
// The dictation bar: the always-visible bar mode of the dictation pill
// window, and its `dictation-bar:*` IPC. registerDictation owns the window and the dictation session; this owns
// what the bar adds.
//
// - Shown while `dictationBar.enabled` is on inside the armed Voice typing gate, unless snoozed
//   (`dictationBar.snoozeUntil`) or the foreground window fills the bar's display (polled through
//   notula-desk every 2 s). A dictation in progress always shows.
// - Placement: bottom centre of the primary display's work area (the window's bottom edge; the
//   bar draws 12 DIP above it), plus a per-display x offset kept in `<userData>/dictation-bar.json`
//   (main-local, never synced). Drag is horizontal; double-click resets the offset.
// - Click-through: the renderer reports its interactive rectangles and its hover; main
//   lets the mouse in only while the cursor is inside one of them.
// - Buttons: mic (the session's hands-free toggle, from registerDictation), record (a new note
//   with transcription, or stop the running capture), notes (the Scratchpad, or the live note).
// - The chevron / right-click menu is an in-app panel in a transparent, non-focusable overlay over
//   the bar's display; a click outside the panel lands on the overlay
//   and closes it. The tray item lives in the tray module.

import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { screen, systemPreferences, type BrowserWindow } from 'electron'
import type { PushChannel } from '@shared/ipc'
import type { DictationState } from '@shared/types/dictation'
import { DICTATION_BAR_LIMITS as BAR, type DictationBarAction, type DictationBarCaptureReady, type DictationBarMenu, type DictationBarMenuEntry, type DictationBarMode, type DictationBarRect, type DictationBarState } from '@shared/types/dictation-bar'
import { DICTATION_LIMITS as L } from '@shared/types/dictation'
import type { Settings } from '@shared/types/settings'
import type { MainContext } from '../context'
import { openSettingsSection, requestNewNote, showMainWindow } from '../lifecycle'
import { log } from '../log'
import type { Desk } from './desk'

export interface DictationBarDeps {
  ctx: MainContext
  desk: Desk
  pill(): BrowserWindow | null
  dictation(): DictationState
  /** The mic button. */
  dictate(): void
  /** Display strings for the keytips. */
  keytips(): DictationBarState['shortcuts']
}

export class DictationBar {
  private armed = false
  private settings: Settings | null = null
  private hovered = false
  private rects: DictationBarRect[] = []
  private dragging: { startX: number; startScreenX: number } | null = null
  private fullscreen = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private snoozeTimer: ReturnType<typeof setTimeout> | null = null
  private capture: { noteId: string; since: string } | null = null
  private captureReady: DictationBarCaptureReady = 'ready'
  private offsets: Record<string, number> = {}
  private error: { text: string; timer: ReturnType<typeof setTimeout> } | null = null
  private menuWin: BrowserWindow | null = null
  private menuOpen = false
  private menuPoll: ReturnType<typeof setInterval> | null = null
  private menuHide: ReturnType<typeof setTimeout> | null = null
  private synced = false
  private readonly file: string

  constructor(private readonly d: DictationBarDeps) {
    this.file = join(d.ctx.userDataPath, 'dictation-bar.json')
    try {
      const raw = JSON.parse(readFileSync(this.file, 'utf8')) as { offsets?: Record<string, unknown> }
      for (const [k, v] of Object.entries(raw.offsets ?? {})) if (typeof v === 'number' && Number.isFinite(v)) this.offsets[k] = v
    } catch {
      /* first run */
    }
    d.ctx.bus.on('capture:started', (e) => {
      this.capture = { noteId: e.noteId, since: e.startedAt }
      this.refresh()
    })
    d.ctx.bus.on('capture:stopped', () => {
      this.capture = null
      this.refresh()
    })
  }

  private watching = false
  /** `screen` is usable only once the app is ready, which arming implies. */
  private watchDisplays(): void {
    if (this.watching) return
    this.watching = true
    const replace = (): void => {
      const w = this.d.pill()
      if (w?.isVisible() && this.enabled()) this.place(w)
    }
    screen.on('display-metrics-changed', replace)
    screen.on('display-removed', replace)
    screen.on('display-added', replace)
  }

  // ---------- state ----------

  /** Bar mode: on inside the armed gate (the pill behaves as before otherwise). */
  enabled(): boolean {
    return this.armed && (this.settings?.['dictationBar.enabled'] ?? true)
  }

  private snoozed(): boolean {
    const until = this.settings?.['dictationBar.snoozeUntil'] ?? null
    return until !== null && until > Date.now()
  }

  /** The bar itself is up (independent of a dictation in progress). */
  private barShown(): boolean {
    return this.enabled() && !this.snoozed() && !this.fullscreen
  }

  setArmed(on: boolean): void {
    this.armed = on
    if (on) this.watchDisplays()
    if (!on) {
      this.hovered = false
      this.rects = []
      this.dragging = null
      this.closeMenu()
    }
    this.schedule()
  }

  setSettings(s: Settings): void {
    this.settings = s
    this.schedule()
  }

  /** A short error line in the bar (`error`, 4 s). */
  flash(text: string): void {
    if (this.error) clearTimeout(this.error.timer)
    this.error = {
      text,
      timer: setTimeout(() => {
        this.error = null
        this.refresh()
      }, BAR.errorMs)
    }
    this.refresh()
  }

  private readiness(): DictationBarCaptureReady {
    if (process.platform !== 'win32' && process.platform !== 'darwin') return 'unavailable'
    const mic = systemPreferences.getMediaAccessStatus('microphone')
    return mic === 'denied' || mic === 'restricted' ? 'permission' : 'ready'
  }

  private state(): DictationBarState {
    const dict = this.d.dictation()
    const active = dict.kind !== 'idle'
    let mode: DictationBarMode
    if (!this.barShown() && !active) mode = 'hidden'
    else if (dict.kind === 'recording') mode = dict.handsFree ? 'handsFree' : 'hold'
    else if (dict.kind === 'processing') mode = 'processing'
    else if (dict.kind === 'error' || this.error) mode = 'error'
    else if (this.capture) mode = 'recording'
    else mode = this.hovered || this.menuOpen ? 'ready' : 'resting'
    return {
      enabled: this.enabled(),
      layout: active || this.capture ? 'wide' : 'compact',
      mode,
      captureReady: this.captureReady,
      shortcuts: this.d.keytips(),
      recordingSince: this.capture?.since ?? null,
      notes: !!this.capture || this.settings?.['scratchpad.enabled'] === true,
      ...(this.error ? { error: this.error.text } : {})
    }
  }

  /** Pushes the bar state and shows or hides the window. Returns whether the window should be up. */
  refresh(): boolean {
    const w = this.d.pill()
    this.captureReady = this.readiness()
    const active = this.d.dictation().kind !== 'idle'
    const up = active || this.barShown()
    if (this.menuOpen && (!up || active || this.capture)) this.closeMenu()
    if (!w) return up
    // The menu overlay loads while the bar is up, so the first chevron click finds it mounted.
    if (up && this.enabled()) this.overlay()
    w.webContents.send('dictation-bar:state' satisfies PushChannel, this.state())
    if (up && !w.isVisible()) {
      this.place(w)
      w.showInactive()
    } else if (!up && w.isVisible()) {
      w.hide()
      this.hovered = false
      w.setIgnoreMouseEvents(true, { forward: true })
    }
    return up
  }

  /** Timers that follow the settings: the snooze expiry and the full-screen poll. */
  private schedule(): void {
    if (this.snoozeTimer) clearTimeout(this.snoozeTimer)
    this.snoozeTimer = null
    const until = this.settings?.['dictationBar.snoozeUntil'] ?? null
    if (this.enabled() && until !== null && until > Date.now()) {
      this.snoozeTimer = setTimeout(() => this.refresh(), Math.min(until - Date.now() + 50, 2_147_000_000))
    }
    const poll = this.enabled() && !this.snoozed() && process.platform === 'win32'
    if (poll && !this.pollTimer) {
      this.pollTimer = setInterval(() => void this.pollFullscreen(), BAR.fullscreenPollMs)
    } else if (!poll && this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
      this.fullscreen = false
    }
    this.refresh()
  }

  private async pollFullscreen(): Promise<void> {
    const at = await this.d.desk.fullscreen().catch(() => null)
    let full = false
    if (at) {
      const dip = screen.screenToDipPoint({ x: at.x + 1, y: at.y + 1 })
      full = screen.getDisplayNearestPoint(dip).id === this.display().id
    }
    if (full !== this.fullscreen) {
      this.fullscreen = full
      log('debug', 'dictation-bar:fullscreen', { full })
      this.refresh()
    }
  }

  // ---------- placement and drag ----------

  private display(): Electron.Display {
    return screen.getPrimaryDisplay()
  }

  private centreX(d: Electron.Display): number {
    return Math.round(d.workArea.x + (d.workArea.width - L.pill.width) / 2)
  }

  private clampX(d: Electron.Display, x: number): number {
    const wa = d.workArea
    return Math.max(wa.x, Math.min(wa.x + wa.width - L.pill.width, Math.round(x)))
  }

  place(w: BrowserWindow): void {
    const d = this.display()
    const wa = d.workArea
    const x = this.clampX(d, this.centreX(d) + (this.offsets[String(d.id)] ?? 0))
    w.setBounds({ x, y: wa.y + wa.height - L.pill.height, width: L.pill.width, height: L.pill.height })
  }

  private saveOffsets(): void {
    void writeFile(this.file, JSON.stringify({ offsets: this.offsets }), 'utf8').catch((err: unknown) =>
      log('warn', 'dictation-bar:save-failed', { err: err instanceof Error ? err.name : 'error' })
    )
  }

  drag(phase: 'start' | 'move' | 'end', screenX: number): void {
    const w = this.d.pill()
    if (!w || !this.enabled() || !Number.isFinite(screenX)) return
    if (phase === 'start') {
      this.dragging = { startX: w.getBounds().x, startScreenX: screenX }
      w.setIgnoreMouseEvents(false)
      return
    }
    const g = this.dragging
    if (!g) return
    const d = this.display()
    const x = this.clampX(d, g.startX + (screenX - g.startScreenX))
    const b = w.getBounds()
    if (x !== b.x) w.setBounds({ ...b, x })
    if (phase === 'end') {
      this.dragging = null
      this.offsets[String(d.id)] = x - this.centreX(d)
      this.saveOffsets()
      log('debug', 'dictation-bar:dropped', { offset: this.offsets[String(d.id)] })
    }
  }

  private resetPosition(): void {
    delete this.offsets[String(this.display().id)]
    this.saveOffsets()
    const w = this.d.pill()
    if (w) this.place(w)
  }

  // ---------- click-through ----------

  /** The pill page (re)loaded: its first rect report is its "ready" (the route mounts lazily). */
  pageLoaded(): void {
    this.synced = false
  }

  setRects(rects: DictationBarRect[]): void {
    if (!this.synced) {
      this.synced = true
      this.refresh()
    }
    this.rects = rects
      .filter((r) => [r.x, r.y, r.width, r.height].every((n) => typeof n === 'number' && Number.isFinite(n)))
      .slice(0, 16)
    log('debug', 'dictation-bar:hit-rects', { rects: this.rects })
  }

  /** The renderer's hover report: lets the mouse in only inside a reported rectangle. */
  hover(hovered: boolean): void {
    const w = this.d.pill()
    if (!w) return
    if (this.dragging) return
    const inside = hovered && this.cursorInside(w)
    w.setIgnoreMouseEvents(!inside, { forward: true })
    log('debug', 'dictation-bar:hover', { hovered, inside })
    if (inside !== this.hovered) {
      this.hovered = inside
      this.refresh()
    }
  }

  private cursorInside(w: BrowserWindow): boolean {
    const p = screen.getCursorScreenPoint()
    const b = w.getBounds()
    const x = p.x - b.x
    const y = p.y - b.y
    const pad = 6
    return this.rects.some((r) => x >= r.x - pad && x <= r.x + r.width + pad && y >= r.y - pad && y <= r.y + r.height + pad)
  }

  // ---------- actions ----------

  /** `anchorX`: the opener's centre x in the pill window, for the menu. */
  action(a: DictationBarAction, anchorX?: number): void {
    switch (a) {
      case 'dictate':
        return this.d.dictate()
      case 'record':
        return this.toggleRecord()
      case 'notes':
        return this.openNotes()
      case 'menu':
        return this.menu(anchorX)
      case 'snooze':
        return void this.d.ctx.settings.set('dictationBar.snoozeUntil', Date.now() + BAR.snoozeMs)
      case 'hide':
        return void this.d.ctx.settings.set('dictationBar.enabled', false)
      case 'reset-position':
        return this.resetPosition()
    }
  }

  /** Start a new note with transcription, or stop the running capture. */
  toggleRecord(): void {
    if (this.d.ctx.capture.isCapturing()) {
      log('info', 'dictation-bar:record-stop')
      void this.d.ctx.capture.stop('indicator_stop_button')
      return
    }
    if (this.d.dictation().kind === 'recording' || this.d.dictation().kind === 'processing') {
      // Dictation and capture both want the microphone; never interrupt.
      this.flash('Finish dictating first')
      return
    }
    if (this.captureReady === 'permission') {
      this.flash('Notula can’t use your mic')
      return
    }
    log('info', 'dictation-bar:record-start')
    requestNewNote('dictation_bar', { autoTranscribe: true })
  }

  /** The Scratchpad, or the live note while capturing (`bubble:open-note` behaviour). */
  openNotes(scratchpadOnly = false): void {
    const noteId = scratchpadOnly ? null : this.d.ctx.capture.currentNoteId()
    const main = showMainWindow()
    if (!main) return
    if (noteId) {
      if (this.d.ctx.ui.viewingNoteId() === noteId) return
      main.webContents.send('deeplink:received' satisfies PushChannel, { type: 'show-note', data: { documentId: noteId, openSource: 'bubble_open_document' } })
      return
    }
    main.webContents.send('deeplink:received' satisfies PushChannel, { type: 'open', data: { path: '/scratchpad' } })
  }

  // ---------- the menu ----------

  /** The overlay the menu draws in: the bar display's work area, transparent and never focused. */
  private overlay(): BrowserWindow {
    if (this.menuWin && !this.menuWin.isDestroyed()) return this.menuWin
    const mac = process.platform === 'darwin'
    const w = this.d.ctx.windows.createSecondary({
      kind: 'dictation-bar-menu',
      route: '/dictation-bar-menu',
      title: 'Dictation bar menu',
      width: 400,
      height: 300,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      focusable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      frame: false,
      transparent: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      ...(mac ? { type: 'panel', hiddenInMissionControl: true } : {})
    })
    w.setAlwaysOnTop(true, 'screen-saver')
    w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    w.setContentProtection(true)
    w.setIgnoreMouseEvents(true)
    w.on('closed', () => {
      if (this.menuWin !== w) return
      this.menuWin = null
      this.menuOpen = false
    })
    this.menuWin = w
    return w
  }

  private menuItems(): DictationBarMenuEntry[] {
    const capturing = this.d.ctx.capture.isCapturing()
    const mic = this.settings?.['dictation.microphone'] ?? null
    const micLabel = mic && mic !== 'system-default' ? mic.label || 'Selected microphone' : 'System default'
    const items: DictationBarMenuEntry[] = [
      capturing ? { kind: 'item', id: 'record', label: 'Stop recording', icon: 'stop' } : { kind: 'item', id: 'record', label: 'Start recording', icon: 'record' },
      {
        kind: 'item',
        id: 'mic',
        label: 'Choose microphone',
        icon: 'mic',
        submenu: [
          { kind: 'item', id: 'mic-current', label: micLabel, checked: true },
          { kind: 'separator' },
          { kind: 'item', id: 'mic-settings', label: 'Microphone settings…', icon: 'settings' }
        ]
      }
    ]
    if (this.settings?.['scratchpad.enabled']) items.push({ kind: 'item', id: 'scratchpad', label: 'Open scratchpad', icon: 'notes' })
    items.push(
      { kind: 'separator' },
      { kind: 'item', id: 'snooze', label: 'Hide for 1 hour', icon: 'snooze' },
      { kind: 'item', id: 'hide', label: 'Hide bar', icon: 'hide' },
      { kind: 'separator' },
      { kind: 'item', id: 'settings', label: 'Settings…', icon: 'settings' }
    )
    return items
  }

  /** The chevron toggles the menu. It opens upward, centred on the opener, 6 px above the bar. */
  private menu(anchorX?: number): void {
    if (this.menuOpen) return this.closeMenu()
    const pill = this.d.pill()
    if (!pill?.isVisible()) return
    const w = this.overlay()
    if (w.webContents.isLoading()) {
      w.webContents.once('did-finish-load', () => setTimeout(() => this.menu(anchorX), 250))
      return
    }
    const d = this.display()
    const wa = d.workArea
    // Windows: 2 px short of the work area.
    const area = { x: wa.x, y: wa.y, width: wa.width, height: wa.height - (process.platform === 'win32' ? 2 : 0) }
    const b = pill.getBounds()
    const panelBottom = b.y + b.height - BAR.bottomGapDip - BAR.barHeightPx - BAR.menuGapPx
    const menu: DictationBarMenu = {
      open: true,
      items: this.menuItems(),
      anchor: { x: b.x + (anchorX ?? b.width / 2) - area.x, bottom: area.y + area.height - panelBottom }
    }
    if (this.menuHide) clearTimeout(this.menuHide)
    this.menuHide = null
    w.setBounds(area)
    w.setIgnoreMouseEvents(false)
    w.webContents.send('dictation-bar:menu' satisfies PushChannel, menu)
    if (!w.isVisible()) w.showInactive()
    w.moveTop()
    this.menuOpen = true
    log('debug', 'dictation-bar:menu-open')
    this.refresh()
    this.menuPoll = setInterval(() => {
      if (screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id !== d.id) this.closeMenu()
    }, BAR.menuDisplayPollMs)
  }

  /** Closes at once (no exit motion). The bar stays expanded only while the cursor is on it. */
  private closeMenu(): void {
    if (!this.menuOpen) return
    this.menuOpen = false
    if (this.menuPoll) clearInterval(this.menuPoll)
    this.menuPoll = null
    const w = this.menuWin
    if (w && !w.isDestroyed()) {
      w.setIgnoreMouseEvents(true)
      const closed: DictationBarMenu = { open: false, items: [], anchor: { x: 0, bottom: 0 } }
      w.webContents.send('dictation-bar:menu' satisfies PushChannel, closed)
      // Hide once the empty frame has painted, so the next open never flashes the old panel.
      this.menuHide = setTimeout(() => {
        this.menuHide = null
        if (!this.menuOpen && !w.isDestroyed()) w.hide()
      }, 150)
    }
    log('debug', 'dictation-bar:menu-closed')
    setTimeout(() => {
      if (this.menuOpen) return
      const pill = this.d.pill()
      if (pill && !this.cursorInside(pill)) {
        this.hovered = false
        pill.setIgnoreMouseEvents(true, { forward: true })
      }
      this.refresh()
    }, BAR.menuCollapseMs)
  }

  /** From the overlay: a row, or null for a click outside the panel. */
  menuPick(id: string | null): void {
    if (!this.menuOpen) return
    this.closeMenu()
    switch (id) {
      case 'record':
        return this.toggleRecord()
      case 'scratchpad':
        return this.openNotes(true)
      case 'snooze':
      case 'hide':
        return this.action(id)
      case 'settings':
      case 'mic-settings':
        return openSettingsSection('voice-typing', 'dictation-bar')
    }
  }
}
