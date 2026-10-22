// SPDX-License-Identifier: Apache-2.0
// Audio health in main: the system-audio dropout
// detector, the Windows antivirus check and the silent-microphone notice. Main sees
// every engine buffer, so the detectors do not depend on a hidden, throttled renderer.
// The renderer only draws the banner from `capture:health`.
//
// A microphone that sends only exact digital zero for 60 s gets a
// notice, once per capture. Noise-suppression virtual microphones (NVIDIA Broadcast and
// the like) send exact zero whenever the user is quiet, so a few seconds of it is normal;
// nothing is switched automatically. The notice notes whether system audio carried sound
// in that minute, and it clears when the microphone sends sound or changes.
//
// A system-only capture (a source note) has no microphone: the silent-microphone notice and the
// antivirus check never run for it.

import { execFile } from 'node:child_process'
import { app } from 'electron'
import type { CaptureHealth } from '@shared/types/capture'
import type { AudioSource } from '@shared/types/common'
import type { MicApp } from '@shared/types/meetings'
import type { MainContext } from '../context'
import { log } from '../log'
import { pushHealth } from './push'

/** Silence (or a stalled stream) this long restarts system capture. */
const DROPOUT_THRESHOLD_MS = 300_000
/** No system sample for this long counts as a stall, which is silence. */
const STALL_MS = 500
const CHECK_EVERY_MS = 1_000
const MAX_RESTARTS_PER_STREAK = 10
/** Exact digital zero from the microphone this long shows the notice. */
const MIC_SILENT_MS = 60_000
/** System audio counts as sound in that minute after this much of it above the level below. */
const SYSTEM_SOUND_MS = 3_000
/** About -54 dBFS: a 100 ms system buffer this loud is sound, not floor noise. */
const SYSTEM_SOUND_RMS = 0.002
const ANTIVIRUS_TIMEOUT_MS = 5_000
// Kaspersky: its avp / avpui processes, or a running AVP* service. Read-only; prints True or False.
const ANTIVIRUS_QUERY =
  "$p = Get-Process -Name avp, avpui -ErrorAction SilentlyContinue; $s = Get-Service -Name 'AVP*' -ErrorAction SilentlyContinue | Where-Object { $_.Status -eq 'Running' }; [bool]($p -or $s)"

/** Dev builds only: `NOTULA_DEV_DROPOUT_MS` shortens the 5-minute threshold for a smoke run. */
function dropoutThresholdMs(): number {
  if (app.isPackaged) return DROPOUT_THRESHOLD_MS
  const raw = Number(process.env['NOTULA_DEV_DROPOUT_MS'])
  return Number.isFinite(raw) && raw >= 2_000 ? Math.round(raw) : DROPOUT_THRESHOLD_MS
}

/** Any non-zero s16le sample is sound (RMS above 0). */
function hasSound(pcm: Uint8Array): boolean {
  for (let i = 0; i < pcm.length; i++) if (pcm[i] !== 0) return true
  return false
}

/** RMS of s16le mono, 0..1. */
function rmsOf(pcm: Uint8Array): number {
  const n = pcm.byteLength >> 1
  if (!n) return 0
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2)
  let sum = 0
  for (let i = 0; i < n; i++) {
    const v = view.getInt16(i * 2, true) / 32768
    sum += v * v
  }
  return Math.sqrt(sum / n)
}

/** Milliseconds of s16le mono at 16 kHz. */
const durationMs = (pcm: Uint8Array): number => pcm.byteLength / 32

let kaspersky: Promise<boolean | null> | null = null

/** Once per app run: null off Windows or on any error. Nothing is reported anywhere. */
function kasperskyRunning(): Promise<boolean | null> {
  if (process.platform !== 'win32') return Promise.resolve(null)
  kaspersky ??= new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', ANTIVIRUS_QUERY],
      { timeout: ANTIVIRUS_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) {
          log('warn', 'capture:antivirus-query-failed', { err })
          resolve(null)
          return
        }
        resolve(/^true$/i.test(String(stdout).trim()))
      }
    )
  })
  return kaspersky
}

const IDLE: CaptureHealth = {
  noteId: null,
  systemDropout: false,
  dropoutApp: null,
  antivirusSuspected: false,
  restartsThisStreak: 0,
  micSilent: false,
  micSilentDevice: null,
  micSilentWhileSystemSound: false
}

export class AudioHealth {
  private health: CaptureHealth = IDLE
  private readonly thresholdMs = dropoutThresholdMs()
  private timer: ReturnType<typeof setInterval> | null = null
  private lastSoundAt = 0
  private lastSampleAt = 0
  private lastRestartAt = 0
  private stalled = false
  private antivirusChecked = false
  /** Bumped per capture start, so a late antivirus answer cannot mark a newer meeting. */
  private generation = 0
  private micApps: MicApp[] = []
  /** When the microphone's current run of exact zero began (null = it has sound). */
  private micZeroSince: number | null = null
  /** System audio with sound since `micZeroSince`. */
  private systemSoundMs = 0
  private micNoticeShown = false
  private micLabel: string | null = null
  /** The run opened a microphone (false for a source note's system-only capture). */
  private micRequested = true

  constructor(
    private readonly ctx: MainContext,
    private readonly restartSystem: () => { ok: boolean; reason?: string }
  ) {
    if (this.thresholdMs !== DROPOUT_THRESHOLD_MS) log('info', 'capture:dev-dropout-threshold', { ms: this.thresholdMs })
    ctx.bus.on('meetings:mic-apps', ({ apps }) => {
      this.micApps = apps
      if (this.health.noteId) this.set({ dropoutApp: apps[0]?.name ?? null })
    })
  }

  current(): CaptureHealth {
    return this.health
  }

  started(noteId: string, sources: readonly AudioSource[]): void {
    this.generation++
    this.micRequested = sources.includes('microphone')
    const now = Date.now()
    this.lastSoundAt = now
    this.lastSampleAt = now
    this.lastRestartAt = 0
    this.stalled = false
    this.antivirusChecked = false
    this.micZeroSince = null
    this.systemSoundMs = 0
    this.micNoticeShown = false
    this.replace({ ...IDLE, noteId, dropoutApp: this.micApps[0]?.name ?? null })
    if (this.timer) clearInterval(this.timer)
    this.timer = setInterval(() => this.check(), CHECK_EVERY_MS)
  }

  /** Audio keeps running for the new note; so does the silence measure. */
  switched(noteId: string, sources: readonly AudioSource[]): void {
    const mic = sources.includes('microphone')
    if (mic !== this.micRequested) {
      // The engine reopened with other sources: the microphone's silence is measured afresh.
      this.micRequested = mic
      this.micZeroSince = null
      this.micNoticeShown = false
      this.set({ noteId, micSilent: false, micSilentDevice: null, micSilentWhileSystemSound: false, antivirusSuspected: false })
      return
    }
    this.set({ noteId })
  }

  stopped(): void {
    this.generation++
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.replace(IDLE)
  }

  systemBuffer(pcm: Uint8Array): void {
    if (!this.health.noteId) return
    const now = Date.now()
    this.lastSampleAt = now
    if (this.micZeroSince !== null && rmsOf(pcm) >= SYSTEM_SOUND_RMS) this.systemSoundMs += durationMs(pcm)
    if (!hasSound(pcm)) return
    this.lastSoundAt = now
    if (this.health.systemDropout) {
      // Sound is back: the dropout clears and the recovery is logged.
      log('info', 'capture:dropout-recovered', { restarts: this.health.restartsThisStreak })
      this.lastRestartAt = 0
      this.set({ systemDropout: false, restartsThisStreak: 0 })
    }
  }

  /** Every microphone buffer. Only arriving buffers count, so a stalled stream never looks silent. */
  micBuffer(pcm: Uint8Array): void {
    if (!this.health.noteId || !this.micRequested) return
    if (hasSound(pcm)) {
      this.micZeroSince = null
      if (this.health.micSilent) {
        log('info', 'capture:mic-silent-cleared', { reason: 'sound' })
        this.set({ micSilent: false })
      }
      return
    }
    const now = Date.now()
    if (this.micZeroSince === null) {
      this.micZeroSince = now
      this.systemSoundMs = 0
      return
    }
    if (this.micNoticeShown || now - this.micZeroSince < MIC_SILENT_MS) return
    this.micNoticeShown = true
    const systemSound = this.systemSoundMs >= SYSTEM_SOUND_MS
    log('warn', 'capture:mic-silent', { device: this.micLabel ?? 'unknown', silentMs: now - this.micZeroSince, systemSoundMs: this.systemSoundMs })
    this.set({ micSilent: true, micSilentDevice: this.micLabel, micSilentWhileSystemSound: systemSound })
  }

  /** The live microphone changed: its silence is measured afresh, and an old notice goes. */
  activeMic(label: string | null): void {
    if (label === this.micLabel) return
    this.micLabel = label
    this.micZeroSince = null
    if (this.health.micSilent) {
      log('info', 'capture:mic-silent-cleared', { reason: 'device-changed' })
      this.set({ micSilent: false })
    }
  }

  /** A microphone `NotReadableError` asks once per capture start whether antivirus interferes. */
  sourceError(source: AudioSource, name: string): void {
    if (source !== 'microphone' || name !== 'NotReadableError' || this.antivirusChecked || !this.micRequested) return
    if (process.platform !== 'win32' || !this.health.noteId) return
    this.antivirusChecked = true
    const gen = this.generation
    void kasperskyRunning().then((found) => {
      log('info', 'capture:antivirus-checked', { kaspersky: found })
      if (found && gen === this.generation && this.health.noteId) this.set({ antivirusSuspected: true })
    })
  }

  private check(): void {
    if (!this.health.noteId) return
    const now = Date.now()
    const stalled = now - this.lastSampleAt > STALL_MS
    if (stalled !== this.stalled) {
      this.stalled = stalled
      log('debug', stalled ? 'capture:system-stalled' : 'capture:system-flowing')
    }
    if (now - this.lastSoundAt < this.thresholdMs) return
    if (!this.health.systemDropout) {
      // Once per silence streak.
      log('warn', 'capture:dropout', { silentMs: now - this.lastSoundAt, stalled })
      this.set({ systemDropout: true })
    }
    const restarts = this.health.restartsThisStreak
    if (restarts >= MAX_RESTARTS_PER_STREAK || now - this.lastRestartAt < this.thresholdMs) return
    this.lastRestartAt = now
    // System only: the microphone keeps transcribing through the restart.
    const r = this.restartSystem()
    if (!r.ok) log('warn', 'capture:dropout-restart-refused', { reason: r.reason ?? null })
    else log('info', 'capture:dropout-restart', { attempt: restarts + 1 })
    this.set({ restartsThisStreak: restarts + 1 })
  }

  private set(patch: Partial<CaptureHealth>): void {
    this.replace({ ...this.health, ...patch })
  }

  private replace(next: CaptureHealth): void {
    const prev = this.health
    const changed = (Object.keys(next) as (keyof CaptureHealth)[]).some((k) => next[k] !== prev[k])
    if (!changed) return
    this.health = next
    pushHealth(this.ctx.windows, next)
  }
}
