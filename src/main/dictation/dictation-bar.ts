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
// - The chevron / right-click menu is a native popup; the tray item lives in the tray module.

import { readFileSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Menu, screen, systemPreferences, type BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import type { PushChannel } from '@shared/ipc'
import type { DictationState } from '@shared/types/dictation'
import { DICTATION_BAR_LIMITS as BAR, type DictationBarAction, type DictationBarCaptureReady, type DictationBarMode, type DictationBarRect, type DictationBarState } from '@shared/types/dictation-bar'
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
  private openMenu: Menu | null = null
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
    else mode = this.hovered ? 'ready' : 'resting'
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
    if (!w) return up
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
    let inside = false
    if (hovered) {
      const p = screen.getCursorScreenPoint()
      const b = w.getBounds()
      const x = p.x - b.x
      const y = p.y - b.y
      const pad = 6
      inside = this.rects.some((r) => x >= r.x - pad && x <= r.x + r.width + pad && y >= r.y - pad && y <= r.y + r.height + pad)
    }
    w.setIgnoreMouseEvents(!inside, { forward: true })
    if (inside !== this.hovered) {
      this.hovered = inside
      this.refresh()
    }
  }

  // ---------- actions ----------

  action(a: DictationBarAction): void {
    switch (a) {
      case 'dictate':
        return this.d.dictate()
      case 'record':
        return this.toggleRecord()
      case 'notes':
        return this.openNotes()
      case 'menu':
        return this.menu()
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

  /** The chevron toggles the menu; it opens above the bar's right end, never at the cursor. */
  private menu(): void {
    const w = this.d.pill()
    if (!w) return
    if (this.openMenu) {
      this.openMenu.closePopup(w)
      this.openMenu = null
      return
    }
    const capturing = this.d.ctx.capture.isCapturing()
    const mic = this.settings?.['dictation.microphone'] ?? null
    const micLabel = mic && mic !== 'system-default' ? mic.label || 'Selected microphone' : 'System default'
    const template: MenuItemConstructorOptions[] = [
      { label: capturing ? 'Stop recording' : 'Start recording', click: () => this.toggleRecord() },
      {
        label: 'Choose microphone',
        submenu: [
          { label: micLabel, type: 'radio', checked: true, enabled: false },
          { type: 'separator' },
          { label: 'Microphone settings…', click: () => openSettingsSection('voice-typing', 'dictation-bar') }
        ]
      },
      ...(this.settings?.['scratchpad.enabled'] ? [{ label: 'Open scratchpad', click: () => this.openNotes(true) }] : []),
      { type: 'separator' },
      { label: 'Hide for 1 hour', click: () => this.action('snooze') },
      { label: 'Hide bar', click: () => this.action('hide') },
      { type: 'separator' },
      { label: 'Settings…', click: () => openSettingsSection('voice-typing', 'dictation-bar') }
    ]
    const menu = Menu.buildFromTemplate(template)
    this.openMenu = menu
    const last = this.rects[this.rects.length - 1]
    log('debug', 'dictation-bar:menu-open')
    menu.popup({
      window: w,
      x: Math.round(last ? last.x + last.width : L.pill.width / 2),
      y: Math.round(last ? last.y : L.pill.height - 52),
      callback: () => {
        log('debug', 'dictation-bar:menu-closed')
        if (this.openMenu === menu) this.openMenu = null
      }
    })
  }
}
