// SPDX-License-Identifier: Apache-2.0
// Main's capture reconcile. The renderer pushes a desired state on every change; main ignores an
// unchanged one, otherwise starts or stops capture and the note's transcription
// session, and broadcasts the four per-source states back.
//
// Audio sources: a desired state without `audioSources` opens both, which is every meeting. A
// source note's system-only capture asks for `['system']`: the engine never opens the
// microphone, its two states stay `inactive`, and no microphone pin reaches the engine. The
// sources are fixed per capture run; a switch to a note that wants other sources reopens the
// engine with them.

import { app, powerSaveBlocker } from 'electron'
import {
  AUDIO_SOURCES,
  audioSourcesOf,
  type CaptureCommand,
  type CaptureEngineEvent,
  type CaptureStatus,
  type CaptureSystemState,
  type DesiredCaptureState
} from '@shared/types/capture'
import type { AudioSource, IsoTime, StopReason } from '@shared/types/common'
import type { MicApp } from '@shared/types/meetings'
import type { TranscriptionLanguage } from '@shared/types/settings'
import type { CaptureStartGate, MainContext } from '../context'
import { log } from '../log'
import { emitAudioTaps } from './taps'
import type { TranscriptionControl } from '../transcription'
import { AudioBatcher, SAMPLE_RATE } from './batcher'
import { EndpointMonitor, type CaptureEndpoint } from './endpoints'
import { InputSelection, normalizePreference, resolveAutoTarget, type ReconcileReason } from './input'
import {
  pushActiveDevice,
  pushCommand,
  pushInputDevices,
  pushInputState,
  pushStopRequested,
  pushSystemSource,
  pushSystemState,
  pushVolume
} from './push'
import { WavDump } from './wav-dump'

const RESTART_BUDGET = 20
/**
 * After main stops a meeting (sleep, inactivity, app-left, trash), a desired "on"
 * for the same note that the renderer sent before it saw `capture:stop-requested`
 * must not restart capture. The renderer's own "off" ends the guard; this caps it.
 */
const MAIN_STOP_GUARD_MS = 3_000
/**
 * Stop and summarize: the automatic stops and the
 * floating-indicator stop run enhance's summary preflight on the live note first, and
 * enhance starts generation at the stop. A stop from the note keeps the after-stop check.
 */
const STOP_AND_SUMMARIZE: readonly StopReason[] = [
  'idle_timeout',
  'meeting_app_left_at_event_end',
  'meeting_app_left_confirmed',
  'indicator_stop_button'
]

/** What the in-main monitors (audio health, inactivity) learn from the controller. */
export interface CaptureHooks {
  /** `sources`: what this run opened (both, or a source note's system audio alone). */
  started(noteId: string, sources: readonly AudioSource[]): void
  /** Capture moved to another note without restarting audio. */
  switched(noteId: string, sources: readonly AudioSource[]): void
  stopped(noteId: string, reason: StopReason): void
  /** Every system-audio buffer from the engine, before batching. */
  systemBuffer(pcm: Uint8Array): void
  /** Every microphone buffer from the engine, before batching (the silent-microphone notice). */
  micBuffer(pcm: Uint8Array): void
  /** The live microphone changed (label null = none). */
  activeMic(label: string | null): void
  sourceError(source: AudioSource, name: string): void
}

const NO_HOOKS: CaptureHooks = {
  started: () => undefined,
  switched: () => undefined,
  stopped: () => undefined,
  systemBuffer: () => undefined,
  micBuffer: () => undefined,
  activeMic: () => undefined,
  sourceError: () => undefined
}

function transcriptionLanguage(language: string): TranscriptionLanguage | null {
  return language === 'en' || language === 'multi' || language === 'pt-BR' ? language : null
}

type DesiredOn = Extract<DesiredCaptureState, { capture: 'on' }>

/** True when the run opens every source (the meeting default). */
function isBoth(sources: readonly AudioSource[]): boolean {
  return AUDIO_SOURCES.every((s) => sources.includes(s))
}

function sameSources(a: readonly AudioSource[], b: readonly AudioSource[]): boolean {
  return a.length === b.length && a.every((s) => b.includes(s))
}

/** The start command; `audioSources` only when not both, so a meeting's command is unchanged. */
function startCommand(pinnedDeviceId: string | null, sources: readonly AudioSource[]): CaptureCommand {
  return {
    type: 'start',
    sampleRate: SAMPLE_RATE,
    pinnedDeviceId,
    ...(isBoth(sources) ? {} : { audioSources: [...sources] })
  }
}

/** Requested sources start, an unrequested one is inactive; `withCapture` resets the capture states too. */
function startingStates(sources: readonly AudioSource[], withCapture: boolean): Partial<CaptureSystemState> {
  return {
    ...(withCapture ? captureStarting(sources) : {}),
    microphoneTranscription: sources.includes('microphone') ? 'starting' : 'inactive',
    systemTranscription: sources.includes('system') ? 'starting' : 'inactive'
  }
}

function captureStarting(sources: readonly AudioSource[]): Partial<CaptureSystemState> {
  return {
    microphoneCapture: sources.includes('microphone') ? 'starting' : 'inactive',
    systemCapture: sources.includes('system') ? 'starting' : 'inactive'
  }
}

interface Running {
  noteId: string
  sessionId: string
  startedAt: IsoTime
  desired: DesiredOn
  /** The sources this run opened; fixed until a stop or a switch to a note that wants others. */
  sources: readonly AudioSource[]
  batcher: AudioBatcher
  dump: WavDump | null
  /** Sources whose first buffer arrived (logged once each). */
  seen: Set<AudioSource>
  startLoggedAt: number
}

const INACTIVE: Omit<CaptureSystemState, 'noteId'> = {
  microphoneCapture: 'inactive',
  systemCapture: 'inactive',
  microphoneTranscription: 'inactive',
  systemTranscription: 'inactive'
}

/** A start waiting on the gates. `next` is the first gate still to run. */
interface PendingStart {
  noteId: string
  desired: DesiredOn
  kind: 'start' | 'switch'
  next: number
  /** The gate holding it; null while gates run. */
  heldBy: string | null
}

export class CaptureController {
  private lastDesired = ''
  private running: Running | null = null
  private restartsUsed = 0
  private state: CaptureSystemState = { noteId: null, ...INACTIVE }
  private powerBlockerId: number | null = null
  private readonly stops = new Set<Promise<void>>()
  /** Per note, the tail of its start/stop steps (see `sequence`). */
  private readonly lifecycle = new Map<string, Promise<void>>()
  private emptyLogged = new Set<AudioSource>()
  private mainStopGuard: { noteId: string; until: number } | null = null
  /** A stop-and-summarize whose preflight is running: later stop requests join it. */
  private summarizing: Promise<void> | null = null
  private hooks: CaptureHooks = NO_HOOKS
  /** The start gates, in registration order. */
  private readonly gates: CaptureStartGate[] = []
  /** A start or switch whose gates are running or holding it. */
  private pending: PendingStart | null = null
  readonly input = new InputSelection()
  /** Windows capture endpoints and who records from them, while capturing. */
  private readonly endpointMonitor = new EndpointMonitor((list) => this.onEndpoints(list))
  private endpoints: CaptureEndpoint[] | null = null
  private micApps: MicApp[] = []
  /** The sources of a start in progress, before `running` is set. */
  private pendingSources: readonly AudioSource[] | null = null

  constructor(
    private readonly ctx: MainContext,
    private readonly transcription: TranscriptionControl
  ) {
    transcription.onSourceState((noteId, source, s) => {
      if (this.running?.noteId !== noteId) return
      // An unrequested source has no audio: it stays inactive whatever its socket does.
      if (!this.running.sources.includes(source)) return
      this.setStates(source === 'microphone' ? { microphoneTranscription: s } : { systemTranscription: s })
    })
    void ctx.settings
      .get('capture.inputPreference')
      .then((p) => this.input.setStored(normalizePreference(p)))
      .catch((err: unknown) => log('warn', 'input:preference-read-failed', { err }))
    ctx.bus.on('meetings:mic-apps', ({ apps }) => {
      this.micApps = apps
      this.updateAutoTarget()
    })
  }

  isCapturing(): boolean {
    return this.running !== null
  }

  currentNoteId(): string | null {
    return this.running?.noteId ?? null
  }

  status(): CaptureStatus {
    return {
      capturing: this.running !== null,
      noteId: this.running?.noteId ?? null,
      method: 'browser',
      sampleRate: SAMPLE_RATE,
      restartsUsed: this.restartsUsed
    }
  }

  systemState(): CaptureSystemState {
    return this.state
  }

  setHooks(hooks: CaptureHooks): void {
    this.hooks = hooks
  }

  hasStopsInFlight(): boolean {
    return this.stops.size > 0
  }

  /** Resolves when every stop in flight has finished. */
  async settled(): Promise<void> {
    await Promise.all([...this.stops])
  }

  // ---------- desired state ----------

  setDesired(desired: DesiredCaptureState): void {
    const key = JSON.stringify(desired)
    if (key === this.lastDesired) return
    const guard = this.mainStopGuard
    if (desired.capture === 'on' && guard && guard.noteId === desired.noteId && Date.now() < guard.until) {
      // Sent before the renderer saw main's stop. Not remembered either, so the same
      // state still starts capture once the user resumes.
      log('info', 'capture:desired-on-after-main-stop-ignored', { noteId: desired.noteId })
      return
    }
    this.mainStopGuard = null
    this.lastDesired = key
    // A desired-state change while gates run abandons the pending start, except a
    // change for the same note (keywords, language), which the start will use.
    const pending = this.pending
    if (pending) {
      if (desired.capture === 'on' && desired.noteId === pending.noteId) {
        pending.desired = desired
        return
      }
      log('info', 'capture:start-superseded', { noteId: pending.noteId })
      this.pending = null
    }
    if (desired.capture === 'off') {
      if (this.running) void this.stopWith(desired.reason)
      return
    }
    if (!this.running) {
      this.gatedStart(desired, 'start')
      return
    }
    if (this.running.noteId !== desired.noteId) {
      this.gatedStart(desired, 'switch')
      return
    }
    const prev = this.running.desired
    this.running.desired = desired
    if (!sameSources(this.running.sources, audioSourcesOf(desired))) {
      // The sources are fixed for the run (a reloaded renderer re-sends its state); the next
      // start uses the new ones.
      log('info', 'capture:audio-sources-change-deferred', { noteId: desired.noteId })
    }
    if (prev.language !== desired.language || prev.asr !== desired.asr) {
      // Same note, new language or provider: the session restarts in place and capture
      // keeps running. The keywords travel with it.
      this.reconfigure(desired)
      return
    }
    if (JSON.stringify(prev.keywords) !== JSON.stringify(desired.keywords)) {
      this.transcription.updateKeywords(desired.noteId, desired.keywords)
    }
  }

  // ---------- start gates ----------

  registerStartGate(g: CaptureStartGate): () => void {
    this.gates.push(g)
    return () => {
      const i = this.gates.indexOf(g)
      if (i >= 0) this.gates.splice(i, 1)
    }
  }

  heldStart(): { noteId: string; gateId: string } | null {
    const p = this.pending
    return p && p.heldBy ? { noteId: p.noteId, gateId: p.heldBy } : null
  }

  /** Runs the remaining gates, then starts. */
  releaseHeldStart(noteId: string): void {
    const p = this.pending
    if (!p || p.noteId !== noteId || !p.heldBy) return
    log('info', 'capture:start-released', { noteId, gateId: p.heldBy })
    p.heldBy = null
    void this.runGates(p)
  }

  /** The renderer's desired state goes off, exactly like a main-side stop. */
  cancelHeldStart(noteId: string, reason: StopReason): void {
    const p = this.pending
    if (!p || p.noteId !== noteId) return
    log('info', 'capture:start-cancelled', { noteId, gateId: p.heldBy, reason })
    this.pending = null
    this.lastDesired = JSON.stringify({ capture: 'off', reason })
    pushStopRequested(this.ctx.windows, { reason })
  }

  /** A fresh start or a switch: straight through with no gates, else after them. */
  private gatedStart(desired: DesiredOn, kind: 'start' | 'switch'): void {
    if (this.gates.length === 0) {
      this.applyStart(desired)
      return
    }
    const p: PendingStart = { noteId: desired.noteId, desired, kind, next: 0, heldBy: null }
    this.pending = p
    void this.runGates(p)
  }

  private async runGates(p: PendingStart): Promise<void> {
    while (p.next < this.gates.length) {
      const gate = this.gates[p.next] as CaptureStartGate
      p.next += 1
      let res: Awaited<ReturnType<CaptureStartGate['beforeStart']>>
      try {
        res = await gate.beforeStart({ noteId: p.noteId, kind: p.kind })
      } catch (err) {
        log('error', 'capture:start-gate-failed', { gateId: gate.id, noteId: p.noteId, err })
        res = { result: 'proceed' }
      }
      if (this.pending !== p) return
      if (res.result === 'hold') {
        p.heldBy = gate.id
        log('info', 'capture:start-held', { noteId: p.noteId, gateId: gate.id })
        return
      }
      if (res.result === 'block') {
        log('info', 'capture:start-blocked', { noteId: p.noteId, gateId: gate.id, reason: res.reason })
        this.pending = null
        this.lastDesired = JSON.stringify({ capture: 'off', reason: res.reason })
        pushStopRequested(this.ctx.windows, { reason: res.reason })
        return
      }
    }
    if (this.pending !== p) return
    this.pending = null
    this.applyStart(p.desired)
  }

  /** Starts, or switches when another note is capturing. */
  private applyStart(desired: DesiredOn): void {
    if (!this.running) this.start(desired)
    else if (this.running.noteId !== desired.noteId) this.switchNote(desired)
  }

  private reconfigure(desired: DesiredOn): void {
    const language = transcriptionLanguage(desired.language)
    if (!language) {
      log('warn', 'capture:reconfigure-language-invalid', { noteId: desired.noteId })
      return
    }
    log('info', 'capture:reconfigure', { noteId: desired.noteId, language, asr: desired.asr })
    void this.transcription
      .reconfigure(desired.noteId, { language, asr: desired.asr, keywords: desired.keywords })
      .catch((err: unknown) => log('error', 'capture:reconfigure-failed', { noteId: desired.noteId, err }))
  }

  /**
   * `ctx.capture.stop(reason)`: main stops the meeting through the same
   * drained path as a renderer stop, tells the renderer so its desired state follows,
   * and resolves after the bus `capture:stopped` for that session.
   */
  stopFromMain(reason: StopReason): Promise<void> {
    const r = this.running
    if (!r) return Promise.resolve()
    this.mainStopGuard = { noteId: r.noteId, until: Date.now() + MAIN_STOP_GUARD_MS }
    this.lastDesired = JSON.stringify({ capture: 'off', reason })
    pushStopRequested(this.ctx.windows, { reason })
    return this.stopWith(reason)
  }

  /** A stop, through enhance's stop-and-summarize when the reason calls for it. */
  private stopWith(reason: StopReason): Promise<void> {
    if (this.summarizing) return this.summarizing
    const r = this.running
    if (!r || !STOP_AND_SUMMARIZE.includes(reason)) return this.stop(reason)
    const noteId = r.noteId
    // Only this run is stopped: the preflight takes a moment, and a quit or a window
    // close may have stopped it already.
    const stopThisRun = (): Promise<void> =>
      this.running === r && r.noteId === noteId ? this.stop(reason) : this.settled()
    const run = this.ctx.enhance
      .stopAndSummarize(noteId, stopThisRun)
      .then(({ summarizing }) => log('info', 'capture:stop-and-summarize', { noteId, reason, summarizing }))
      .catch(async (err: unknown) => {
        log('error', 'capture:stop-and-summarize-failed', { noteId, reason, err })
        await stopThisRun()
      })
      .finally(() => {
        if (this.summarizing === run) this.summarizing = null
      })
    this.summarizing = run
    return run
  }

  private start(desired: DesiredOn): void {
    const sources = audioSourcesOf(desired)
    log('info', 'capture:start', {
      sampleRate: SAMPLE_RATE,
      method: 'browser',
      noteId: desired.noteId,
      ...(isBoth(sources) ? {} : { sources: sources.join(',') })
    })
    this.restartsUsed = 0
    this.emptyLogged.clear()
    // `running` is set below; the state carries this run's sources from the first push.
    this.pendingSources = sources
    this.setStates({ noteId: desired.noteId, ...startingStates(sources, true) })
    const { sessionId, startedAt } = this.transcription.start({
      noteId: desired.noteId,
      language: desired.language,
      keywords: desired.keywords,
      asr: desired.asr,
      // Only a system-only run names its sources, so a meeting's session starts as before.
      ...(isBoth(sources) ? {} : { sources })
    })
    const dump = WavDump.maybeCreate({ userDataPath: this.ctx.userDataPath, isDev: this.ctx.isDev, noteId: desired.noteId })
    const running: Running = {
      noteId: desired.noteId,
      sessionId,
      startedAt,
      desired,
      sources,
      dump,
      seen: new Set(),
      startLoggedAt: Date.now(),
      batcher: new AudioBatcher((source, pcm, time) => this.onBatch(source, pcm, time))
    }
    this.running = running
    this.pendingSources = null
    this.input.resetApplied()
    pushCommand(this.ctx.windows, startCommand(this.input.startPin(), sources))
    this.afterInputReconcile('capture-started')
    this.endpointMonitor.start()
    void this.markStarted(desired.noteId, sessionId, startedAt, sources)
    // The main window is not brought forward here: the entry points that
    // want it (the tray, deep links, notification clicks) show it themselves, and a
    // start in the background shows the bubble instead.
    this.hooks.started(desired.noteId, sources)
  }

  /** Capture stays on; transcription moves to the new note. */
  private switchNote(desired: DesiredOn): void {
    const prev = this.running as Running
    log('info', 'capture:switch-note', { from: prev.noteId, to: desired.noteId })
    this.track(this.finishSession(prev.noteId, prev.sessionId, prev.startedAt, 'toggle_off'))
    const sources = audioSourcesOf(desired)
    const { sessionId, startedAt } = this.transcription.start({
      noteId: desired.noteId,
      language: desired.language,
      keywords: desired.keywords,
      asr: desired.asr,
      ...(isBoth(sources) ? {} : { sources })
    })
    prev.noteId = desired.noteId
    prev.sessionId = sessionId
    prev.startedAt = startedAt
    prev.desired = desired
    if (sameSources(prev.sources, sources)) {
      this.setStates({ noteId: desired.noteId, ...startingStates(sources, false) })
    } else {
      // A meeting and a source note want different sources: the engine reopens with the new
      // ones, so a system-only note never keeps a microphone stream open, and a meeting gets one.
      log('info', 'capture:switch-sources', { to: desired.noteId, sources: sources.join(',') })
      prev.sources = sources
      prev.seen.clear()
      prev.startLoggedAt = Date.now()
      this.setStates({ noteId: desired.noteId, ...startingStates(sources, true) })
      pushCommand(this.ctx.windows, { type: 'stop' })
      this.input.resetApplied()
      pushCommand(this.ctx.windows, startCommand(this.input.startPin(), sources))
      this.afterInputReconcile('capture-started')
    }
    void this.markStarted(desired.noteId, sessionId, startedAt, sources)
    this.hooks.switched(desired.noteId, sources)
  }

  stop(reason: StopReason): Promise<void> {
    const r = this.running
    if (!r) return this.settled()
    log('info', 'capture:stop', { reason, noteId: r.noteId })
    // Final audio reaches the session before it drains.
    r.batcher.destroy()
    r.dump?.close()
    this.running = null
    this.restartsUsed = 0
    pushCommand(this.ctx.windows, { type: 'stop' })
    this.releasePowerBlocker()
    this.setStates({ noteId: null, ...INACTIVE })
    this.endpointMonitor.stop()
    this.endpoints = null
    this.input.resetAutoTarget()
    if (this.input.stateChanged(false)) pushInputState(this.ctx.windows, null)
    pushActiveDevice(this.ctx.windows, { deviceId: null, label: null })
    pushSystemSource(this.ctx.windows, { label: null })
    const done = this.finishSession(r.noteId, r.sessionId, r.startedAt, reason)
    this.track(done)
    this.hooks.stopped(r.noteId, reason)
    return done
  }

  /** The note's transcribe flag, then `capture:started`, in the note's step order. */
  private markStarted(noteId: string, sessionId: string, startedAt: IsoTime, sources: readonly AudioSource[]): Promise<void> {
    return this.sequence(noteId, async () => {
      // `audioSources` only on a system-only run, so a meeting's event is unchanged.
      this.ctx.bus.emit('capture:started', { noteId, sessionId, startedAt, ...(isBoth(sources) ? {} : { audioSources: [...sources] }) })
      try {
        await this.ctx.storage.setTranscribe(noteId, true)
      } catch (err) {
        log('warn', 'capture:set-transcribe-failed', { err })
      }
    })
  }

  /**
   * Drain, final flush, note fields, then `capture:stopped` (bus contract). The event
   * carries the session `capture:started` announced for this run: a mid-meeting
   * language or provider switch restarts the transcription session in place, and its
   * id must not make the stop look like a stale one to enhance.
   */
  private finishSession(noteId: string, sessionId: string, startedAt: IsoTime, reason: StopReason): Promise<void> {
    // The drain starts now: the manager drops the session synchronously, so a Resume
    // during the drain gets a new session while this one finishes.
    const drained = this.transcription.stop(noteId, reason).catch((err: unknown) => {
      log('error', 'capture:session-stop-failed', { noteId, err })
      return null
    })
    return this.sequence(noteId, async () => {
      await drained
      // A Resume during the drain has marked the note transcribing again: keep it.
      if (this.running?.noteId !== noteId) {
        try {
          await this.ctx.storage.setTranscribe(noteId, false)
        } catch (err) {
          log('warn', 'capture:set-transcribe-failed', { err })
        }
      }
      try {
        const count = await this.ctx.storage.incrementMeetingEndCount(noteId)
        log('info', 'capture:meeting-end-count', { noteId, count })
      } catch (err) {
        log('warn', 'capture:meeting-end-count-failed', { err })
      }
      this.ctx.bus.emit('capture:stopped', { noteId, sessionId, reason, startedAt, stoppedAt: new Date().toISOString() })
    })
  }

  /**
   * Runs `step` after the note's earlier start/stop steps. A Resume during a stop's
   * drain therefore emits its `capture:started` after that stop's `capture:stopped`,
   * and the stale stop cannot clear the flag of the live session. Consumers
   * still compare `sessionId` and `ctx.capture.currentNoteId()` at fire time.
   */
  private sequence(noteId: string, step: () => Promise<void>): Promise<void> {
    const run = (this.lifecycle.get(noteId) ?? Promise.resolve())
      .then(step)
      .catch((err: unknown) => log('error', 'capture:lifecycle-step-failed', { noteId, err }))
    this.lifecycle.set(noteId, run)
    void run.finally(() => {
      if (this.lifecycle.get(noteId) === run) this.lifecycle.delete(noteId)
    })
    return run
  }

  private track(p: Promise<void>): void {
    this.stops.add(p)
    void p.finally(() => this.stops.delete(p))
  }

  // ---------- restart ----------

  restart(scope: 'system' | 'all'): { ok: boolean; reason?: string } {
    const r = this.running
    if (!r) return { ok: false, reason: 'not-capturing' }
    // Both sources still capture and only transcription failed: reconnect it and leave
    // the audio running. A full restart would drop the audio of its own gap.
    const s = this.state
    // Only the run's own sources count (a system-only run has no microphone).
    const wanted = r.sources
    const captureUp = wanted.every((src) => (src === 'microphone' ? s.microphoneCapture : s.systemCapture) === 'active')
    const transcriptionDown = wanted.some((src) => (src === 'microphone' ? s.microphoneTranscription : s.systemTranscription) === 'error')
    if (scope === 'all' && captureUp && transcriptionDown) {
      log('info', 'capture:restart-transcription-only', { noteId: r.noteId })
      this.transcription.retryNow(r.noteId)
      return { ok: true }
    }
    if (this.restartsUsed >= RESTART_BUDGET) {
      log('error', 'capture:restart-budget-spent', { scope, used: this.restartsUsed })
      return { ok: false, reason: 'restart-budget-spent' }
    }
    this.restartsUsed++
    log('info', 'capture:restart', { scope, used: this.restartsUsed })
    if (scope === 'system') {
      this.setStates({ systemCapture: 'starting' })
      pushCommand(this.ctx.windows, { type: 'restart-system-audio' })
      return { ok: true }
    }
    r.seen.clear()
    r.startLoggedAt = Date.now()
    this.setStates(captureStarting(r.sources))
    pushCommand(this.ctx.windows, { type: 'stop' })
    this.input.resetApplied()
    pushCommand(this.ctx.windows, startCommand(this.input.startPin(), r.sources))
    this.afterInputReconcile('capture-started')
    // The user's Retry also skips any transcription backoff wait.
    this.transcription.retryNow(r.noteId)
    return { ok: true }
  }

  /**
   * Inactivity recovery: always restarts the run's capture sources (a system-only run,
   * its system source alone). It is user-initiated and at most once per warning, so it
   * spends no restart budget.
   */
  restartForRecovery(noteId: string): { ok: boolean; reason?: string } {
    const r = this.running
    if (!r || r.noteId !== noteId) return { ok: false, reason: 'not-capturing' }
    log('info', 'capture:restart', { scope: 'recovery', used: this.restartsUsed })
    if (!r.sources.includes('microphone')) {
      this.setStates({ systemCapture: 'starting' })
      pushCommand(this.ctx.windows, { type: 'restart-system-audio' })
      return { ok: true }
    }
    r.seen.clear()
    r.startLoggedAt = Date.now()
    this.setStates(captureStarting(r.sources))
    pushCommand(this.ctx.windows, { type: 'stop' })
    this.input.resetApplied()
    pushCommand(this.ctx.windows, startCommand(this.input.startPin(), r.sources))
    this.afterInputReconcile('capture-started')
    return { ok: true }
  }

  // ---------- engine events ----------

  onEngineEvent(e: CaptureEngineEvent): void {
    switch (e.type) {
      case 'initialized':
        log('info', 'capture:engine-initialized', { capturing: this.running !== null })
        if (this.running) {
          this.input.resetApplied()
          pushCommand(this.ctx.windows, startCommand(this.input.startPin(), this.running.sources))
        }
        return
      case 'started':
        log('info', 'capture:engine-started', { sources: e.sources.join(',') })
        return
      case 'start-failed':
        log('error', 'capture:engine-start-failed', { error: e.error })
        if (this.running) {
          const wanted = this.running.sources
          this.setStates({
            ...(wanted.includes('microphone') ? { microphoneCapture: 'error' as const } : {}),
            ...(wanted.includes('system') ? { systemCapture: 'error' as const } : {})
          })
        }
        return
      case 'stopped':
        log('info', 'capture:engine-stopped')
        return
      case 'buffer':
        this.onBuffer(e.source, e.pcm, e.captureTimeMs)
        return
      case 'volume':
        if (this.running) pushVolume(this.ctx.windows, { source: e.source, rms: e.rms })
        return
      case 'source-error':
        log('error', 'capture:source-error', { source: e.source, name: e.name, message: e.message })
        if (this.running && this.running.sources.includes(e.source)) {
          this.setStates(e.source === 'microphone' ? { microphoneCapture: 'error' } : { systemCapture: 'error' })
          this.hooks.sourceError(e.source, e.name)
        }
        return
      case 'devices':
        this.input.setDevices(e.devices)
        if (this.running) pushInputDevices(this.ctx.windows, e.devices)
        this.input.setAutoTarget(this.resolveAutoTarget())
        this.afterInputReconcile('devices-changed')
        return
      case 'active-device':
        if (!this.running) return
        // A system-only run has no microphone to report or fall back from.
        if (!this.running.sources.includes('microphone')) return
        pushActiveDevice(this.ctx.windows, { deviceId: e.deviceId, label: e.label })
        this.hooks.activeMic(e.label)
        // A pinned meeting-app microphone that would not open: the engine fell back to
        // the default, and Auto stops asking for it.
        if (e.requestedDeviceId && e.deviceId !== e.requestedDeviceId && this.input.autoPinFailed(e.requestedDeviceId, e.deviceId)) {
          this.afterInputReconcile('auto-device-failed')
        }
        return
      case 'system-source':
        if (this.running) pushSystemSource(this.ctx.windows, { label: e.label })
        return
      case 'restart-request':
        this.restart(e.scope)
        return
      case 'log':
        log(e.level, `engine:${e.event}`, e.data)
        return
    }
  }

  private onBuffer(source: AudioSource, pcm: Uint8Array, captureTimeMs: number): void {
    const r = this.running
    if (!r) return
    if (!pcm.byteLength) {
      if (!this.emptyLogged.has(source)) {
        this.emptyLogged.add(source)
        log('warn', 'capture:empty-buffer', { source })
      }
      return
    }
    if (!r.sources.includes(source)) {
      // Never expected: the engine opens only the requested sources. Dropped, never transcribed.
      if (!this.emptyLogged.has(source)) {
        this.emptyLogged.add(source)
        log('warn', 'capture:unrequested-source-buffer', { source })
      }
      return
    }
    if (!r.seen.has(source)) {
      r.seen.add(source)
      log('info', 'capture:source-active', { source, latencyMs: Date.now() - r.startLoggedAt })
    }
    // A source's first buffer moves it from starting (or error) to active.
    const key = source === 'microphone' ? 'microphoneCapture' : 'systemCapture'
    if (this.state[key] !== 'active') this.setStates({ [key]: 'active' })
    if (source === 'system') this.hooks.systemBuffer(pcm)
    else this.hooks.micBuffer(pcm)
    r.batcher.push(source, Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength), captureTimeMs)
  }

  private onBatch(source: AudioSource, pcm: Buffer, captureTimeMs: number): void {
    const r = this.running
    if (!r) return
    r.dump?.write(source, pcm)
    this.transcription.feed(r.noteId, source, pcm, captureTimeMs)
    // The audio taps, beside the feed.
    emitAudioTaps({ noteId: r.noteId, sessionId: r.sessionId, source, pcm, captureTimeMs })
  }

  // ---------- input device ----------

  setInputPreference(raw: unknown): void {
    const pref = normalizePreference(raw)
    this.input.setStored(pref)
    void this.ctx.settings
      .set('capture.inputPreference', pref)
      .catch((err: unknown) => log('warn', 'input:preference-write-failed', { err }))
    this.afterInputReconcile('preference-changed')
  }

  inputState(): ReturnType<InputSelection['state']> {
    return this.input.state(this.running !== null)
  }

  private onEndpoints(list: CaptureEndpoint[] | null): void {
    this.endpoints = this.running ? list : null
    this.updateAutoTarget()
  }

  private resolveAutoTarget(): ReturnType<typeof resolveAutoTarget> {
    // Notula's own sessions (the audio service records from the endpoint too) never count.
    const own = new Set([process.pid, ...app.getAppMetrics().map((m) => m.pid)])
    return resolveAutoTarget(this.endpoints, this.micApps, this.input.devicesOrNull(), own)
  }

  /** The meeting app moved to another microphone, or the picture became known. */
  private updateAutoTarget(): void {
    if (!this.running) return
    if (this.input.setAutoTarget(this.resolveAutoTarget())) this.afterInputReconcile('mic-app-changed')
  }

  private afterInputReconcile(reason: ReconcileReason): void {
    const capturing = this.running !== null
    // A system-only run never pins, unpins or reopens a microphone.
    if (capturing && this.running?.sources.includes('microphone')) {
      const action = this.input.reconcile(reason)
      if (action?.type === 'pin') pushCommand(this.ctx.windows, { type: 'use-input-device', deviceId: action.deviceId })
      else if (action?.type === 'unpin') pushCommand(this.ctx.windows, { type: 'release-input-device' })
    }
    if (this.input.stateChanged(capturing)) pushInputState(this.ctx.windows, this.input.state(capturing))
  }

  // ---------- power ----------

  preventDisplaySleep(): void {
    if (this.powerBlockerId !== null && powerSaveBlocker.isStarted(this.powerBlockerId)) return
    this.powerBlockerId = powerSaveBlocker.start('prevent-display-sleep')
  }

  allowDisplaySleep(): void {
    this.releasePowerBlocker()
  }

  private releasePowerBlocker(): void {
    if (this.powerBlockerId !== null && powerSaveBlocker.isStarted(this.powerBlockerId)) {
      powerSaveBlocker.stop(this.powerBlockerId)
    }
    this.powerBlockerId = null
  }

  // ---------- state push ----------

  private setStates(patch: Partial<CaptureSystemState>): void {
    const next: CaptureSystemState = { ...this.state, ...patch }
    // `audioSources` rides along only on a system-only run: a meeting's state has no such key.
    const sources = next.noteId === null ? AUDIO_SOURCES : (this.running?.sources ?? this.pendingSources ?? AUDIO_SOURCES)
    if (isBoth(sources)) delete next.audioSources
    else if (!next.audioSources || !sameSources(next.audioSources, sources)) next.audioSources = [...sources]
    const keys = new Set([...Object.keys(next), ...Object.keys(this.state)]) as Set<keyof CaptureSystemState>
    const changed = [...keys].some((k) => next[k] !== this.state[k])
    if (!changed) return
    this.state = next
    pushSystemState(this.ctx.windows, next)
  }
}
