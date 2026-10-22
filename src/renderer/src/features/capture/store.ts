// SPDX-License-Identifier: Apache-2.0
// The renderer capture store. It owns
// the intent: which note is transcribing. It derives the desired state and sends it
// to main on every change; main reconciles. One note at a time.
//
// A source note (content sources) captures system audio only: while Sources is on, a start
// asks main for the note's source first and, when it has one, sends `audioSources:
// ['system']`. Every other note sends no `audioSources`, which is both sources, as before. The
// combined state counts only the sources the capture opened.

import { useSyncExternalStore } from 'react'
import {
  AUDIO_SOURCES,
  type CaptureSystemState,
  type DesiredCaptureState,
  type InputDevice,
  type InputSelectionState
} from '@shared/types/capture'
import type { AudioSource, IsoTime, SourceState, StopReason } from '@shared/types/common'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types/settings'
import type { TranscriptionSessionInfo } from '@shared/types/transcript'
import { navigate } from '../../app/navigation'
import { dismissToast, showToast } from '../../app/toast'
import { CaptureEngine } from './engine'
import { clearResumePrompt } from './live'
import { startBubbleDocument } from './bubble-document'
import { sounds } from './sounds'

/** UI grace after a note is set: capture state alone, then capture + transcription. */
export const UI_GRACE_MS = 5_000
const MAX_KEYWORDS = 100
/**
 * A reload is a page hide, so it stops capture. The note is kept in this
 * window's session storage, which survives a reload but not a closed window, and the
 * reloaded page says what happened and offers Resume. It never resumes on its own.
 */
const RELOAD_STOP_KEY = 'notula.capture.stoppedByReload'
const RELOAD_NOTICE_MAX_AGE_MS = 60_000
/** The auto-stop toast stays up to 30 minutes. */
const INACTIVITY_TOAST_ID = 'capture-stopped-by-inactivity'
const INACTIVITY_TOAST_MS = 30 * 60_000
/** The meter: a peak floor of 200/32,767 and a 0.27 decay per update. */
const METER_PEAK_FLOOR = 200 / 32_767
const METER_DECAY = 0.27

const PAUSE_SOUND_REASONS: ReadonlySet<StopReason> = new Set<StopReason>([
  'toggle_off',
  'note_stop_button',
  'indicator_stop_button',
  'bubble_stop_button',
  'inactivity_prompt_stop',
  'idle_timeout'
])

export interface CaptureSnapshot {
  transcribingNoteId: string | null
  pendingStart: boolean
  ui: SourceState
  system: CaptureSystemState
  session: TranscriptionSessionInfo | null
  input: InputSelectionState | null
  devices: InputDevice[]
  activeDevice: { deviceId: string | null; label: string | null }
  systemSourceLabel: string | null
  /** What the transcribing note captures: both, or system audio alone (a source note). */
  audioSources: readonly AudioSource[]
}

const IDLE_SYSTEM: CaptureSystemState = {
  noteId: null,
  microphoneCapture: 'inactive',
  systemCapture: 'inactive',
  microphoneTranscription: 'inactive',
  systemTranscription: 'inactive'
}

const PRIORITY: SourceState[] = ['error', 'inactive', 'starting', 'active']

/** Combines two states by priority: error, then inactive, then starting, then active. */
export function combine(a: SourceState, b: SourceState): SourceState {
  return PRIORITY.indexOf(a) <= PRIORITY.indexOf(b) ? a : b
}

type Prefs = Pick<
  Settings,
  'asr.provider' | 'asr.language' | 'asr.keywords' | 'capture.sounds' | 'capture.inactivityAutoStopMinutes' | 'sources.enabled'
>

let snapshot: CaptureSnapshot = {
  transcribingNoteId: null,
  pendingStart: false,
  ui: 'inactive',
  system: IDLE_SYSTEM,
  session: null,
  input: null,
  devices: [],
  activeDevice: { deviceId: null, label: null },
  systemSourceLabel: null,
  audioSources: AUDIO_SOURCES
}
let prefs: Prefs = {
  'asr.provider': DEFAULT_SETTINGS['asr.provider'],
  'asr.language': DEFAULT_SETTINGS['asr.language'],
  'asr.keywords': DEFAULT_SETTINGS['asr.keywords'],
  'capture.sounds': DEFAULT_SETTINGS['capture.sounds'],
  'capture.inactivityAutoStopMinutes': DEFAULT_SETTINGS['capture.inactivityAutoStopMinutes'],
  'sources.enabled': DEFAULT_SETTINGS['sources.enabled']
}
let prefsLoaded: Promise<void> | null = null
let noteSetAt: number | null = null
let graceTimer: number | null = null
let lastStopReason: StopReason = 'toggle_off'
let lastSent = ''
let initialized = false
let pendingToken: object | null = null
const requestedAt = new Map<string, IsoTime>()
/** Notes that capture system audio only (source notes), set when their start resolves. */
const systemOnly = new Set<string>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const l of listeners) l()
}

/** The transcribing note's sources: main's word once it captures for it, else the start's. */
function sourcesOf(s: Pick<CaptureSnapshot, 'transcribingNoteId' | 'system'>): readonly AudioSource[] {
  const noteId = s.transcribingNoteId
  if (!noteId) return AUDIO_SOURCES
  if (s.system.noteId === noteId) return s.system.audioSources?.length ? s.system.audioSources : AUDIO_SOURCES
  return systemOnly.has(noteId) ? SYSTEM_ONLY : AUDIO_SOURCES
}

const SYSTEM_ONLY: readonly AudioSource[] = ['system']

function deriveUi(s: CaptureSnapshot): SourceState {
  if (!s.transcribingNoteId) return 'inactive'
  const sys = s.system.noteId === s.transcribingNoteId ? s.system : { ...IDLE_SYSTEM, microphoneCapture: 'starting' as const, systemCapture: 'starting' as const }
  // An unrequested source (a system-only note's microphone) never counts.
  const wanted = s.audioSources
  const pick = (mic: SourceState, system: SourceState): SourceState[] => [
    ...(wanted.includes('microphone') ? [mic] : []),
    ...(wanted.includes('system') ? [system] : [])
  ]
  const captureStates = pick(sys.microphoneCapture, sys.systemCapture)
  const transcriptionStates = pick(sys.microphoneTranscription, sys.systemTranscription)
  const capture = captureStates.reduce(combine)
  if (noteSetAt !== null && Date.now() - noteSetAt < UI_GRACE_MS) return capture
  // A note set while every transcription stays inactive past the grace is an error.
  if (transcriptionStates.every((t) => t === 'inactive')) return 'error'
  return combine(capture, transcriptionStates.reduce(combine))
}

function desired(): DesiredCaptureState {
  const noteId = snapshot.transcribingNoteId
  if (!noteId) return { capture: 'off', reason: lastStopReason }
  let at = requestedAt.get(noteId)
  if (!at) {
    at = new Date().toISOString()
    requestedAt.set(noteId, at)
  }
  return {
    capture: 'on',
    noteId,
    requestedAt: at,
    language: prefs['asr.language'],
    keywords: prefs['asr.keywords'].slice(0, MAX_KEYWORDS),
    asr: prefs['asr.provider'],
    ...(systemOnly.has(noteId) ? { audioSources: [...SYSTEM_ONLY] } : {})
  }
}

/** Replaces the snapshot, re-derives the UI state and sends the desired state if it changed. */
function update(patch: Partial<CaptureSnapshot>): void {
  const next = { ...snapshot, ...patch }
  const sources = sourcesOf(next)
  next.audioSources = sources.length === snapshot.audioSources.length && sources.every((s) => snapshot.audioSources.includes(s)) ? snapshot.audioSources : sources
  next.ui = deriveUi(next)
  const started = next.transcribingNoteId && next.transcribingNoteId !== snapshot.transcribingNoteId
  snapshot = next
  // Any start on the note answers a pending "Resume transcript?".
  if (started) clearResumePrompt(next.transcribingNoteId as string)
  if (initialized) {
    const d = desired()
    const key = JSON.stringify(d)
    if (key !== lastSent) {
      lastSent = key
      window.notula.capture.setDesiredState(d)
    }
  }
  scheduleGraceRecheck()
  emit()
}

function scheduleGraceRecheck(): void {
  if (graceTimer !== null) clearTimeout(graceTimer)
  graceTimer = null
  if (noteSetAt === null) return
  const left = UI_GRACE_MS - (Date.now() - noteSetAt)
  if (left > 0) graceTimer = window.setTimeout(() => update({}), left + 10)
}

function loadPrefs(): Promise<void> {
  prefsLoaded ??= window.notula.prefs
    .get()
    .then((s) => {
      applyPrefs(s)
    })
    .catch(() => {
      prefsLoaded = null
    })
  return prefsLoaded ?? Promise.resolve()
}

function applyPrefs(s: Partial<Settings>): void {
  prefs = {
    'asr.provider': s['asr.provider'] ?? prefs['asr.provider'],
    'asr.language': s['asr.language'] ?? prefs['asr.language'],
    'asr.keywords': Array.isArray(s['asr.keywords']) ? s['asr.keywords'] : prefs['asr.keywords'],
    'capture.sounds': s['capture.sounds'] ?? prefs['capture.sounds'],
    'capture.inactivityAutoStopMinutes':
      s['capture.inactivityAutoStopMinutes'] !== undefined
        ? s['capture.inactivityAutoStopMinutes']
        : prefs['capture.inactivityAutoStopMinutes'],
    'sources.enabled': s['sources.enabled'] ?? prefs['sources.enabled']
  }
}

/**
 * Whether the note captures system audio only: it has a source and Sources is on. A failed or
 * unanswered lookup (the sources handler not there yet) reads as a normal note.
 */
async function resolveSystemOnly(noteId: string): Promise<void> {
  if (!prefs['sources.enabled']) {
    systemOnly.delete(noteId)
    return
  }
  try {
    const view = await window.notula.sources.getForNote({ noteId })
    if (view) systemOnly.add(noteId)
    else systemOnly.delete(noteId)
  } catch {
    systemOnly.delete(noteId)
  }
}

/** Local ASR is startable once its engine is installed; the session fetches a missing model itself. */
async function asrReady(provider: Settings['asr.provider']): Promise<boolean> {
  try {
    if (provider === 'local') {
      // Rejects while no local engine is registered.
      await window.notula.asr.getLocalModelState({})
      return true
    }
    return await window.notula.asr.hasKey({ provider })
  } catch {
    return false
  }
}

// ---------- public API ----------

export type StartResult = { ok: true } | { ok: false; reason: 'busy' | 'note-missing' | 'no-asr' }

/** User-initiated start. Refused while another note transcribes or a start is pending. */
export async function startTranscription(noteId: string): Promise<StartResult> {
  if (snapshot.transcribingNoteId === noteId) return { ok: true }
  if (snapshot.transcribingNoteId || snapshot.pendingStart) return { ok: false, reason: 'busy' }
  const token = {}
  pendingToken = token
  update({ pendingStart: true })
  const finish = (r: StartResult): StartResult => {
    if (pendingToken === token) {
      pendingToken = null
      update({ pendingStart: false })
    }
    return r
  }
  let endedCount = 0
  try {
    const note = await window.notula.notes.get({ id: noteId })
    if (!note || note.deleted_at) return finish({ ok: false, reason: 'note-missing' })
    endedCount = note.ended_count
  } catch {
    return finish({ ok: false, reason: 'note-missing' })
  }
  await loadPrefs()
  if (!(await asrReady(prefs['asr.provider']))) return finish({ ok: false, reason: 'no-asr' })
  await resolveSystemOnly(noteId)
  // Cancelled, or another start won meanwhile.
  if (pendingToken !== token || snapshot.transcribingNoteId) return finish({ ok: false, reason: 'busy' })
  pendingToken = null
  noteSetAt = Date.now()
  // Starting any transcription dismisses the inactivity toast.
  dismissToast(INACTIVITY_TOAST_ID)
  update({ pendingStart: false, transcribingNoteId: noteId })
  if (prefs['capture.sounds']) {
    if (endedCount > 0) sounds.resume()
    else sounds.start()
  }
  return { ok: true }
}

/** Cancels a pending start (the Cancel control). */
export function cancelPendingStart(): void {
  if (!pendingToken) return
  pendingToken = null
  update({ pendingStart: false })
}

export function stopTranscription(reason: StopReason): void {
  const noteId = snapshot.transcribingNoteId
  if (!noteId) {
    cancelPendingStart()
    return
  }
  lastStopReason = reason
  noteSetAt = null
  setVolume('microphone', 0)
  setVolume('system', 0)
  update({ transcribingNoteId: null })
  if (prefs['capture.sounds'] && PAUSE_SOUND_REASONS.has(reason)) sounds.pause()
  // Trash auto-delete path B: a stop from the floating indicator removes a
  // brand-new empty note once its session has drained. Main re-checks every rule.
  if (reason === 'indicator_stop_button') void autoDeleteAfterIndicatorStop(noteId)
}

async function autoDeleteAfterIndicatorStop(noteId: string): Promise<void> {
  try {
    await window.notula.capture.awaitSessionStopped({ noteId })
    await window.notula.notes.autoDeleteIfEmpty({ id: noteId, path: 'indicator' })
  } catch {
    // Not deleted: the note simply stays.
  }
}

/** "Stopped transcribing due to N minutes of inactivity", with Resume, for 30 minutes. */
function showInactivityStopToast(stoppedNoteId: string): void {
  const n = Math.max(1, Math.round(prefs['capture.inactivityAutoStopMinutes'] ?? 0))
  showToast({
    id: INACTIVITY_TOAST_ID,
    title: `Stopped transcribing due to ${n} minute${n === 1 ? '' : 's'} of inactivity`,
    durationMs: INACTIVITY_TOAST_MS,
    action: {
      label: 'Resume',
      onClick: () => {
        // The note transcribing now, if any, else the stopped one.
        const target = snapshot.transcribingNoteId ?? stoppedNoteId
        if (snapshot.transcribingNoteId) return
        navigate(`/meeting/${encodeURIComponent(target)}`)
        void startTranscription(target).then((r) => {
          if (!r.ok) showResumeFailed(r.reason)
        })
      }
    }
  })
}

function showResumeFailed(reason: 'busy' | 'note-missing' | 'no-asr'): void {
  showToast({
    kind: 'error',
    title: 'Couldn’t resume transcription',
    description:
      reason === 'busy'
        ? 'Another note is transcribing.'
        : reason === 'no-asr'
          ? 'Add a Deepgram or AssemblyAI key in Settings to transcribe.'
          : 'This note no longer exists.'
  })
}

export function getCaptureSnapshot(): CaptureSnapshot {
  return snapshot
}

export function subscribeCapture(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useCaptureSnapshot(): CaptureSnapshot {
  return useSyncExternalStore(subscribeCapture, getCaptureSnapshot)
}

// Volume lives apart from the snapshot: it changes ten times a second per source.
let volume: Record<AudioSource, number> = { microphone: 0, system: 0 }
const volumeListeners = new Set<() => void>()
/** Per source, the meter's decaying peak and the level it gives. */
const peaks: Record<AudioSource, number> = { microphone: METER_PEAK_FLOOR, system: METER_PEAK_FLOOR }
let levels: Record<AudioSource, number> = { microphone: 0, system: 0 }

function setVolume(source: AudioSource, rms: number): void {
  // Each source is normalized on its own, so quiet but present audio still moves the bars.
  peaks[source] = Math.max(METER_PEAK_FLOOR, rms, peaks[source] * (1 - METER_DECAY))
  const level = Math.min(1, rms / peaks[source])
  if (volume[source] === rms && levels[source] === level) return
  volume = { ...volume, [source]: rms }
  levels = { ...levels, [source]: level }
  for (const l of volumeListeners) l()
}

function subscribeVolume(cb: () => void): () => void {
  volumeListeners.add(cb)
  return () => volumeListeners.delete(cb)
}

export function useVolume(source: AudioSource): number {
  return useSyncExternalStore(subscribeVolume, () => volume[source])
}

/** The normalized meter levels (0–1) per source. */
export function useMeterLevels(): Record<AudioSource, number> {
  return useSyncExternalStore(subscribeVolume, () => levels)
}

// ---------- stopped by a reload ----------

function rememberReloadStop(noteId: string): void {
  try {
    sessionStorage.setItem(RELOAD_STOP_KEY, JSON.stringify({ noteId, at: Date.now() }))
  } catch {
    // No session storage: the reloaded page just shows Resume, as before.
  }
}

/** The note whose capture this window's last page hide stopped, if that was recent. */
function takeReloadStop(): string | null {
  try {
    const raw = sessionStorage.getItem(RELOAD_STOP_KEY)
    sessionStorage.removeItem(RELOAD_STOP_KEY)
    if (!raw) return null
    const v = JSON.parse(raw) as { noteId?: unknown; at?: unknown }
    if (typeof v.noteId !== 'string' || typeof v.at !== 'number') return null
    return Date.now() - v.at < RELOAD_NOTICE_MAX_AGE_MS ? v.noteId : null
  } catch {
    return null
  }
}

function showReloadStopNotice(noteId: string): void {
  showToast({
    id: 'capture-stopped-by-reload',
    title: 'Transcription stopped when the window reloaded',
    description: 'Resume to keep transcribing this meeting.',
    durationMs: 30_000,
    action: {
      label: 'Resume',
      onClick: () => {
        navigate(`/meeting/${encodeURIComponent(noteId)}`)
        void startTranscription(noteId).then((r) => {
          if (!r.ok) showResumeFailed(r.reason)
        })
      }
    }
  })
}

// ---------- host lifecycle ----------

/** Mounts the engine and the subscriptions; returns the teardown (CaptureEngineHost). */
export function mountCapture(): () => void {
  const api = window.notula
  const engine = new CaptureEngine((e) => api.capture.sendEvent(e))
  const subs = [
    api.capture.onCommand((cmd) => engine.handle(cmd)),
    api.capture.onSystemState((system) => update({ system })),
    api.capture.onVolume(({ source, rms }) => setVolume(source, rms)),
    api.capture.onSystemSourceChanged(({ label }) => update({ systemSourceLabel: label })),
    api.capture.onStopRequested(({ reason }) => {
      const stopped = snapshot.transcribingNoteId
      stopTranscription(reason)
      if (reason === 'idle_timeout' && stopped) showInactivityStopToast(stopped)
    }),
    api.input.onStateChanged((input) => update({ input })),
    api.input.onDevicesChanged((devices) => update({ devices })),
    api.input.onActiveDeviceChanged((activeDevice) => update({ activeDevice })),
    api.transcription.onSessionState((session) => update({ session })),
    api.prefs.onChanged(({ settings }) => {
      applyPrefs(settings)
      update({})
    })
  ]
  engine.init()
  // The bubble document is computed here, in the main window only.
  const stopBubble = startBubbleDocument()

  // window_closed on a real page hide, not a back/forward-cache hide.
  const onPageHide = (e: PageTransitionEvent): void => {
    if (e.persisted) return
    if (snapshot.transcribingNoteId) rememberReloadStop(snapshot.transcribingNoteId)
    stopTranscription('window_closed')
  }
  window.addEventListener('pagehide', onPageHide)

  let alive = true
  void (async () => {
    await loadPrefs()
    // A reloaded renderer adopts the note main is still capturing for.
    try {
      const status = await api.capture.getStatus()
      if (alive && status.capturing && status.noteId && !snapshot.transcribingNoteId) {
        // The adopted desired state names the same sources main runs with.
        await resolveSystemOnly(status.noteId)
        noteSetAt = Date.now() - UI_GRACE_MS
        snapshot = { ...snapshot, transcribingNoteId: status.noteId }
      }
    } catch {
      // Main always answers; nothing to adopt otherwise.
    }
    try {
      const input = await api.input.getState()
      if (alive) snapshot = { ...snapshot, input }
    } catch (err) {
      api.capture.sendEvent({
        type: 'log',
        level: 'warn',
        event: 'input-state-fetch-failed',
        data: { message: err instanceof Error ? err.message : String(err) }
      })
    }
    if (!alive) return
    initialized = true
    update({})
    const stoppedNote = takeReloadStop()
    if (stoppedNote && !snapshot.transcribingNoteId) showReloadStopNotice(stoppedNote)
  })()

  return () => {
    alive = false
    // The transcription view unmounting stops transcription.
    stopTranscription('view_closed')
    window.removeEventListener('pagehide', onPageHide)
    for (const off of subs) off()
    stopBubble()
    engine.dispose()
    initialized = false
    lastSent = ''
  }
}

/**
 * Secondary windows (the bubble and its panels): follow main's capture state and volume
 * without an engine, and never send a desired state.
 */
export function mountCaptureMirror(): () => void {
  const api = window.notula
  const follow = (noteId: string | null): void => {
    if (noteId === snapshot.transcribingNoteId) return
    // Main has been capturing for a while: no start grace.
    noteSetAt = noteId ? Date.now() - UI_GRACE_MS : null
    update({ transcribingNoteId: noteId })
  }
  const subs = [
    api.capture.onSystemState((system) => {
      update({ system })
      follow(system.noteId)
    }),
    api.capture.onVolume(({ source, rms }) => setVolume(source, rms)),
    api.transcription.onSessionState((session) => update({ session }))
  ]
  void api.capture
    .getStatus()
    .then((s) => follow(s.capturing ? s.noteId : null))
    .catch(() => undefined)
  return () => {
    for (const off of subs) off()
  }
}
