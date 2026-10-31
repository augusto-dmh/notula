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

import { systemPreferences } from 'electron'
import type { HookStatus } from '@shared/types/dictation-bar'
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

  private setStatus(s: HookStatus): void {
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
  }

  private sendConfig(): void {
    const cfg = this.cfg
    if (!cfg || !this.ready) return
    const chords = [...cfg.hold, ...cfg.handsFree, ...(cfg.doubleTap ?? []), ...(cfg.record ? [cfg.record] : [])]
    const mods = new Set(['ctrl', 'alt', 'shift', 'win', 'cmd'])
    const keys = [...new Set(chords.flat().filter((k) => !mods.has(k.replace(/_r$/, ''))))]
    this.desk.sendHook({ op: 'config', keys, chords })
    this.desk.sendHook({ op: 'active', on: this.active })
    if (this.watching) this.desk.sendHook({ op: 'watch', on: true })
  }

  /** Keys held with no event for a while: ask the OS, and re-arm when nothing is down. */
  private checkStale(): void {
    if (!this.machine.held.length || Date.now() - this.lastKeyAt < STALE_KEYS_MS) return
    this.lastKeyAt = Date.now()
    void this.desk.modifiersHeld().then((held) => {
      if (held !== false || !this.machine.held.length || Date.now() - this.lastKeyAt < STALE_KEYS_MS - 100) return
      log('info', 'dictation-bar:hook-rearmed', { held: this.machine.held.length })
      this.machine = rearm(this.machine)
    })
  }

  private onMessage(m: Record<string, unknown>): void {
    if (m['type'] === 'hook-exit') {
      const wasReady = this.ready
      const wanted = this.running
      this.running = false
      this.ready = false
      this.machine = { ...IDLE, suspended: this.machine.suspended }
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

  setSuspended(on: boolean): void {
    this.machine = setSuspended(this.machine, on)
  }

  sessionEnded(): void {
    this.machine = sessionEnded(this.machine)
  }

  sessionStartedElsewhere(): void {
    this.machine = sessionStartedElsewhere(this.machine)
  }
}
