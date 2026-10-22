// SPDX-License-Identifier: Apache-2.0
// The transcript plan of a source note.
//
// `captions` when the source is YouTube, `sources.videoCaptions` is on, lookups are granted and a
// track in the video's own language exists (a manual track before auto); else `system-audio`
// (system-only capture, `DesiredCaptureState.audioSources = ['system']`) when transcription is
// set up; else `none`. Decided within 5 s of creation; `pending` until then.
//
// - Deciding: bus `sources:noted` opens a 5 s window. Inside it, `choosePlan` answers `pending`
//   while the enrichment may still list a track (the sources core then stores nothing); this module
//   decides when the enrichment settles or the window ends, with whatever is known. A late
//   enrichment never switches the plan: the user switches it. One exception (a real
//   yt-dlp metadata run takes about 5 s): a plan this module set to `none`
//   because nothing was available moves to `captions` when the enrichment then lists a usable
//   track within the follow window, as long as nothing changed the plan meanwhile. Nothing was
//   recorded under `none`, so nothing flips under the user.
// - `captions` fetches the track at once (`captions.ts`). The written captions supersede every
//   other session of the note: those chunks are kept but hidden (`superseded_session_ids`).
//   Never while the note captures: a start downgrades an unwritten `captions` plan
//   to `system-audio`, and a fetch that ends during a capture or after a plan change keeps its
//   cues in memory (track `ready`) until the user picks Use the video's captions, which stops
//   that note's capture first. The session recording now is never superseded.
// - `system-audio` never starts recording by itself: the transcript panel offers
//   Transcribe audio, and any start on a source note captures system audio only. A start on a
//   note whose plan is `pending` or `none` records the plan as `system-audio`.
// - Transcribe audio while captions exist adds a second session; prompts use the captions while
//   they exist. A failed fetch leaves the plan at `captions` with the track `failed`, and the
//   panel offers Transcribe audio now.
// - System-audio chunks get their video position (`providerDetails.sourcePositionMs`) mapped
//   through the watched spans: after the capture stops and its speaker labels are final, and
//   again when spans change while the note isn't capturing. Prompts map the rest on the fly.
//
// Nothing runs while `sources.enabled` is off or off Windows. Logs carry states and counts only.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, PushChannel, PushPayload } from '@shared/ipc'
import {
  chunkPositionMs,
  isCaptionChunk,
  isUntimedChunk,
  pickCaptionTrack,
  positionFromSpans,
  sourceTranscriptChunks
} from '@shared/lib/source-transcript'
import type { CaptionTrack, NoteSource, SourceTrackState, TranscriptPlan } from '@shared/types/sources'
import { SOURCES_LIMITS } from '@shared/types/sources'
import { DELETED_CHUNK_MARKER, type TranscriptChunk } from '@shared/types/transcript'
import type { MainContext } from '../context'
import type { SourceInputs } from '../enhance/inputs'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { egressBlocked } from '../privacy'
import { transcriptionControl } from '../transcription'
import { getTranscriptionManager } from '../transcription/manager'
import {
  extensionCues,
  extensionTrack,
  fetchWithYtDlp,
  rememberExtensionCaptions,
  sweepCaptionTemp,
  watchUrl,
  writeCaptionTranscript,
  type CaptionsFetch
} from './captions'

export interface PlanDecision {
  plan: TranscriptPlan
  /** `captions`: the track to fetch or read. */
  track: CaptionTrack | null
}

const PLANS: readonly Exclude<TranscriptPlan, 'pending'>[] = ['captions', 'system-audio', 'none']
const ENRICHMENT_POLL_MS = 500
/** Spans settle a moment after playback changes; the mapping waits for them. */
const MAP_DEBOUNCE_MS = 3_000

async function sourcesOn(ctx: MainContext): Promise<boolean> {
  return process.platform === 'win32' && (await ctx.settings.get('sources.enabled')) === true
}

/** Local or cloud transcription is set up (the renderer's start check, from main). */
async function transcriptionReady(ctx: MainContext): Promise<boolean> {
  const provider = await ctx.settings.get('asr.provider')
  // Local is startable once installed; its session fetches a missing model itself.
  if (provider === 'local') return true
  const id = provider === 'deepgram' ? 'asr.deepgram' : 'asr.assemblyai'
  if (await ctx.secrets.has(id)) return true
  return ctx.isDev && (await ctx.secrets.get(id)) !== null
}

/** The caption track the plan may use: the extension's for this video, else yt-dlp's (lookups granted). */
async function usableTrack(ctx: MainContext, source: NoteSource): Promise<CaptionTrack | null> {
  if (source.live || source.kind === 'live') return null
  if (!(await ctx.settings.get('sources.videoCaptions'))) return null
  if ((await ctx.settings.get('sources.extension.captions')) !== false) {
    const ext = extensionTrack(source.canonical_key)
    if (ext) return ext
  }
  if (source.provider !== 'youtube' || !watchUrl(source)) return null
  if (!(await ctx.settings.get('sources.onlineLookups'))) return null
  if ((await ctx.settings.get('sources.ytDlp')) === 'off') return null
  if (await egressBlocked(ctx, { kind: 'source-captions' })) return null
  return pickCaptionTrack(source.enrichment, { live: source.live })
}

/** Per note, the end of its decision window (from `sources:noted`). */
const decideBy = new Map<string, number>()

/** Captions could still turn up: a YouTube video whose enrichment hasn't answered, lookups on. */
async function captionsMayCome(ctx: MainContext, source: NoteSource): Promise<boolean> {
  if (enrichmentSettled(source) || !watchUrl(source)) return false
  if (!(await ctx.settings.get('sources.videoCaptions')) || !(await ctx.settings.get('sources.onlineLookups'))) return false
  if ((await ctx.settings.get('sources.ytDlp')) === 'off') return false
  return !(await egressBlocked(ctx, { kind: 'source-captions' }))
}

/**
 * The plan for a source as things stand (nothing written). `pending` only inside the note's
 * 5 s decision window, while the enrichment may still list a caption track.
 */
export async function choosePlan(ctx: MainContext, source: NoteSource): Promise<PlanDecision> {
  if (!(await sourcesOn(ctx))) return { plan: 'none', track: null }
  const track = await usableTrack(ctx, source)
  if (track) return { plan: 'captions', track }
  const until = decideBy.get(source.note_id)
  if (until !== undefined && Date.now() < until && source.transcript_plan === 'pending' && (await captionsMayCome(ctx, source))) {
    return { plan: 'pending', track: null }
  }
  if (await transcriptionReady(ctx)) return { plan: 'system-audio', track: null }
  return { plan: 'none', track: null }
}

// ---------- pushes ----------

function pushProgress(ctx: MainContext, p: PushPayload<'sources:captions-progress'>): void {
  for (const wc of ctx.windows.targets()) wc.send('sources:captions-progress' satisfies PushChannel, p)
}

// ---------- fetching ----------

/** One fetch per note at a time. */
const fetching = new Map<string, Promise<void>>()

/** The capture running per note, from `capture:started` until its `capture:stopped`. */
const runs = new Map<string, { sessionId: string; systemOnly: boolean }>()

/**
 * True while `noteId` captures system audio only (a source note's run). The feed's end of watching
 * stops such a capture whatever its plan says.
 */
export function isSystemOnlyCapture(noteId: string): boolean {
  return runs.get(noteId)?.systemOnly === true
}

/**
 * Cues fetched while the note captured, or after the user chose another plan. They
 * aren't written: the track is `ready`, and the panel offers Use the video's captions, which
 * writes these without fetching again. Memory only; a restart fetches again.
 */
const held = new Map<string, { key: string; track: CaptionTrack; cues: Extract<CaptionsFetch, { ok: true }>['cues'] }>()
const HELD_MAX = 20

function hold(noteId: string, key: string, track: CaptionTrack, cues: Extract<CaptionsFetch, { ok: true }>['cues']): void {
  held.delete(noteId)
  held.set(noteId, { key, track, cues })
  while (held.size > HELD_MAX) {
    const oldest = held.keys().next().value
    if (oldest === undefined) break
    held.delete(oldest)
  }
}

function sameTrack(a: CaptionTrack, b: CaptionTrack): boolean {
  return a.via === b.via && a.kind === b.kind && a.lang === b.lang
}

/** Every session id of the note's chunks other than `keep` and the one recording now. */
function otherSessions(chunks: TranscriptChunk[], keep: string, live: string | null): string[] {
  return [...new Set(chunks.map((c) => c.transcription_session_id))].filter((id) => id !== keep && id !== live)
}

async function setTrack(ctx: MainContext, noteId: string, track_state: SourceTrackState, reason: string | null): Promise<void> {
  await ctx.storage.updateNoteSource(noteId, { track_state }).catch((err: unknown) => log('warn', 'sources:track-state-write-failed', { err }))
  pushProgress(ctx, { noteId, state: track_state, reason })
}

async function runFetch(ctx: MainContext, noteId: string): Promise<void> {
  const source = await ctx.storage.getNoteSource(noteId)
  if (!source) return
  const track = await usableTrack(ctx, source)
  if (!track) {
    await setTrack(ctx, noteId, 'unavailable', 'no-track')
    return
  }
  const t0 = Date.now()
  let got: CaptionsFetch
  const kept = held.get(noteId)
  if (kept && kept.key === source.canonical_key && sameTrack(kept.track, track)) got = { ok: true, cues: kept.cues }
  else {
    await setTrack(ctx, noteId, 'fetching', null)
    if (track.via === 'extension') got = extensionCues(source.canonical_key)
    else {
      const url = watchUrl(source)
      got = url ? await fetchWithYtDlp(ctx, url, track) : { ok: false, reason: 'no-track' }
    }
  }
  if (!got.ok) {
    const state: SourceTrackState = got.reason === 'no-track' || got.reason === 'empty' ? 'unavailable' : 'failed'
    log('info', 'sources:captions-failed', { reason: got.reason, via: track.via, ms: Date.now() - t0 })
    await setTrack(ctx, noteId, state, got.reason)
    return
  }
  // The note may have been unlinked or deleted while the fetch ran.
  const now = await ctx.storage.getNoteSource(noteId)
  if (!now || now.canonical_key !== source.canonical_key) return
  // The note started capturing, or the user chose another plan, while the fetch ran: the
  // captions wait until the user picks them, and nothing they record is hidden.
  if (now.transcript_plan !== 'captions' || ctx.capture.currentNoteId() === noteId) {
    hold(noteId, now.canonical_key, track, got.cues)
    await ctx.storage.updateNoteSource(noteId, { track_state: 'ready', track_language: track.lang })
    log('info', 'sources:captions-held', { via: track.via, kind: track.kind, plan: now.transcript_plan, capturing: ctx.capture.currentNoteId() === noteId })
    pushProgress(ctx, { noteId, state: 'ready', reason: null })
    return
  }
  held.delete(noteId)
  const { sessionId, chunks } = await writeCaptionTranscript(ctx, noteId, got.cues, track)
  const all = await transcriptionControl(ctx).getTranscript(noteId)
  const after = await ctx.storage.getNoteSource(noteId)
  // Never the session recording now: a capture that started during the write keeps its audio.
  const live = runs.get(noteId)?.sessionId ?? null
  const superseded = [...new Set([...(after?.superseded_session_ids ?? []), ...otherSessions(all, sessionId, live)])]
  await ctx.storage.updateNoteSource(noteId, {
    track_state: 'ready',
    track_language: track.lang,
    transcript_plan: 'captions',
    superseded_session_ids: superseded
  })
  log('info', 'sources:captions-ready', { chunks, via: track.via, kind: track.kind, superseded: superseded.length, ms: Date.now() - t0 })
  pushProgress(ctx, { noteId, state: 'ready', reason: null })
}

/** Starts a fetch unless one runs; resolves when it ends. Never throws. */
function startFetch(ctx: MainContext, noteId: string): Promise<void> {
  const running = fetching.get(noteId)
  if (running) return running
  const run = runFetch(ctx, noteId)
    .catch(async (err: unknown) => {
      log('warn', 'sources:captions-error', { err })
      await setTrack(ctx, noteId, 'failed', 'failed')
    })
    .finally(() => fetching.delete(noteId))
  fetching.set(noteId, run)
  return run
}

// ---------- deciding ----------

const deciding = new Set<string>()

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** True once nothing more is coming that would change the plan. */
function enrichmentSettled(s: NoteSource): boolean {
  if (s.provider !== 'youtube' || s.live) return true
  const state = s.enrichment?.state
  return state === 'done' || state === 'failed'
}

/**
 * A `captions` plan whose track isn't fetched yet starts its fetch: a plan the sources core stored straight
 * from `choosePlan`, or a fetch an earlier run quit in the middle of. Idempotent.
 */
async function follow(ctx: MainContext, noteId: string): Promise<void> {
  let s = await ctx.storage.getNoteSource(noteId)
  if (s && s.transcript_plan === 'none' && autoNone.has(noteId) && enrichmentSettled(s)) s = await lateCaptions(ctx, s)
  if (!s || s.transcript_plan !== 'captions' || fetching.has(noteId)) return
  if (s.track_state !== 'none' && s.track_state !== 'queued') return
  if (s.track_state === 'none') pushProgress(ctx, { noteId, state: 'queued', reason: null })
  void startFetch(ctx, noteId)
}

/** Notes noted in the last minute: a plan written for them is followed (`storage:changed`). */
const recentlyNoted = new Map<string, number>()
const FOLLOW_MS = 60_000

/** Notes whose plan this module set to `none` at the end of the window (nothing was available). */
const autoNone = new Set<string>()

/** The enrichment answered after the window and lists a usable track: `none` becomes `captions`. */
async function lateCaptions(ctx: MainContext, s: NoteSource): Promise<NoteSource> {
  autoNone.delete(s.note_id)
  if (ctx.capture.currentNoteId() === s.note_id) return s
  const decision = await choosePlan(ctx, s)
  if (decision.plan !== 'captions') return s
  const fresh = await ctx.storage.getNoteSource(s.note_id)
  if (!fresh || fresh.transcript_plan !== 'none' || fresh.track_state !== 'none') return fresh ?? s
  log('info', 'sources:plan-decided', { plan: 'captions', via: decision.track?.via ?? null, late: true })
  return ctx.storage.updateNoteSource(s.note_id, { transcript_plan: 'captions', track_state: 'queued' })
}

/** A noted source note: decides a `pending` plan within its 5 s window, then follows the plan. */
async function decide(ctx: MainContext, noteId: string): Promise<void> {
  if (deciding.has(noteId)) return
  deciding.add(noteId)
  try {
    const deadline = decideBy.get(noteId) ?? Date.now() + SOURCES_LIMITS.planDecideMs
    let source = await ctx.storage.getNoteSource(noteId)
    while (source && source.transcript_plan === 'pending' && !enrichmentSettled(source) && Date.now() < deadline) {
      await sleep(Math.min(ENRICHMENT_POLL_MS, Math.max(0, deadline - Date.now())))
      source = await ctx.storage.getNoteSource(noteId)
    }
    if (!source) return
    if (source.transcript_plan === 'pending') {
      // The window is over (or the enrichment settled): decide with what is known.
      decideBy.delete(noteId)
      const decision = await choosePlan(ctx, source)
      const fresh = await ctx.storage.getNoteSource(noteId)
      // Someone else (the sources core, a start, the user) decided meanwhile: that plan stands.
      if (fresh && fresh.transcript_plan === 'pending' && decision.plan !== 'pending') {
        await ctx.storage.updateNoteSource(noteId, {
          transcript_plan: decision.plan,
          ...(decision.plan === 'captions' ? { track_state: 'queued' as const } : {})
        })
        if (decision.plan === 'none' && !enrichmentSettled(source)) autoNone.add(noteId)
        log('info', 'sources:plan-decided', {
          plan: decision.plan,
          via: decision.track?.via ?? null,
          waitedMs: SOURCES_LIMITS.planDecideMs - Math.max(0, deadline - Date.now())
        })
      }
    }
    await follow(ctx, noteId)
  } catch (err) {
    log('warn', 'sources:plan-decide-failed', { err })
  } finally {
    deciding.delete(noteId)
    decideBy.delete(noteId)
  }
}

// ---------- switching ----------

/** `sources:set-transcript-plan`. */
async function setPlan(ctx: MainContext, noteId: string, plan: Exclude<TranscriptPlan, 'pending'>): Promise<NoteSource> {
  autoNone.delete(noteId)
  const source = await ctx.storage.getNoteSource(noteId)
  if (!source) throw expected(notulaError('not-found', 'This note has no source.'))
  if (plan !== 'captions') {
    // Transcribe audio keeps the captions read-only: the audio becomes a second session.
    log('info', 'sources:plan-set', { plan })
    return ctx.storage.updateNoteSource(noteId, { transcript_plan: plan })
  }
  // Use the video's captions during this note's capture stops the capture first: its audio
  // would only be hidden, and a session still recording is never superseded.
  if (ctx.capture.currentNoteId() === noteId) {
    log('info', 'sources:plan-set-stops-capture', { plan })
    await ctx.capture.stop('toggle_off')
  }
  const chunks = await transcriptionControl(ctx).getTranscript(noteId)
  const hidden = new Set(source.superseded_session_ids)
  const captionSessions = new Set(chunks.filter((c) => isCaptionChunk(c) && !hidden.has(c.transcription_session_id)).map((c) => c.transcription_session_id))
  if (captionSessions.size > 0) {
    // Use the video's captions: the audio sessions are hidden, never deleted.
    const live = runs.get(noteId)?.sessionId ?? null
    const superseded = [...new Set([...source.superseded_session_ids, ...chunks.map((c) => c.transcription_session_id).filter((id) => !captionSessions.has(id) && id !== live)])]
    log('info', 'sources:plan-set', { plan, superseded: superseded.length })
    return ctx.storage.updateNoteSource(noteId, { transcript_plan: 'captions', superseded_session_ids: superseded })
  }
  if (!(await usableTrack(ctx, source))) throw expected(notulaError('invalid-input', 'This video has no captions in its own language.'))
  const updated = await ctx.storage.updateNoteSource(noteId, { transcript_plan: 'captions', track_state: 'queued' })
  log('info', 'sources:plan-set', { plan })
  pushProgress(ctx, { noteId, state: 'queued', reason: null })
  void startFetch(ctx, noteId)
  return updated
}

// ---------- video positions of system-audio chunks ----------

/** System-audio chunks with their positions through the spans (memory only). */
function withPositions(chunks: TranscriptChunk[], spans: Parameters<typeof positionFromSpans>[1], fallbackProvider: string): TranscriptChunk[] {
  if (!spans.length) return chunks
  return chunks.map((c) => {
    if (isCaptionChunk(c) || isUntimedChunk(c) || chunkPositionMs(c) !== null || c.text === DELETED_CHUNK_MARKER) return c
    const pos = positionFromSpans(Date.parse(c.start_timestamp), spans)
    return pos === null ? c : withPosition(c, pos, fallbackProvider)
  })
}

function withPosition(c: TranscriptChunk, pos: number, fallbackProvider: string): TranscriptChunk {
  const d = c.providerDetails
  return {
    ...c,
    providerDetails: d
      ? { ...d, sourcePositionMs: pos }
      : // Only the position is meaningful: no words, the note's latest provider for the record.
        { words: [], provider: fallbackProvider as NonNullable<TranscriptChunk['providerDetails']>['provider'], model: '', wallClockAnchorMs: Date.parse(c.start_timestamp), sourcePositionMs: pos }
  }
}

/**
 * Writes the video positions of the note's stored system-audio chunks. Skipped while the note
 * captures: the live session (and its speaker pass) still rewrites those chunks.
 */
async function mapPositions(ctx: MainContext, noteId: string): Promise<void> {
  if (!(await sourcesOn(ctx)) || ctx.capture.currentNoteId() === noteId) return
  const source = await ctx.storage.getNoteSource(noteId)
  if (!source) return
  const spans = await ctx.storage.listSourceSpans(noteId)
  if (!spans.length) return
  const session = await ctx.storage.latestSession(noteId).catch(() => null)
  const provider = session?.provider ?? 'local'
  const stored = await ctx.storage.getTranscript(noteId)
  const changed: TranscriptChunk[] = []
  for (const c of stored) {
    if (isCaptionChunk(c) || isUntimedChunk(c) || !c.is_final || c.text === DELETED_CHUNK_MARKER) continue
    const pos = positionFromSpans(Date.parse(c.start_timestamp), spans)
    if (pos === null || chunkPositionMs(c) === pos) continue
    changed.push(withPosition(c, pos, provider))
  }
  if (!changed.length) return
  await getTranscriptionManager(ctx).store.publishRevisions(noteId, changed)
  log('info', 'sources:positions-mapped', { chunks: changed.length, spans: spans.length })
}

const mapTimers = new Map<string, NodeJS.Timeout>()

function scheduleMap(ctx: MainContext, noteId: string, delayMs = MAP_DEBOUNCE_MS): void {
  const prev = mapTimers.get(noteId)
  if (prev) clearTimeout(prev)
  mapTimers.set(
    noteId,
    setTimeout(() => {
      mapTimers.delete(noteId)
      void mapPositions(ctx, noteId).catch((err: unknown) => log('warn', 'sources:positions-map-failed', { err }))
    }, delayMs)
  )
}

// ---------- prompt inputs ----------

/**
 * A note's source facts and the transcript its prompts use: superseded sessions
 * left out, captions only while they exist, and system-audio chunks placed on the video
 * timeline. A note without a source (every meeting) gets its chunks back untouched.
 */
export async function sourcePromptInputs(
  ctx: MainContext,
  noteId: string,
  chunks: TranscriptChunk[]
): Promise<{ source: SourceInputs | null; chunks: TranscriptChunk[] }> {
  try {
    const source = await ctx.storage.getNoteSource(noteId)
    if (!source) return { source: null, chunks }
    // The transcript rules are data rules, kept while Sources is off too: storage
    // already leaves out superseded sessions, and captions win over a second audio session.
    let used = sourceTranscriptChunks(chunks, source)
    if (!(await sourcesOn(ctx))) return { source: null, chunks: used }
    const series = source.series_id ? await ctx.storage.getSeries(source.series_id).catch(() => null) : null
    if (used.some((c) => !isCaptionChunk(c) && chunkPositionMs(c) === null)) {
      const [spans, session] = await Promise.all([ctx.storage.listSourceSpans(noteId), ctx.storage.latestSession(noteId).catch(() => null)])
      used = withPositions(used, spans, session?.provider ?? 'local')
    }
    return { source: { source, series: series ? { kind: series.kind, title: series.title } : null }, chunks: used }
  } catch (err) {
    log('warn', 'sources:prompt-inputs-failed', { err })
    return { source: null, chunks }
  }
}

// ---------- registration ----------

function noteIdOf(req: unknown): string {
  const id = (req as { noteId?: unknown } | null)?.noteId
  if (typeof id !== 'string' || !id || id.length > 200) throw expected(notulaError('invalid-input', 'noteId is required.'))
  return id
}

async function requireSources(ctx: MainContext): Promise<void> {
  if (!(await sourcesOn(ctx))) throw expected(notulaError('invalid-input', 'Sources is off.'))
}

/** `sources:fetch-captions`, `sources:set-transcript-plan`, push `sources:captions-progress`. */
export function registerTranscriptPlan(ctx: MainContext): void {
  void sweepCaptionTemp()

  ipcMain.handle('sources:fetch-captions' satisfies InvokeChannel, async (_e, req: InvokeReq<'sources:fetch-captions'>): Promise<{ state: SourceTrackState }> => {
    await requireSources(ctx)
    const noteId = noteIdOf(req)
    const source = await ctx.storage.getNoteSource(noteId)
    if (!source) throw expected(notulaError('not-found', 'This note has no source.'))
    if (fetching.has(noteId)) return { state: 'fetching' }
    if (!(await usableTrack(ctx, source))) {
      await setTrack(ctx, noteId, 'unavailable', 'no-track')
      return { state: 'unavailable' }
    }
    await setTrack(ctx, noteId, 'queued', null)
    void startFetch(ctx, noteId)
    return { state: 'queued' }
  })

  ipcMain.handle('sources:set-transcript-plan' satisfies InvokeChannel, async (_e, req: InvokeReq<'sources:set-transcript-plan'>): Promise<NoteSource> => {
    await requireSources(ctx)
    const noteId = noteIdOf(req)
    const plan = (req as { plan?: unknown } | null)?.plan
    if (typeof plan !== 'string' || !PLANS.includes(plan as Exclude<TranscriptPlan, 'pending'>)) {
      throw expected(notulaError('invalid-input', 'Unknown transcript plan.'))
    }
    return setPlan(ctx, noteId, plan as Exclude<TranscriptPlan, 'pending'>)
  })

  ctx.bus.on('sources:noted', ({ noteId }) => {
    // Synchronously, before the sources core asks `choosePlan` right after this event.
    decideBy.set(noteId, Date.now() + SOURCES_LIMITS.planDecideMs)
    recentlyNoted.set(noteId, Date.now() + FOLLOW_MS)
    void sourcesOn(ctx).then(async (on) => {
      if (on) await decide(ctx, noteId)
      else decideBy.delete(noteId)
    })
  })

  ctx.bus.on('media:extension-captions', (e) => rememberExtensionCaptions(e))

  // Any start on a source note is system-only capture: the plan says so. A `captions` plan whose
  // track isn't written yet becomes `system-audio` too: a fetch still running then holds its
  // captions instead of hiding this recording, and the end of watching applies.
  ctx.bus.on('capture:started', ({ noteId, sessionId, audioSources }) => {
    for (const [id] of runs) if (id !== noteId) runs.delete(id)
    runs.set(noteId, { sessionId, systemOnly: !!audioSources && !audioSources.includes('microphone') })
    void (async () => {
      if (!(await sourcesOn(ctx))) return
      const source = await ctx.storage.getNoteSource(noteId)
      if (!source) return
      const plan = source.transcript_plan
      if (plan !== 'pending' && plan !== 'none' && !(plan === 'captions' && source.track_state !== 'ready')) return
      await ctx.storage.updateNoteSource(noteId, { transcript_plan: 'system-audio' })
      log('info', 'sources:plan-set', { plan: 'system-audio', by: 'capture', from: plan })
    })().catch((err: unknown) => log('warn', 'sources:plan-capture-failed', { err }))
  })

  // After a capture: its final chunks (and speaker labels) are stored, then mapped.
  ctx.bus.on('capture:stopped', ({ noteId, sessionId }) => {
    if (runs.get(noteId)?.sessionId === sessionId) runs.delete(noteId)
    void (async () => {
      if (!(await sourcesOn(ctx))) return
      const source = await ctx.storage.getNoteSource(noteId)
      if (!source) return
      // Captions held only because the note was capturing, with the plan still `captions`.
      if (held.has(noteId) && source.transcript_plan === 'captions') void startFetch(ctx, noteId)
      await transcriptionControl(ctx).awaitSpeakerLabels(noteId)
      scheduleMap(ctx, noteId)
    })().catch((err: unknown) => log('warn', 'sources:positions-after-stop-failed', { err }))
  })

  // Spans close as playback changes; a note that isn't capturing maps again.
  ctx.bus.on('storage:changed', ({ tables, ids }) => {
    if (tables.includes('note_sources') && recentlyNoted.size) {
      const now = Date.now()
      for (const [id, until] of recentlyNoted) {
        if (until < now) {
          recentlyNoted.delete(id)
          autoNone.delete(id)
        } else if (ids.includes(id) && !deciding.has(id)) void follow(ctx, id).catch((err: unknown) => log('warn', 'sources:plan-follow-failed', { err }))
      }
    }
    if (!tables.includes('source_spans')) return
    for (const id of ids) if (ctx.capture.currentNoteId() !== id) scheduleMap(ctx, id)
  })
}
