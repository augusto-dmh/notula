// SPDX-License-Identifier: Apache-2.0
// Automatic generation when transcription stops.
//
// - `toggle_off`, `note_stop_button`: the "after stop" check: no summary
//   panel, at least one chunk, at least 3 minutes since the first chunk, then the
//   meeting-ended decision, then generation scheduled in 10 s (skipped if capture
//   resumed on the note meanwhile).
// - the other user stops and the automatic ones (inactivity, the meeting app closing
//   near the event end or with the LLM saying it ended): end-of-meeting generation
//   directly.
// - `system_sleep`: deferred to the wake: after bus
//   `power:resumed` and, for a cloud LLM, once its host answers; skipped when the user
//   resumed the transcript.
// - `view_closed`, `document_deleted`: nothing.
// - `app_shutdown`, `window_closed`: queued for the next launch. The queue needs no
//   storage of its own: at startup, a note whose latest session ended that way and
//   that has no panel created since is picked up. If the app is in fact still running
//   (macOS keeps it alive without windows), it runs once the quit window has passed.
//
// End-of-meeting generation runs its checks first: skip if capture
// resumed; the preflight (no summary panel, at least 2,500 characters of speaker-
// labelled transcript); skip if capture resumed during the checks; then generate with
// the requested template, else the note's temporary template, else the default, and
// clear the temporary template. The wait for final speaker labels happens inside the
// generation, after its panel exists (generation.ts).
//
// Stop and summarize: the automatic stops
// and the indicator stop come through `ctx.enhance.stopAndSummarize`, which runs the
// preflight on the live note before the stop and starts generation at the stop. Their
// `capture:stopped` then does nothing.

import { app } from 'electron'
import { SUGGESTED_ACTIONS_SLUG } from '@shared/types/enhance'
import type { StopReason } from '@shared/types/common'
import type { BusEvents } from '../bus'
import type { MainContext } from '../context'
import { log } from '../log'
import { clearNoteTemplate, noteTemplate } from '../templates'
import { transcriptionControl } from '../transcription'
import { waitForProviderHost } from './connectivity'
import { completeText } from './generation'
import type { Generator } from './generation'
import { didMeetingEnd, parseMeetingEnded } from './prompts'
import { currentProvider } from '../llm/registry'
import { MAX_TOKENS } from '../llm/types'
import { egressBlocked, LOCAL_ONLY_REASON } from '../privacy'
import { readerTranscript } from '../sources/reader'
import { formatTranscript, lastWords, transcriptChunks } from './transcript'

/** Generate a summary on every transcription stop, skipping the "after stop" checks. Off. */
const ALWAYS_GENERATE_WHEN_STOPPED = false

const MIN_MEETING_MS = 180_000
const CALENDAR_END_WINDOW_MS = 300_000
const SCHEDULE_DELAY_MS = 10_000
const MIN_TRANSCRIPT_CHARS = 2_500
const MEETING_END_WORDS = 100
/** How long after a shutdown-type stop the app counts as "still running". */
const QUIT_GRACE_MS = 15_000
/** Shutdown-queued meetings older than this are not picked up at launch. */
const QUEUE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

const AFTER_STOP_CHECK: readonly StopReason[] = ['toggle_off', 'note_stop_button']
const END_OF_MEETING: readonly StopReason[] = [
  'indicator_stop_button',
  'bubble_stop_button',
  'inactivity_prompt_stop',
  'idle_timeout',
  'meeting_app_left_confirmed',
  'meeting_app_left_at_event_end',
  // Never sent by Notula (nothing is transcribing at wake); kept so the stop reasons stay complete.
  'system_wake'
]
const AFTER_WAKE: readonly StopReason[] = ['system_sleep']
/** A stop decided at stop time before its session id was known. */
const ANY_SESSION = '*'
const NEXT_LAUNCH: readonly StopReason[] = ['app_shutdown', 'window_closed']

export class AutoGeneration {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /** The latest session started per note, to recognize a stop of an older one. */
  private readonly sessions = new Map<string, string>()
  /** Notes stopped by sleep, waiting for the wake. */
  private readonly sleepStopped = new Set<string>()
  /** Stops whose summary was decided at the stop (stop and summarize): the session each one ends. */
  private readonly decidedAtStop = new Map<string, string>()
  private asleep = false
  private quitting = false

  constructor(
    private readonly ctx: MainContext,
    private readonly generator: Generator
  ) {
    app.on('before-quit', () => {
      this.quitting = true
    })
  }

  onStarted(e: BusEvents['capture:started']): void {
    this.sessions.set(e.noteId, e.sessionId)
    this.sleepStopped.delete(e.noteId)
    this.cancel(e.noteId, 'capture-resumed')
  }

  /**
   * The bus contract: a stop is acted on only when it ends the note's
   * latest session and capture has not resumed on the note meanwhile. A Resume during
   * the stop's drain is already capturing when the stale `capture:stopped` arrives.
   */
  onStopped(e: BusEvents['capture:stopped']): void {
    const { noteId, reason, sessionId } = e
    const decided = this.decidedAtStop.get(noteId)
    if (decided !== undefined && (decided === ANY_SESSION || decided === sessionId)) {
      this.decidedAtStop.delete(noteId)
      return this.skip(noteId, 'decided-at-stop')
    }
    const latest = this.sessions.get(noteId)
    if (sessionId && latest && latest !== sessionId) return this.skip(noteId, 'stale-stop')
    if (this.resumed(noteId)) return this.skip(noteId, 'capture-resumed')
    if (AFTER_STOP_CHECK.includes(reason)) void this.afterStop(noteId).catch((err: unknown) => this.failed(noteId, err))
    else if (END_OF_MEETING.includes(reason)) void this.endOfMeeting(noteId).catch((err: unknown) => this.failed(noteId, err))
    else if (AFTER_WAKE.includes(reason)) {
      if (this.asleep) {
        log('info', 'enhance:auto-deferred-until-wake', { noteId })
        this.sleepStopped.add(noteId)
      } else {
        // The drain finished after the wake: the wake already happened.
        void this.afterWake(noteId).catch((err: unknown) => this.failed(noteId, err))
      }
    } else if (NEXT_LAUNCH.includes(reason)) {
      log('info', 'enhance:auto-queued-for-next-launch', { noteId, reason })
      this.schedule(noteId, QUIT_GRACE_MS, () => {
        if (this.quitting) return
        void this.endOfMeeting(noteId).catch((err: unknown) => this.failed(noteId, err))
      })
    }
  }

  onSuspended(): void {
    this.asleep = true
  }

  onResumed(e: BusEvents['power:resumed']): void {
    this.asleep = false
    const notes = [...this.sleepStopped]
    this.sleepStopped.clear()
    // The drain of the sleep stop may still be finishing: `onStopped` then runs it.
    for (const noteId of notes) void this.afterWake(noteId).catch((err: unknown) => this.failed(noteId, err))
    if (notes.length === 0 && e.suspendedNoteId) log('debug', 'enhance:wake-without-deferred', { noteId: e.suspendedNoteId })
  }

  /** After the wake and, for a cloud LLM, connectivity. */
  private async afterWake(noteId: string): Promise<void> {
    if (this.resumed(noteId)) return this.skip(noteId, 'capture-resumed')
    const online = await waitForProviderHost(this.ctx, () => this.resumed(noteId))
    if (this.resumed(noteId)) return this.skip(noteId, 'capture-resumed')
    if (!online) log('warn', 'enhance:wake-offline-generating-anyway', { noteId })
    await this.endOfMeeting(noteId)
  }

  /** The checks after the user stops in the note. */
  private async afterStop(noteId: string): Promise<void> {
    if (await this.hasSummaryPanel(noteId)) return this.skip(noteId, 'has-panel')
    const chunks = transcriptChunks(await readerTranscript(this.ctx, noteId, await this.ctx.storage.getTranscript(noteId)))
    const first = chunks[0] ? Date.parse(chunks[0].start_timestamp) : NaN
    if (!Number.isFinite(first)) return this.skip(noteId, 'no-transcript')
    if (Date.now() - first < MIN_MEETING_MS) return this.skip(noteId, 'meeting-too-short')

    if (!ALWAYS_GENERATE_WHEN_STOPPED && !(await this.nearCalendarEnd(noteId)) && !(await this.didMeetingEnd(noteId))) {
      return this.skip(noteId, 'meeting-not-ended')
    }
    log('info', 'enhance:auto-scheduled', { noteId, delayMs: SCHEDULE_DELAY_MS })
    this.schedule(noteId, SCHEDULE_DELAY_MS, () => {
      void this.endOfMeeting(noteId).catch((err: unknown) => this.failed(noteId, err))
    })
  }

  /**
   * Stop and summarize: the preflight on the live note, then the stop, then, when it
   * passed, generation at once without the resume checks. A preflight error counts as "no summary". When the note was
   * already stopped some other way meanwhile, that stop's own `capture:stopped` decides.
   */
  async stopAndSummarize(noteId: string, stop: () => Promise<void>): Promise<{ summarizing: boolean }> {
    let summarizing = false
    try {
      const blocked = await this.preflight(noteId)
      summarizing = blocked === null
      if (blocked) this.skip(noteId, `${blocked}-at-stop`)
    } catch (err) {
      log('warn', 'enhance:auto-summary-preflight-failed', { noteId, err })
    }
    if (!this.resumed(noteId)) {
      await stop()
      return { summarizing: false }
    }
    this.decidedAtStop.set(noteId, this.sessions.get(noteId) ?? ANY_SESSION)
    const stopped = stop()
    // The "stop record": whether a summary is coming.
    log('info', 'enhance:stop-and-summarize', { noteId, summarizing })
    if (summarizing) void this.generateEndOfMeeting(noteId).catch((err: unknown) => this.failed(noteId, err))
    await stopped
    return { summarizing }
  }

  /** End-of-meeting generation, with its checks in order. */
  async endOfMeeting(noteId: string, opts: { templateSlug?: string } = {}): Promise<void> {
    if (this.resumed(noteId)) return this.skip(noteId, 'auto-enhance-skipped-resumed')
    const blocked = await this.preflight(noteId)
    if (blocked) return this.skip(noteId, blocked)
    if (this.resumed(noteId)) return this.skip(noteId, 'auto-enhance-skipped-resumed-mid-check')
    await this.generateEndOfMeeting(noteId, opts)
  }

  /** The checks have passed: generate with the requested, temporary or default template. */
  private async generateEndOfMeeting(noteId: string, opts: { templateSlug?: string } = {}): Promise<void> {
    log('info', 'enhance:summary-pending', { noteId })
    // Without a requested template, `generate` takes the temporary one (falling back to
    // the default if it no longer resolves).
    const temporary = noteTemplate(noteId)
    const { panelId } = await this.generator.generate({
      noteId,
      auto: true,
      ...(opts.templateSlug ? { templateSlug: opts.templateSlug } : {})
    })
    clearNoteTemplate(noteId)
    log('info', 'enhance:auto-generation-started', { noteId, panelId, template: opts.templateSlug ?? temporary })
    // Back to wide after the meeting, armed at the summary step when nothing captures.
    if (!this.ctx.capture.isCapturing() && (await this.ctx.settings.get('window.repositionForMeetings').catch(() => false))) {
      this.ctx.windowModes.scheduleResetAfterMeeting()
      log('info', 'enhance:window-reset-scheduled', { noteId })
    }
  }

  /**
   * `ctx.enhance.autoGenerate` (the demo and imports): the end-of-meeting generation
   * path for a note that has no summary yet. `transcriptText` replaces the transcript
   * input (and the transcript-length preflight). With no usable LLM, `fallbackMarkdown`
   * becomes the summary panel. Resolves once the panel
   * exists; the outcome follows on bus `enhance:completed`. Null when nothing was generated.
   */
  async autoGenerate(noteId: string, opts: { transcriptText?: string; fallbackMarkdown?: string } = {}): Promise<{ panelId: string } | null> {
    const note = await this.ctx.storage.getNote(noteId)
    if (!note) return null
    if (await this.hasSummaryPanel(noteId)) {
      this.skip(noteId, 'auto-generate-has-panel')
      return null
    }
    const provider = await currentProvider(this.ctx.settings, this.ctx.secrets)
    const blocked = await egressBlocked(this.ctx, { kind: 'llm' })
    const usable = !blocked && (await provider.available()).ok
    if (!usable) {
      if (opts.fallbackMarkdown?.trim()) {
        const panelId = await this.generator.fallbackPanel(note, opts.fallbackMarkdown.trim())
        log('info', 'enhance:auto-generate-fallback', { noteId, panelId, reason: blocked ? LOCAL_ONLY_REASON : 'no-llm' })
        return { panelId }
      }
      this.skip(noteId, blocked ? LOCAL_ONLY_REASON : 'auto-generate-no-llm')
      return null
    }
    const transcriptText = opts.transcriptText?.trim() ? opts.transcriptText : undefined
    if (!transcriptText) {
      const blockedBy = await this.preflight(noteId)
      if (blockedBy) {
        this.skip(noteId, `auto-generate-${blockedBy}`)
        return null
      }
    }
    const { panelId } = await this.generator.generate({ noteId, auto: true }, { ...(transcriptText ? { transcriptText } : {}) })
    clearNoteTemplate(noteId)
    log('info', 'enhance:auto-generate-started', { noteId, panelId, scripted: !!transcriptText })
    return { panelId }
  }

  /** A summary panel already exists, or the transcript is too short. */
  private async preflight(noteId: string): Promise<string | null> {
    if (await this.hasSummaryPanel(noteId)) return 'has-panel'
    const wordLevel = await this.ctx.settings.get('transcription.diarization').catch(() => false)
    const transcript = formatTranscript(await readerTranscript(this.ctx, noteId, await this.ctx.storage.getTranscript(noteId)), { wordLevel })
    if (transcript.text.length < MIN_TRANSCRIPT_CHARS) return 'transcript_too_short'
    return null
  }

  /** At launch: meetings stopped by a quit or a window close last time. */
  async runQueued(): Promise<void> {
    const { items } = await this.ctx.storage.listNotes({ scope: 'own' })
    const cutoff = Date.now() - QUEUE_MAX_AGE_MS
    for (const item of items) {
      if (Date.parse(item.updated_at) < cutoff) continue
      const session = await this.ctx.storage.latestSession(item.id)
      if (!session?.ended_at || !NEXT_LAUNCH.includes(session.end_reason as StopReason)) continue
      if (Date.parse(session.ended_at) < cutoff) continue
      const panels = await this.ctx.storage.listPanels(item.id, { includeDeleted: true })
      if (panels.some((p) => p.created_at >= (session.ended_at as string))) continue
      log('info', 'enhance:auto-queued-run', { noteId: item.id, reason: session.end_reason })
      await this.endOfMeeting(item.id).catch((err: unknown) => this.failed(item.id, err))
    }
  }

  /**
   * `ctx.enhance.didMeetingEnd`: with `capture.llmAutoStop` off
   * the meeting counts as ended without an LLM call; otherwise the last 100 words of
   * the speaker-named transcript go to `meeting-end-check`. A failed call counts as "not
   * ended", so nothing is generated and nothing is stopped.
   */
  async didMeetingEnd(noteId: string): Promise<boolean> {
    if (!(await this.ctx.settings.get('capture.llmAutoStop'))) return true
    // No call in local-only mode with a cloud provider; "not ended", as on any failure.
    if (await egressBlocked(this.ctx, { kind: 'llm' })) {
      log('info', 'enhance:meeting-end-check-skipped', { noteId, reason: LOCAL_ONLY_REASON })
      return false
    }
    try {
      const wordLevel = await this.ctx.settings.get('transcription.diarization')
      const chunks = await transcriptionControl(this.ctx).getTranscript(noteId)
      const transcript = formatTranscript(chunks, { wordLevel, live: this.resumed(noteId) })
      const provider = await currentProvider(this.ctx.settings, this.ctx.secrets)
      if (!(await provider.available()).ok) return false
      const { system, user } = didMeetingEnd.render({ transcript: lastWords(transcript.text, MEETING_END_WORDS) })
      const reply = await completeText(provider, { purpose: 'meeting-end', system, user, maxTokens: MAX_TOKENS['meeting-end'] })
      const ended = parseMeetingEnded(reply)
      log('info', 'enhance:meeting-end-check', { noteId, ended })
      return ended
    } catch (err) {
      log('warn', 'enhance:meeting-end-check-failed', { noteId, err })
      return false
    }
  }

  private resumed(noteId: string): boolean {
    return this.ctx.capture.isCapturing() && this.ctx.capture.currentNoteId() === noteId
  }

  private schedule(noteId: string, delayMs: number, fn: () => void): void {
    this.cancel(noteId)
    this.timers.set(
      noteId,
      setTimeout(() => {
        this.timers.delete(noteId)
        fn()
      }, delayMs)
    )
  }

  private cancel(noteId: string, why?: string): void {
    const t = this.timers.get(noteId)
    if (!t) return
    clearTimeout(t)
    this.timers.delete(noteId)
    if (why) log('info', 'enhance:auto-cancelled', { noteId, why })
  }

  private async hasSummaryPanel(noteId: string): Promise<boolean> {
    const panels = await this.ctx.storage.listPanels(noteId)
    return panels.some((p) => !p.deleted_at && p.template_key !== SUGGESTED_ACTIONS_SLUG)
  }

  /** The linked event ends within ±5 minutes of now. */
  private async nearCalendarEnd(noteId: string): Promise<boolean> {
    const note = await this.ctx.storage.getNote(noteId)
    const end = note?.linked_event?.end
    const at = Date.parse(end?.dateTime ?? end?.date ?? '')
    return Number.isFinite(at) && Math.abs(at - Date.now()) <= CALENDAR_END_WINDOW_MS
  }

  private skip(noteId: string, reason: string): void {
    log('info', 'enhance:auto-skipped', { noteId, reason })
  }

  private failed(noteId: string, err: unknown): void {
    log('error', 'enhance:auto-failed', { noteId, err })
  }
}
