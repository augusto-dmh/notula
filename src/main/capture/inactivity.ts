// SPDX-License-Identifier: Apache-2.0
// Inactivity warning and automatic stops, in main. Two timers run for the capturing note and
// restart on every transcript
// change (partials included); the warning card and the bubble window only draw the
// `capture:inactivity` push. The meeting-app-left stop follows the mic-app list.
//
// A system-only capture (a source note watching a video) is capturing like any other: both
// inactivity timers run on its transcript. A meeting app closing says nothing about the video,
// so the app-left stop skips it; end of watching (sources) stops it instead.

import { app } from 'electron'
import type { InactivityAction, InactivityWarning } from '@shared/types/capture'
import type { AudioSource, StopReason } from '@shared/types/common'
import type { CalendarEvent } from '@shared/types/notes'
import type { MainContext } from '../context'
import { log } from '../log'
import type { TranscriptionControl } from '../transcription'
import { pushInactivity } from './push'

const MINUTE_MS = 60_000
/** App-left: at least this much remote transcription before the stop. */
const APP_LEFT_MIN_SYSTEM_MS = 3 * MINUTE_MS
/** App-left: an event ending this close to now stops at once. */
const NEAR_EVENT_END_MS = 5 * MINUTE_MS
/** Capture times may run a little ahead of main's start mark. */
const RUN_START_SLACK_MS = 2_000

/**
 * Dev builds only: `NOTULA_DEV_MINUTE_MS` is the length of one "minute" for the
 * inactivity delays and the app-left minimum, so a smoke run needs seconds, not
 * minutes. The settings and the UI copy still speak in minutes.
 */
function minuteMs(): number {
  if (app.isPackaged) return MINUTE_MS
  const raw = Number(process.env['NOTULA_DEV_MINUTE_MS'])
  return Number.isFinite(raw) && raw >= 500 ? Math.round(raw) : MINUTE_MS
}

function eventEndMs(event: CalendarEvent | null | undefined): number | null {
  const raw = event?.end?.dateTime ?? event?.end?.date
  if (!raw) return null
  const t = Date.parse(raw)
  return Number.isFinite(t) ? t : null
}

type Resolution = 'keep' | 'stop' | 'auto_stopped' | 'transcript_resumed'

export class InactivityMonitor {
  private readonly minute = minuteMs()
  private noteId: string | null = null
  /** When the current capture run started on `noteId`. */
  private runStartedAt = 0
  /** The run has no microphone (a source note's system-only capture). */
  private systemOnly = false
  private warningMinutes: number | null = null
  private autoStopMinutes: number | null = null
  private warningTimer: ReturnType<typeof setTimeout> | null = null
  private stopTimer: ReturnType<typeof setTimeout> | null = null
  private warning: InactivityWarning | null = null
  /** Bumped on every start, stop and settings read, so a stale read never arms timers. */
  private generation = 0

  constructor(
    private readonly ctx: MainContext,
    private readonly transcription: TranscriptionControl,
    private readonly stopCapture: (reason: StopReason) => Promise<void>
  ) {
    if (this.minute !== MINUTE_MS) log('info', 'capture:dev-minute', { ms: this.minute })
    ctx.bus.on('transcript:changed', (e) => {
      // New words, partials included. A retraction or an empty result after a
      // reconnect is not speech.
      if (e.noteId !== this.noteId || !e.upserted.some((c) => c.text.trim())) return
      if (this.warning) this.resolve('transcript_resumed')
      this.arm()
    })
    ctx.bus.on('settings:changed', ({ keys }) => {
      if (!this.noteId) return
      if (keys.includes('capture.inactivityWarningMinutes') || keys.includes('capture.inactivityAutoStopMinutes')) {
        void this.loadAndArm()
      }
    })
    ctx.bus.on('meetings:mic-apps', ({ apps, previous }) => {
      if (previous.length > 0 && apps.length === 0) void this.onMeetingAppLeft(previous.map((a) => a.appId))
    })
  }

  current(): InactivityWarning | null {
    return this.warning
  }

  started(noteId: string, sources: readonly AudioSource[]): void {
    this.noteId = noteId
    this.runStartedAt = Date.now()
    this.systemOnly = !sources.includes('microphone')
    if (this.warning) this.resolve('transcript_resumed')
    void this.loadAndArm()
  }

  switched(noteId: string, sources: readonly AudioSource[]): void {
    this.started(noteId, sources)
  }

  stopped(noteId: string): void {
    if (this.noteId !== noteId) return
    this.generation++
    this.noteId = null
    this.clearTimers()
    if (this.warning) this.clearWarning()
  }

  /** The card's buttons, from the note page or the bubble window. */
  answer(noteId: string, action: InactivityAction): void {
    if (noteId !== this.noteId) {
      log('info', 'capture:inactivity-answer-stale', { action })
      return
    }
    if (action === 'keep') {
      this.resolve('keep')
      this.arm()
      return
    }
    this.resolve('stop')
    this.clearTimers()
    void this.stopCapture('inactivity_prompt_stop')
  }

  private async loadAndArm(): Promise<void> {
    const gen = ++this.generation
    try {
      const s = await this.ctx.settings.getAll()
      if (gen !== this.generation) return
      this.warningMinutes = s['capture.inactivityWarningMinutes']
      this.autoStopMinutes = s['capture.inactivityAutoStopMinutes']
    } catch (err) {
      log('warn', 'capture:inactivity-settings-failed', { err })
      if (gen !== this.generation) return
    }
    this.arm()
  }

  /** (Re)starts both timers from now. Each delay may be off (null). */
  private arm(): void {
    this.clearTimers()
    if (!this.noteId) return
    const noteId = this.noteId
    const warnMs = this.warningMinutes !== null ? this.warningMinutes * this.minute : null
    const stopMs = this.autoStopMinutes !== null ? this.autoStopMinutes * this.minute : null
    const now = Date.now()
    if (stopMs !== null) {
      this.stopTimer = setTimeout(() => this.onAutoStop(noteId), stopMs)
    }
    // The warning only makes sense while it comes before the stop.
    if (warnMs !== null && (stopMs === null || warnMs < stopMs)) {
      this.warningTimer = setTimeout(() => this.onWarning(noteId, stopMs !== null ? now + stopMs : null), warnMs)
    }
  }

  private onWarning(noteId: string, autoStopAt: number | null): void {
    this.warningTimer = null
    if (noteId !== this.noteId || !this.ctx.capture.isCapturing()) return
    // `autoStopAt` is when the auto-stop timer really fires, so the countdown is true.
    this.warning = {
      noteId,
      shownAt: new Date().toISOString(),
      autoStopAt: autoStopAt !== null ? new Date(autoStopAt).toISOString() : null
    }
    log('info', 'capture:inactivity-warning', { noteId, autoStop: autoStopAt !== null })
    pushInactivity(this.ctx.windows, this.warning)
  }

  private onAutoStop(noteId: string): void {
    this.stopTimer = null
    if (noteId !== this.noteId || this.ctx.capture.currentNoteId() !== noteId) return
    if (this.warning) this.resolve('auto_stopped')
    log('info', 'capture:inactivity-auto-stop', { noteId, minutes: this.autoStopMinutes })
    void this.stopCapture('idle_timeout')
  }

  /**
   * Meeting app left: the detected list went from non-empty to empty, the
   * note has remote transcription that started at least 3 minutes ago, and the same
   * note is still capturing after every check. Only this capture run counts: a resumed
   * note's earlier sessions are older than its run, while the sessions
   * a `config_changed` restart adds to the run are not.
   */
  private async onMeetingAppLeft(apps: string[]): Promise<void> {
    const noteId = this.ctx.capture.currentNoteId()
    if (!noteId) return
    if (this.systemOnly && noteId === this.noteId) {
      log('info', 'capture:app-left-skipped', { reason: 'system-only' })
      return
    }
    try {
      if (!(await this.ctx.settings.get('capture.autoStopWhenMeetingAppCloses'))) {
        log('info', 'capture:app-left-skipped', { reason: 'setting-off' })
        return
      }
      const chunks = await this.transcription.getTranscript(noteId)
      const runStart = this.runStartedAt - RUN_START_SLACK_MS
      let first: number | null = null
      for (const c of chunks) {
        if (c.source !== 'system') continue
        const t = Date.parse(c.start_timestamp)
        if (Number.isFinite(t) && t >= runStart && (first === null || t < first)) first = t
      }
      const minMs = (APP_LEFT_MIN_SYSTEM_MS / MINUTE_MS) * this.minute
      if (first === null || Date.now() - first < minMs) {
        log('info', 'capture:app-left-skipped', { reason: first === null ? 'no-system-chunk' : 'too-early', apps })
        return
      }
      if (this.ctx.capture.currentNoteId() !== noteId) return
      const note = await this.ctx.storage.getNote(noteId)
      const end = eventEndMs(note?.linked_event)
      if (end !== null && Math.abs(end - Date.now()) <= NEAR_EVENT_END_MS) {
        if (this.ctx.capture.currentNoteId() !== noteId) return
        log('info', 'capture:app-left-stop', { noteId, reason: 'near-event-end' })
        await this.stopCapture('meeting_app_left_at_event_end')
        return
      }
      // With `capture.llmAutoStop` off this answers "ended" without an LLM call.
      const ended = await this.ctx.enhance.didMeetingEnd(noteId)
      if (!ended) {
        log('info', 'capture:app-left-skipped', { reason: 'meeting-continues' })
        return
      }
      if (this.ctx.capture.currentNoteId() !== noteId) return
      log('info', 'capture:app-left-stop', { noteId, reason: 'meeting-end-check' })
      await this.stopCapture('meeting_app_left_confirmed')
    } catch (err) {
      log('warn', 'capture:app-left-failed', { noteId, err })
    }
  }

  private resolve(how: Resolution): void {
    // No telemetry: the resolution is a local debug line only.
    log('debug', 'capture:inactivity-resolved', { how })
    this.clearWarning()
  }

  private clearWarning(): void {
    this.warning = null
    pushInactivity(this.ctx.windows, null)
  }

  private clearTimers(): void {
    if (this.warningTimer) clearTimeout(this.warningTimer)
    if (this.stopTimer) clearTimeout(this.stopTimer)
    this.warningTimer = null
    this.stopTimer = null
  }
}
