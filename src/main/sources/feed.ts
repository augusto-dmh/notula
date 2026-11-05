// SPDX-License-Identifier: Apache-2.0
// The position feed of the open source note.
//
// - The fed note is the source note on screen, else the capturing source note (its system-audio
//   chunks are mapped through the spans even while the user looks elsewhere). Take notes and
//   Continue pick it at once, before the window navigates.
// - Binding: the note follows one playback whose identified key equals the note's key. The
//   passive provider's machine (`mediaFeed`) owns the binding, the spans and the position; a new
//   title loses the binding until it is identified again with the same key, then it binds again.
//   A different key never stamps this note.
// - `sources:position` about once a second while a note is fed; stamping is off while a Next
//   item card waits, during an ad, without a known position, or with `sources.stampPositions` off.
// - Spans go to storage through the span writer.
// - End of watching: while a source note captures system audio only (or with the `system-audio`
//   plan; Transcribe audio next to captions keeps `captions`), its playback gone
//   (ended or removed) for 3 min, or paused for 15 min, stops the capture with reason
//   `source_ended`. Nothing is generated: the note offers Generate notes.
// - Finished (Courses): when a source note's capture stops (after its final flush), its lesson
//   counts as finished, from the note's own lesson only (its key, or the bound title first seen
//   with the same duration; the furthest position), at a
//   position ≥ 90 % of the duration, or a session that ended within the last 60 s of it; a live
//   playback, ended after ≥ 10 min watched. Bus `sources:lesson-finished` then, once per finish
//   (lesson notes and the end strip follow it).
// - Continuing after a stop: a playback with the stopped note's key that plays again within
//   `RESUME_WINDOW_MS` of an end-of-watching stop is reported (`resumed`); the sources core
//   continues that note when its course records automatically.
// - A mark (the extension's shortcut, the global shortcut) appends a stamped paragraph to the fed
//   note through the `sources:mark` push.
// Logs carry states and counts only.

import type { PushChannel } from '@shared/ipc'
import type { Settings } from '@shared/types/settings'
import type { CanonicalKey, NoteSource, Playback, PlaybackProviderId, SourcePosition } from '@shared/types/sources'
import { SOURCES_LIMITS } from '@shared/types/sources'
import type { BusEvents } from '../bus'
import type { MainContext } from '../context'
import { log } from '../log'
import { mediaFeed } from '../media'
import type { BindingState } from '../media/machine'
import type { FeedView, Track } from './offer'
import { watchedMsOf } from '../enhance/transcript'
import { foldFinishSample, isFinished, playbackEndedAt, type FinishSample } from './automation'
import { isSystemOnlyCapture } from './plan'
import { SpanWriter } from './spans'

const TICK_MS = 1_000
/** A note stopped at the end of watching continues when its video plays again within this. */
const RESUME_WINDOW_MS = 2 * 60 * 60_000
/** A captions note's finish is checked at most this often (a lost binding binds again). */
const CAPTION_FINISH_QUIET_MS = 10 * 60_000
/** The finish check waits at most this long for the stopped session's final flush. */
const STOP_WAIT_MS = 30_000

interface FedNote {
  noteId: string
  key: CanonicalKey
  /** The canonical key of its series, for Next item. */
  seriesKey: CanonicalKey | null
  /** The playback it was opened from, before identification of the playback is known here. */
  playbackHint: string | null
}

interface Bound {
  playbackId: string
  provider: PlaybackProviderId
  browser: string
  tabKey: string | null
}

interface Watch {
  noteId: string
  seen: boolean
  goneSince: number | null
  pausedSince: number | null
  stopped: boolean
  /** The note's own lesson during this capture: its furthest position, duration and first title (automation.ts). */
  sample: FinishSample
  /** When this capture of the note was first watched: its `capture:stopped` comes after. */
  since: number
  seriesId: string | null
  /** The playback was gone (ended or removed), not paused, at the last check. */
  ended: boolean
}

export interface FeedHooks {
  settings(): Settings
  /** Present tracks, most recently updated first (offer.ts). */
  tracks(): Track[]
  /** The capture of a source note stopped at the end of watching: offer Generate notes. */
  watchingEnded(noteId: string): void
  /** A note stopped at the end of watching: its video plays again (in this playback). */
  resumed(noteId: string, playback: Playback): void
  /**
   * The playback an automatic start began this note from (course-auto), or null. The watch counts
   * it whatever its key: a course app's note can carry the address History found while the
   * playback's own draft still has a guessed key.
   */
  startedFrom?(noteId: string): string | null
}

export class SourceFeed implements FeedView {
  private active = false
  private note: FedNote | null = null
  /**
   * The note Take notes or Continue just opened; wins until the window shows another note, or
   * shows no note once it was on screen (otherwise going back to Home kept feeding
   * it, so a replay was never offered Continue).
   */
  private preferred: string | null = null
  private preferredShown = false
  private bound: Bound | null = null
  private bindingState: BindingState = 'unbound'
  /** When and where the fed note's playback ended or was replaced (Next item). */
  private lastEnd: { at: number; browser: string } | null = null
  private held = false
  private watch: Watch | null = null
  /** The note the end of watching stopped, until its video plays again or the window passes. */
  private lastStopped: { noteId: string; key: CanonicalKey; at: number } | null = null
  /** The fed note's newest known position (a captions note's finish). */
  private fedLast: { noteId: string; positionMs: number } | null = null
  /** When a captions note's finish was last checked. */
  private readonly captionFinishes = new Map<string, number>()
  private timer: NodeJS.Timeout | null = null
  private selecting: Promise<void> = Promise.resolve()
  private readonly sources = new Map<string, NoteSource | null>()
  private readonly writer: SpanWriter
  private readonly offs: (() => void)[] = []
  /** When each note's capture last stopped (`capture:stopped`, after its final flush). */
  private readonly stoppedAt = new Map<string, number>()
  private readonly stopWaiters: (() => void)[] = []
  /** The bound playback went into an ad state at this time (the end → ad pod → next item shape). */
  private adSince: number | null = null

  constructor(
    private readonly ctx: MainContext,
    private readonly hooks: FeedHooks
  ) {
    this.writer = new SpanWriter(ctx)
    ctx.bus.on('capture:stopped', ({ noteId }) => {
      this.stoppedAt.set(noteId, Date.now())
      if (this.stoppedAt.size > 50) this.stoppedAt.delete(this.stoppedAt.keys().next().value as string)
      for (const w of this.stopWaiters.splice(0)) w()
    })
  }

  /** Resolves once `noteId`'s `capture:stopped` (its final flush) came at or after `since`, or after a cap. */
  private async stoppedSince(noteId: string, since: number): Promise<void> {
    // A captions note records nothing: no session to wait for.
    if (since <= 0) return
    const until = Date.now() + STOP_WAIT_MS
    while ((this.stoppedAt.get(noteId) ?? -1) < since && Date.now() < until) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, Math.max(0, until - Date.now()))
        this.stopWaiters.push(() => {
          clearTimeout(t)
          resolve()
        })
      })
    }
  }

  // ---------- life cycle ----------

  setActive(on: boolean): void {
    if (on === this.active) return
    this.active = on
    if (on) {
      this.offs.push(
        mediaFeed.onSpan((e) => this.writer.add(e.noteId, e.span)),
        mediaFeed.onBinding((e) => this.onBinding(e.noteId, e.state, e.playbackId))
      )
      this.reselect()
      return
    }
    for (const off of this.offs.splice(0)) off()
    if (this.note) this.unbind()
    this.note = null
    this.preferred = null
    this.preferredShown = false
    this.watch = null
    this.lastStopped = null
    this.sources.clear()
    this.stopTimer()
    void this.writer.flush()
    this.emitFeed()
  }

  /** At quit: the open span is closed and every queued span written. */
  async shutdown(): Promise<void> {
    if (this.note) this.unbind()
    await this.writer.flush()
  }

  /** Storage changed these notes' sources: forget the cached rows, then re-select. */
  sourcesChanged(noteIds: string[]): void {
    for (const id of noteIds) this.sources.delete(id)
    if (this.active && noteIds.some((id) => id === this.note?.noteId || id === this.ctx.capture.currentNoteId() || id === this.ctx.ui.viewingNoteId())) {
      this.reselect()
    }
  }

  async sourceOf(noteId: string): Promise<NoteSource | null> {
    if (this.sources.has(noteId)) return this.sources.get(noteId) ?? null
    const s = await this.ctx.storage.getNoteSource(noteId).catch(() => null)
    this.sources.set(noteId, s)
    if (this.sources.size > 200) this.sources.delete(this.sources.keys().next().value as string)
    return s
  }

  /** The main window is up: no note on screen then means the user left it (a minimized window doesn't). */
  private mainShown(): boolean {
    const win = this.ctx.windows.main()
    return !!win && win.isVisible() && !win.isMinimized()
  }

  /** Take notes / Continue / Switch note: feed this note now, bound to that playback when given. */
  prefer(noteId: string, playbackId: string | null): void {
    this.sources.delete(noteId)
    this.preferred = noteId
    this.preferredShown = false
    this.reselect(playbackId)
  }

  /** The note on screen or the capture changed. */
  reselect(playbackHint: string | null = null): void {
    this.selecting = this.selecting
      .then(() => this.select(playbackHint))
      .catch((err: unknown) => log('warn', 'sources:feed-select-failed', { err }))
  }

  private async select(playbackHint: string | null): Promise<void> {
    if (!this.active) return
    const viewing = this.ctx.ui.viewingNoteId()
    if (this.preferred && viewing === this.preferred) this.preferredShown = true
    else if (this.preferred && (viewing || (this.preferredShown && this.mainShown()))) this.preferred = null
    const candidates = [this.preferred, viewing, this.ctx.capture.currentNoteId()].filter((x): x is string => !!x)
    let next: { id: string; source: NoteSource } | null = null
    for (const id of candidates) {
      const source = await this.sourceOf(id)
      if (source) {
        next = { id, source }
        break
      }
    }
    if (!this.active) return
    const cur = this.note
    if (!next) {
      if (cur) {
        this.unbind()
        this.note = null
        this.emitFeed()
        log('info', 'sources:feed', { state: 'none' })
      }
      this.syncTimer()
      return
    }
    const sameNote = cur?.noteId === next.id
    if (sameNote && cur.key === next.source.canonical_key && !playbackHint) return
    if (cur && !sameNote) this.unbind()
    const seriesKey = next.source.series_id ? ((await this.ctx.storage.getSeries(next.source.series_id).catch(() => null))?.canonical_key ?? null) : null
    this.note = { noteId: next.id, key: next.source.canonical_key, seriesKey, playbackHint: playbackHint ?? (sameNote ? cur.playbackHint : null) }
    if (!sameNote) this.lastEnd = null
    log('info', 'sources:feed', { state: 'note' })
    this.tryBind()
    this.syncTimer()
  }

  // ---------- binding ----------

  /** Binds the fed note to the best present playback with its key (or its hint). */
  private tryBind(): void {
    const n = this.note
    if (!n) return
    const tracks = this.hooks.tracks()
    const hinted = n.playbackHint ? tracks.find((t) => t.playback.id === n.playbackHint) : undefined
    const keyed = tracks.filter((t) => t.draft?.canonicalKey === n.key)
    const pick = hinted ?? keyed.find((t) => t.playback.status === 'playing') ?? keyed[0]
    if (!pick) return
    if (this.bound?.playbackId === pick.playback.id && (this.bindingState === 'bound' || this.bindingState === 'ad')) return
    this.bind(n, pick.playback)
  }

  private bind(n: FedNote, p: Playback): void {
    this.bound = { playbackId: p.id, provider: p.provider, browser: p.browser, tabKey: p.tabKey }
    if (p.provider === 'media-session') {
      mediaFeed.bind(n.noteId, n.key, p.id)
    } else {
      // Another provider (the extension) feeds positions itself; no machine binding.
      this.bindingState = 'bound'
    }
    if (this.held) mediaFeed.hold(true)
    this.emitFeed()
  }

  private unbind(): void {
    if (this.bound?.provider === 'media-session' || mediaFeed.binding()) mediaFeed.unbind()
    this.bound = null
    this.bindingState = 'unbound'
    this.adSince = null
    this.setHeld(false)
  }

  private onBinding(noteId: string, state: BindingState, playbackId: string | null): void {
    if (noteId !== this.note?.noteId) return
    const prev = this.bound
    const wasFollowing = this.bindingState === 'bound' || this.bindingState === 'ad'
    const prevState = this.bindingState
    this.bindingState = state
    const now = Date.now()
    if (state === 'ad' && prevState !== 'ad') this.adSince = now
    else if (state !== 'ad' && state !== 'ended' && state !== 'lost') this.adSince = null
    if ((state === 'ended' || state === 'lost') && prev) {
      // Next item: a new candidate of the same series in this browser within 30 s of play time.
      // After an ad pod the machine releases the item only when the next one arrives: it ended
      // when the ads began, so the window (ads left out, 5 min cap) starts there.
      if (wasFollowing) this.lastEnd = { at: playbackEndedAt(prevState, this.adSince, now), browser: prev.browser }
      this.adSince = null
      if (wasFollowing) void this.fedFinishCheck(noteId, state === 'ended').catch((err: unknown) => log('warn', 'sources:finish-check-failed', { err }))
      this.bound = null
      if (this.note) this.note.playbackHint = null
      this.emitFeed()
    } else if (state === 'bound' && playbackId && prev?.playbackId !== playbackId) {
      const p = this.hooks.tracks().find((t) => t.playback.id === playbackId)?.playback
      if (p) this.bound = { playbackId, provider: p.provider, browser: p.browser, tabKey: p.tabKey }
      this.emitFeed()
    }
    this.syncTimer()
  }

  /** A playback was identified (offer.ts): bind again when it carries the fed note's key. */
  identified(t: Track): void {
    const n = this.note
    if (!this.active || !n || t.draft?.canonicalKey !== n.key) return
    if (this.bound && (this.bindingState === 'bound' || this.bindingState === 'ad') && this.bound.playbackId !== t.playback.id) {
      // Already following another playing copy of the same video; keep it unless it stopped.
      const cur = this.hooks.tracks().find((x) => x.playback.id === this.bound?.playbackId)
      if (cur && cur.playback.status === 'playing') return
    }
    this.bind(n, t.playback)
  }

  /**
   * A provider's snapshot was applied. The extension feeds no binding machine, so its bound
   * playback leaving the snapshot (a closed tab, the next lesson's URL) or ending is the end
   * Next item waits for, as `ended`/`lost` is for the passive provider.
   */
  snapshotApplied(provider: PlaybackProviderId): void {
    const b = this.bound
    if (!this.active || !this.note || !b || b.provider === 'media-session' || b.provider !== provider) return
    const t = this.hooks.tracks().find((x) => x.playback.id === b.playbackId)
    if (t && t.playback.state !== 'ended') return
    const wasFollowing = this.bindingState === 'bound' || this.bindingState === 'ad'
    if (wasFollowing) this.lastEnd = { at: Date.now(), browser: b.browser }
    this.bound = null
    this.bindingState = t ? 'ended' : 'lost'
    this.note.playbackHint = null
    this.emitFeed()
    this.syncTimer()
  }

  /** A lookup changed the fed note's key (a guess resolved): follow it. */
  keyChanged(noteId: string): void {
    this.sources.delete(noteId)
    if (this.note?.noteId === noteId) this.reselect(this.bound?.playbackId ?? null)
  }

  hold(on: boolean): void {
    this.setHeld(on)
  }

  private setHeld(on: boolean): void {
    if (this.held === on) return
    this.held = on
    if (mediaFeed.binding()) mediaFeed.hold(on)
  }

  // ---------- what the offer asks ----------

  busyKeys(): Set<CanonicalKey> {
    const keys = new Set<CanonicalKey>()
    if (this.note) keys.add(this.note.key)
    const capturing = this.ctx.capture.currentNoteId()
    const s = capturing ? this.sources.get(capturing) : null
    if (s) keys.add(s.canonical_key)
    return keys
  }

  nextContext(): { noteId: string; seriesKey: CanonicalKey; browser: string; endedAt: number } | null {
    const n = this.note
    const end = this.lastEnd
    // A playback still bound to the note means nothing ended.
    if (!n || !n.seriesKey || !end || this.bound) return null
    return { noteId: n.noteId, seriesKey: n.seriesKey, browser: end.browser, endedAt: end.at }
  }

  async capturingSource(): Promise<{ noteId: string; hasSource: boolean } | null> {
    const id = this.ctx.capture.currentNoteId()
    if (!id) return null
    return { noteId: id, hasSource: (await this.sourceOf(id)) !== null }
  }

  // ---------- marks ----------

  mark(e: BusEvents['sources:mark']): void {
    const n = this.note
    if (!this.active || !n) return
    const b = this.bound
    if (e.tabKey && b?.tabKey && e.tabKey !== b.tabKey) return
    const position = this.position()
    const positionMs = e.positionMs ?? position?.positionMs ?? null
    if (positionMs === null || !b) {
      log('info', 'sources:mark-skipped', { reason: b ? 'no-position' : 'unbound' })
      return
    }
    const payload = { noteId: n.noteId, positionMs: Math.max(0, Math.round(positionMs)), wallMs: e.observedAt, origin: e.origin }
    for (const wc of this.ctx.windows.targets()) wc.send('sources:mark' satisfies PushChannel, payload)
  }

  // ---------- the tick ----------

  private syncTimer(): void {
    const want = this.active && (this.note !== null || this.watch !== null || this.lastStopped !== null || this.ctx.capture.isCapturing())
    if (want && !this.timer) {
      this.timer = setInterval(() => this.tick(), TICK_MS)
      this.timer.unref()
    } else if (!want) {
      this.stopTimer()
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The capture started or stopped. */
  captureChanged(): void {
    this.reselect()
    this.syncTimer()
  }

  private tick(): void {
    if (!this.active) return
    const p = this.position()
    if (p && p.positionMs !== null && !p.ad) this.fedLast = { noteId: p.noteId, positionMs: p.positionMs }
    if (p) for (const wc of this.ctx.windows.targets()) wc.send('sources:position' satisfies PushChannel, p)
    void this.checkWatching().catch((err: unknown) => log('warn', 'sources:watch-check-failed', { err }))
    this.syncTimer()
  }

  private position(): SourcePosition | null {
    const n = this.note
    if (!n) return null
    const now = Date.now()
    const stampOn = this.hooks.settings()['sources.stampPositions']
    const b = this.bound
    const machine = mediaFeed.binding()
    if (b?.provider === 'media-session' && machine?.noteId === n.noteId) {
      const s = mediaFeed.sample()
      if (s) return { ...s, canonicalKey: n.key, stamping: s.stamping && stampOn && !this.held }
    }
    const t = b ? this.hooks.tracks().find((x) => x.playback.id === b.playbackId) : undefined
    if (t && b && b.provider !== 'media-session') {
      const pb = t.playback
      const pos = pb.ad || pb.positionMs === null ? null : pb.status === 'playing' ? pb.positionMs + Math.max(0, now - pb.updatedAt) * pb.rate : pb.positionMs
      return {
        noteId: n.noteId,
        canonicalKey: n.key,
        positionMs: pos === null ? null : Math.round(pos),
        rate: pb.rate,
        status: pb.status,
        observedAt: now,
        ad: pb.ad,
        stamping: stampOn && !this.held && !pb.ad && pos !== null,
        provider: b.provider
      }
    }
    return { noteId: n.noteId, canonicalKey: n.key, positionMs: null, rate: 1, status: 'stopped', observedAt: now, ad: false, stamping: false, provider: b?.provider ?? 'media-session' }
  }

  private emitFeed(): void {
    const n = this.note
    const b = this.bound
    this.ctx.bus.emit('sources:feed', n && b ? { noteId: n.noteId, canonicalKey: n.key, provider: b.provider, tabKey: b.tabKey } : null)
  }

  // ---------- end of watching ----------

  private async checkWatching(): Promise<void> {
    const capturing = this.ctx.capture.currentNoteId()
    const prev = this.watch
    if (prev && prev.noteId !== capturing) {
      // That capture stopped (any reason) or moved to another note: was the lesson finished?
      this.watch = null
      void this.finishCheck(prev).catch((err: unknown) => log('warn', 'sources:finish-check-failed', { err }))
    }
    if (!capturing) {
      this.checkResume()
      return
    }
    const source = await this.sourceOf(capturing)
    if (!source || (source.transcript_plan !== 'system-audio' && !isSystemOnlyCapture(capturing))) {
      this.watch = null
      return
    }
    if (this.watch?.noteId !== capturing) {
      this.watch = {
        noteId: capturing,
        seen: false,
        goneSince: null,
        pausedSince: null,
        stopped: false,
        sample: { positionMs: null, durationMs: source.live ? null : source.duration_ms, live: source.live, title: null },
        since: Date.now(),
        seriesId: source.series_id,
        ended: false
      }
      if (this.lastStopped?.noteId === capturing) this.lastStopped = null
    }
    const w = this.watch
    if (w.stopped) return
    const now = Date.now()
    const startedFrom = this.hooks.startedFrom?.(capturing) ?? null
    const tracks = this.hooks
      .tracks()
      .filter((t) => t.draft?.canonicalKey === source.canonical_key || t.playback.id === startedFrom || (this.note?.noteId === capturing && t.playback.id === this.bound?.playbackId))
    // A mid-roll ad suspends the playback (paused, `ad`): that isn't the user pausing.
    const playing = tracks.some((t) => t.playback.status === 'playing' || t.playback.ad)
    const paused = !playing && tracks.some((t) => t.playback.status === 'paused')
    // Finished detection reads the note's own lesson only: the bound playback may already play the
    // next lesson (a course app, same media session) before the capture moves to its note.
    const sampled = tracks.filter((t) => !t.playback.ad && t.playback.positionMs !== null)
    const own = sampled.find((t) => t.draft?.canonicalKey === source.canonical_key) ?? sampled[0]
    const sample = own?.playback
    if (own && sample && sample.positionMs !== null) {
      const pos = sample.status === 'playing' ? sample.positionMs + Math.max(0, now - sample.updatedAt) * sample.rate : sample.positionMs
      w.sample = foldFinishSample(w.sample, {
        keyMatches: own.draft?.canonicalKey === source.canonical_key,
        title: sample.title,
        positionMs: Math.round(pos),
        durationMs: sample.durationMs,
        live: sample.live
      })
    }
    w.ended = !playing && !paused && w.seen
    if (playing) {
      w.seen = true
      w.goneSince = null
      w.pausedSince = null
      return
    }
    if (paused) {
      w.seen = true
      w.goneSince = null
      w.pausedSince ??= now
    } else {
      w.pausedSince = null
      // Only a playback seen during this capture can be "gone": a capture started before the
      // video plays isn't stopped.
      if (w.seen) w.goneSince ??= now
    }
    const gone = w.goneSince !== null && now - w.goneSince >= SOURCES_LIMITS.endedStopMs
    const pausedLong = w.pausedSince !== null && now - w.pausedSince >= SOURCES_LIMITS.pausedStopMs
    if (!gone && !pausedLong) return
    w.stopped = true
    log('info', 'sources:watching-ended', { reason: gone ? 'gone' : 'paused' })
    this.lastStopped = { noteId: capturing, key: source.canonical_key, at: now }
    await this.ctx.capture.stop('source_ended')
    this.hooks.watchingEnded(capturing)
  }

  /** After a capture of a source note stopped: `sources:lesson-finished` when the lesson finished. */
  private async finishCheck(w: Watch): Promise<void> {
    if (!w.seen) return
    // Lesson notes count the transcript's words: wait for the session's final flush.
    await this.stoppedSince(w.noteId, w.since)
    const spans = await this.ctx.storage.listSourceSpans(w.noteId).catch(() => [])
    const watchedMs = watchedMsOf(spans)
    const { durationMs, live, positionMs } = w.sample
    const finished = isFinished({ durationMs, live, positionMs, ended: w.ended, watchedMs })
    const watchedPercent = durationMs && !live ? Math.min(100, Math.round((watchedMs / durationMs) * 100)) : null
    log('info', 'sources:finish-checked', { finished, watchedPercent, live })
    if (finished) this.ctx.bus.emit('sources:lesson-finished', { noteId: w.noteId, seriesId: w.seriesId, watchedPercent, watchedMs })
  }

  /**
   * A captions note records nothing, so its finish is read when its playback ends instead: the
   * fed note's last position against its duration.
   */
  private async fedFinishCheck(noteId: string, ended: boolean): Promise<void> {
    if (this.ctx.capture.currentNoteId() === noteId) return
    const source = await this.sourceOf(noteId)
    const last = this.fedLast?.noteId === noteId ? this.fedLast.positionMs : null
    if (!source || source.transcript_plan !== 'captions' || last === null) return
    const at = this.captionFinishes.get(noteId)
    if (at !== undefined && Date.now() - at < CAPTION_FINISH_QUIET_MS) return
    const w: Watch = {
      noteId,
      seen: true,
      goneSince: null,
      pausedSince: null,
      stopped: true,
      sample: { positionMs: last, durationMs: source.live ? null : source.duration_ms, live: source.live, title: null },
      since: 0,
      seriesId: source.series_id,
      ended
    }
    this.captionFinishes.set(noteId, Date.now())
    if (this.captionFinishes.size > 100) this.captionFinishes.delete(this.captionFinishes.keys().next().value as string)
    await this.finishCheck(w)
  }

  /** The note the end of watching stopped: its video plays again. */
  private checkResume(): void {
    const l = this.lastStopped
    if (!l) return
    if (Date.now() - l.at > RESUME_WINDOW_MS) {
      this.lastStopped = null
      return
    }
    const t = this.hooks.tracks().find((x) => x.draft?.canonicalKey === l.key && x.playback.status === 'playing' && !x.playback.ad)
    if (!t) return
    this.lastStopped = null
    log('info', 'sources:watching-resumed', {})
    this.hooks.resumed(l.noteId, t.playback)
  }

  /** A Stop or an Undo: that note never continues by itself. */
  forgetStopped(noteId: string): void {
    if (this.lastStopped?.noteId === noteId) this.lastStopped = null
  }
}
