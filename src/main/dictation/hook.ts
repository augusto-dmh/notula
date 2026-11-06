// SPDX-License-Identifier: Apache-2.0
// The dictation bar's hook shortcuts: runs the key helper through
// notula-desk only while a hook chord is set and Voice typing is armed, feeds its key events to
// the pure chord machine, and reports `shortcuts:hook-status`.
//
// - Status: `unsupported` off Windows/macOS; macOS without Accessibility trust is `permission`
//   (the helper is not started); a helper that fails before `ready` is `helper-failed`; one that
//   dies or reports `lost` afterwards is `lost` and is restarted (up to 3 times in a row).
// - The helper is told which keys the chords use and, while a dictation runs, to report Esc.
// - Double tap waits the OS double-click interval (the desk helper's `dblclick`, 400 ms when it
//   can't say). When keys stop arriving for 2 s while some are held and the OS reports no
//   modifier down, the machine forgets them and re-arms (a lock screen eats key-ups).
// - While a paste is watched (./observe.ts), the helper reports Return and Tab as `commit`.
// - Mouse buttons (`mouse4` …) are keys to the chord machine. The helper is told which ones the
//   chords use (`mouse` in its config; on Windows only 3–5, the ones its events can name) and
//   holds a mouse hook only while that list is non-empty; it reports the hook going on and off
//   (`dictation-bar:hook-mouse`), and a failed install marks `HookStatus.mouse` without touching
//   the key chords. While a shortcut is recorded the helper is told to swallow nothing.
// - The lock screen eats a held button's release, and a press the helper swallowed never shows in
//   the OS's key state, so neither the helper nor the stale check can see it end: on unlock, the
//   buttons the machine still holds are released. The helper settles its own mark at the
//   button's next press.

import { powerMonitor, systemPreferences } from 'electron'
import { mouseButtonOf, WINDOWS_MOUSE_MAX, type HookStatus } from '@shared/types/dictation-bar'
import { log } from '../log'
import { IDLE, rearm, sessionEnded, sessionStartedElsewhere, setSuspended, step, type ChordConfig, type ChordEffect, type ChordState } from './chord-machine'
import type { Desk } from './desk'

const READY_MS = 20_000
const RETRY_MS = 5_000
const MAX_RETRIES = 3
const STALE_KEYS_MS = 2_000
const DOUBLE_TAP_FALLBACK_MS = 400

export class HookShortcuts {
  private machine: ChordState = { ...IDLE }
  private cfg: ChordConfig | null = null
  private running = false
  private ready = false
  private active = false
  private retries = 0
  private readyTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private staleTimer: ReturnType<typeof setInterval> | null = null
  private lastKeyAt = 0
  private doubleTapMs = DOUBLE_TAP_FALLBACK_MS
  private watching = false
  private suspended = false
  /** The mouse buttons the helper is told to watch. */
  private mouseButtons: number[] = []
  private mouseOn = false
  private mouseFailed = false
  private unlockWatched = false
  /** Return or Tab while a paste is watched. */
  onCommit: (() => void) | null = null
  status: HookStatus = { available: false }

  constructor(
    private readonly desk: Desk,
    private readonly onEffects: (effects: ChordEffect[]) => void,
    private readonly onStatus: (s: HookStatus) => void
  ) {
    desk.onHook((m) => this.onMessage(m))
  }

  private get supported(): boolean {
    return process.platform === 'win32' || process.platform === 'darwin'
  }

  private setStatus(next: HookStatus): void {
    const s: HookStatus = next.available && this.mouseFailed ? { ...next, mouse: 'failed' } : next
    if (JSON.stringify(s) === JSON.stringify(this.status)) return
    this.status = s
    log('info', 'dictation-bar:hook-status', { ...s })
    this.onStatus(s)
  }

  /** null = no hook chord set, or Voice typing disarmed: the helper stops. */
  configure(cfg: ChordConfig | null): void {
    this.cfg = cfg && (cfg.hold.length || cfg.handsFree.length || cfg.doubleTap?.length || cfg.record) ? cfg : null
    this.machine = { ...IDLE, suspended: this.machine.suspended }
    if (!this.cfg) {
      this.retries = 0
      this.stop()
      this.setStatus({ available: false })
      return
    }
    if (!this.supported) return this.setStatus({ available: false, reason: 'unsupported' })
    if (process.platform === 'darwin' && !systemPreferences.isTrustedAccessibilityClient(false)) {
      this.stop()
      return this.setStatus({ available: false, reason: 'permission' })
    }
    if (this.running) this.sendConfig()
    else void this.start()
  }

  private async start(): Promise<void> {
    if (this.running || !this.cfg) return
    if (!this.unlockWatched) {
      this.unlockWatched = true
      powerMonitor.on('unlock-screen', () => this.releaseButtonsAfterUnlock())
    }
    this.running = true
    this.ready = false
    const ok = await this.desk.startHook()
    if (!ok) {
      this.running = false
      return this.setStatus({ available: false, reason: 'helper-failed' })
    }
    this.readyTimer = setTimeout(() => {
      if (this.ready) return
      log('warn', 'dictation-bar:hook-ready-timeout')
      this.stop()
      this.setStatus({ available: false, reason: 'helper-failed' })
    }, READY_MS)
  }

  stop(): void {
    if (this.readyTimer) clearTimeout(this.readyTimer)
    if (this.retryTimer) clearTimeout(this.retryTimer)
    if (this.staleTimer) clearInterval(this.staleTimer)
    this.readyTimer = this.retryTimer = this.staleTimer = null
    if (this.running) this.desk.stopHook()
    this.running = false
    this.ready = false
    this.machine = { ...IDLE, suspended: this.machine.suspended }
    this.setMouse(false)
  }

  /** The helper's mouse hook went on or off (the helper stopping takes it off). */
  private setMouse(on: boolean, failed = false): void {
    const wasFailed = this.mouseFailed
    this.mouseFailed = failed
    if (on !== this.mouseOn) {
      this.mouseOn = on
      log('info', 'dictation-bar:hook-mouse', { on, buttons: on ? this.mouseButtons.length : 0 })
    }
    if (failed !== wasFailed && this.status.available) this.setStatus({ ...this.status, mouse: undefined })
  }

  private sendConfig(): void {
    const cfg = this.cfg
    if (!cfg || !this.ready) return
    const chords = [...cfg.hold, ...cfg.handsFree, ...(cfg.doubleTap ?? []), ...(cfg.record ? [cfg.record] : [])]
    const mods = new Set(['ctrl', 'alt', 'shift', 'win', 'cmd'])
    const keys = [...new Set(chords.flat().filter((k) => !mods.has(k.replace(/_r$/, '')) && mouseButtonOf(k) === null))]
    // Windows' low-level mouse events name only the middle and the two extra buttons.
    const reach = (b: number): boolean => process.platform !== 'win32' || b <= WINDOWS_MOUSE_MAX
    const mouse = [...new Set(chords.flat().map(mouseButtonOf))].filter((b): b is number => b !== null && reach(b)).sort((a, b) => a - b)
    this.mouseButtons = mouse
    if (!mouse.length) this.setMouse(false)
    this.desk.sendHook({ op: 'config', keys, chords, mouse })
    this.desk.sendHook({ op: 'active', on: this.active })
    if (this.watching) this.desk.sendHook({ op: 'watch', on: true })
    if (this.suspended) this.desk.sendHook({ op: 'suspend', on: true })
  }

  /** Keys held with no event for a while: ask the OS, and re-arm when nothing is down. The check
   *  covers the keys held with a mouse button too; a button held on its own sends nothing and the
   *  OS's modifier check can't see it, so the helper checks the buttons itself and reports a
   *  release it missed as a key-up. */
  private checkStale(): void {
    if (!this.machine.held.length || Date.now() - this.lastKeyAt < STALE_KEYS_MS) return
    if (this.machine.held.every((k) => mouseButtonOf(k) !== null)) return
    this.lastKeyAt = Date.now()
    void this.desk.modifiersHeld().then((held) => {
      if (held !== false || !this.machine.held.length || Date.now() - this.lastKeyAt < STALE_KEYS_MS - 100) return
      log('info', 'dictation-bar:hook-rearmed', { held: this.machine.held.length })
      this.machine = rearm(this.machine)
    })
  }

  private releaseButtonsAfterUnlock(): void {
    const buttons = this.ready ? this.machine.held.filter((k) => mouseButtonOf(k) !== null) : []
    if (!buttons.length) return
    log('info', 'dictation-bar:hook-unlock-released', { buttons: buttons.length })
    for (const k of buttons) this.onMessage({ event: 'key', k, d: 0 })
  }

  private onMessage(m: Record<string, unknown>): void {
    if (m['type'] === 'hook-exit') {
      const wasReady = this.ready
      const wanted = this.running
      this.running = false
      this.ready = false
      this.machine = { ...IDLE, suspended: this.machine.suspended }
      this.setMouse(false)
      if (this.readyTimer) clearTimeout(this.readyTimer)
      if (!wanted || !this.cfg) return
      // It died on its own: report, then try again.
      this.setStatus(wasReady ? { available: false, lost: true, reason: 'helper-failed' } : { available: false, reason: 'helper-failed' })
      if (this.retries < MAX_RETRIES) {
        this.retries++
        this.retryTimer = setTimeout(() => void this.start(), RETRY_MS * this.retries)
      }
      return
    }
    switch (m['event']) {
      case 'ready':
        if (this.readyTimer) clearTimeout(this.readyTimer)
        this.ready = true
        this.sendConfig()
        this.setStatus({ available: true })
        if (!this.staleTimer) this.staleTimer = setInterval(() => this.checkStale(), 1_000)
        if (process.platform === 'win32') {
          void this.desk.ask('dblclick', 1_500).then((r) => {
            const ms = Number(r?.['ms'])
            this.doubleTapMs = Number.isFinite(ms) && ms >= 100 && ms <= 5_000 ? ms : DOUBLE_TAP_FALLBACK_MS
          })
        }
        return
      case 'commit':
        this.onCommit?.()
        return
      case 'mouse':
        // {on} after the mouse hook went on or off; {failed} when installing it failed.
        this.setMouse(m['on'] === true, m['failed'] === true)
        if (m['failed'] === true) log('warn', 'dictation-bar:hook-mouse-failed', { buttons: this.mouseButtons.length })
        return
      case 'lost':
        // Re-installing failed: restart the helper.
        this.setStatus({ available: false, lost: true, reason: 'helper-failed' })
        this.stop()
        if (this.retries++ < MAX_RETRIES) this.retryTimer = setTimeout(() => void this.start(), RETRY_MS)
        return
      case 'secure-input':
        this.setStatus(m['on'] === true ? { available: false, reason: 'secure-input' } : { available: true })
        return
      case 'error':
        log('warn', 'dictation-bar:hook-error', { message: String(m['message'] ?? '').slice(0, 200) })
        return
      case 'key': {
        if (!this.cfg || typeof m['k'] !== 'string') return
        this.retries = 0
        this.lastKeyAt = Date.now()
        const r = step(this.machine, { ...this.cfg, doubleTapMs: this.doubleTapMs }, { key: m['k'], down: m['d'] === 1, at: Date.now() })
        this.machine = r.state
        if (r.effects.length) this.onEffects(r.effects)
        return
      }
    }
  }

  /** A dictation is running (Esc is reported only then). */
  setActive(on: boolean): void {
    if (on === this.active) return
    this.active = on
    if (this.ready) this.desk.sendHook({ op: 'active', on })
  }

  /** Report Return and Tab (`onCommit`) while a paste is watched. Windows only. */
  watch(on: boolean): void {
    if (on === this.watching) return
    this.watching = on
    if (this.ready) this.desk.sendHook({ op: 'watch', on })
  }

  /** The helper is up and reporting keys. */
  get isReady(): boolean {
    return this.ready
  }

  /** A shortcut is being recorded: nothing fires, and the helper swallows no mouse button. */
  setSuspended(on: boolean): void {
    this.machine = setSuspended(this.machine, on)
    if (on === this.suspended) return
    this.suspended = on
    if (this.ready) this.desk.sendHook({ op: 'suspend', on })
  }

  sessionEnded(): void {
    this.machine = sessionEnded(this.machine)
  }

  sessionStartedElsewhere(): void {
    this.machine = sessionStartedElsewhere(this.machine)
  }
}
