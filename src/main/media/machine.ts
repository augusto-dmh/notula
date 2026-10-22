// SPDX-License-Identifier: Apache-2.0
// The passive provider's playback engine: a pure state machine fed with
// the reader's session snapshots, the tab-strip results and the note binding. No Electron, no
// timers and type-only imports (the pattern of dictation's chord machine), so the dev harness
// (scripts/dev/media-replay.mjs) replays reader lines through it directly.
//
// - One playback per browser (the OS keeps one media session per app). A new title or artist is
//   a new playback with a new id; a session that is gone for less than the debounce and comes
//   back with the same title is the same playback (start-up flaps).
// - Debounce: a playback is `seen` until it has been present and unchanged for 1.5 s, then
//   `provisional` (the `locate` effect asks for the tab strip), then `candidate` once eligible:
//   ≥ 20 s played, longer than 120 s or live, not a Short, not muted.
// - Ad guard: a title replaced within its first 30 s played is discarded. A mid-playback change
//   to an item ≤ 60 s long suspends the playing item; if its title comes back, the short item
//   was an ad and the suspended playback resumes under its own id. While suspended it is
//   reported with `ad: true` and the short item is hidden. Later items of the same pod may run
//   up to the 120 s floor (a 79.7 s second ad was recorded, active-2026-10.jsonl).
// - Ended: a session gone for the debounce is `ended` at the time it went away; one that was
//   never stable for the debounce (a start-up flap longer than it) is discarded.
// - Binding: one note follows one playback. Every play / pause / seek / rate change closes a
//   watched span and opens the next; spans under 2 s merge into the next one. A different
//   title never stamps the note: the binding goes `lost` until the owner binds again.

import type { BrowserId, CanonicalKey, MediaSession, Playback, PlaybackState, PlaybackStatus, SourcePosition } from '@shared/types/sources'

export interface MachineLimits {
  debounceMs: number
  eligiblePlayedMs: number
  minDurationMs: number
  spanMergeMs: number
}

/** A title replaced before this much playing time is discarded. */
export const AD_REPLACE_MS = 30_000
/** An item at most this long, starting mid-playback, may be an ad. */
export const AD_MAX_MS = 60_000
/** A suspended playback whose title hasn't come back this long after the pod's latest item has ended. */
export const AD_RETURN_MS = 120_000
/** A position jump beyond this, while playing, is a seek. */
export const SEEK_TOLERANCE_MS = 1_500

export interface SpanRecord {
  wallStart: number
  wallEnd: number
  posStartMs: number
  posEndMs: number
  rate: number
}

export type BindingState = 'bound' | 'ad' | 'lost' | 'ended' | 'unbound'
export type EndReason = 'gone' | 'replaced' | 'discarded' | 'ad'

export type MachineInput =
  | { type: 'sessions'; sessions: MediaSession[] }
  | { type: 'tick' }
  /** The tab-strip result for a playback (`locate`). */
  | { type: 'window'; playbackId: string; privateWindow: boolean | 'unknown'; site: string | null; url: string | null; short: boolean }
  | { type: 'bind'; noteId: string; canonicalKey: CanonicalKey; playbackId: string }
  | { type: 'unbind' }
  /** A Next item card is waiting: no stamping until it's answered. */
  | { type: 'hold'; on: boolean }
  /** `sources.muted` (`channel:<name>`, `site:<host>`). */
  | { type: 'mutes'; mutes: readonly string[] }
  /** Browsers the extension covers: forgotten without an `ended`. */
  | { type: 'drop'; browsers: readonly BrowserId[] }

export type MachineEffect =
  | { type: 'changed' }
  | { type: 'locate'; playbackId: string; browser: BrowserId; title: string }
  | { type: 'candidate'; playbackId: string }
  | { type: 'ended'; playbackId: string; reason: EndReason }
  | { type: 'span'; noteId: string; span: SpanRecord }
  | { type: 'binding'; noteId: string; state: BindingState; playbackId: string | null }

interface Track {
  id: string
  browser: BrowserId
  ident: string
  title: string
  artist: string | null
  status: PlaybackStatus
  positionMs: number | null
  endMs: number | null
  rate: number
  /** The OS sample time of `positionMs`. */
  sampleAt: number
  seenAt: number
  changedAt: number
  playedMs: number
  accumAt: number
  state: PlaybackState
  ad: boolean
  goneAt: number | null
  privateWindow: boolean | 'unknown'
  url: string | null
  site: string | null
  short: boolean
  endReason: EndReason | null
}

interface Binding {
  noteId: string
  canonicalKey: CanonicalKey
  playbackId: string | null
  state: BindingState
  held: boolean
  open: { wallStart: number; posStartMs: number; rate: number } | null
  /** A closed span under the merge threshold, waiting for the next one. */
  pending: SpanRecord | null
}

export interface MediaMachine {
  limits: MachineLimits
  mutes: string[]
  seq: number
  tracks: Map<BrowserId, Track>
  /** A playback interrupted by a possible ad, by browser. `adAt`: when the current ad began. */
  suspended: Map<BrowserId, { track: Track; at: number; ad: Track; adAt: number }>
  /** Ended since the last snapshot (reported once). */
  ended: Track[]
  binding: Binding | null
}

export function createMachine(limits: MachineLimits): MediaMachine {
  return { limits, mutes: [], seq: 0, tracks: new Map(), suspended: new Map(), ended: [], binding: null }
}

// ---------- helpers ----------

function identOf(s: MediaSession): string {
  return `${s.title}\u0000${s.artist ?? ''}`
}

function isLive(t: Track): boolean {
  return t.endMs !== null && t.endMs <= 0
}

/** The position at `at`, extrapolated with the rate while playing. */
function positionAt(t: Track, at: number): number | null {
  if (t.positionMs === null) return null
  if (t.status !== 'playing') return t.positionMs
  const p = t.positionMs + Math.max(0, at - t.sampleAt) * t.rate
  return t.endMs !== null && t.endMs > 0 ? Math.min(p, t.endMs) : p
}

function accumulate(t: Track, now: number): void {
  if (now > t.accumAt && t.status === 'playing' && t.goneAt === null) t.playedMs += now - t.accumAt
  t.accumAt = Math.max(t.accumAt, now)
}

function muted(m: MediaMachine, t: Track): boolean {
  if (t.artist && m.mutes.includes(`channel:${t.artist.toLowerCase()}`)) return true
  return !!t.site && m.mutes.includes(`site:${t.site.toLowerCase()}`)
}

function eligible(m: MediaMachine, t: Track): boolean {
  return (
    !t.ad &&
    !t.short &&
    t.goneAt === null &&
    t.playedMs >= m.limits.eligiblePlayedMs &&
    (isLive(t) || (t.endMs !== null && t.endMs > m.limits.minDurationMs))
  )
}

function findTrack(m: MediaMachine, id: string | null): { track: Track; suspended: boolean } | null {
  if (!id) return null
  for (const t of m.tracks.values()) if (t.id === id) return { track: t, suspended: false }
  for (const s of m.suspended.values()) if (s.track.id === id) return { track: s.track, suspended: true }
  return null
}

function newTrack(m: MediaMachine, s: MediaSession, now: number): Track {
  m.seq++
  return {
    id: `${s.browser}-${m.seq}`,
    browser: s.browser,
    ident: identOf(s),
    title: s.title,
    artist: s.artist,
    status: s.status,
    positionMs: s.positionMs,
    endMs: s.endMs,
    rate: s.rate,
    sampleAt: s.lastUpdatedAt,
    seenAt: now,
    changedAt: now,
    playedMs: 0,
    accumAt: now,
    state: 'seen',
    ad: false,
    goneAt: null,
    privateWindow: 'unknown',
    url: null,
    site: null,
    short: false,
    endReason: null
  }
}

/** An item short enough to be an ad (and too short to be a candidate). */
function isShortItem(s: MediaSession): boolean {
  return s.endMs !== null && s.endMs > 0 && s.endMs <= AD_MAX_MS
}

/** A later item of an ad pod: under the duration floor, so never a candidate either way. */
function isPodItem(m: MediaMachine, s: MediaSession): boolean {
  return s.endMs !== null && s.endMs > 0 && s.endMs <= m.limits.minDurationMs
}

/** The ad item standing in for a suspended playback. */
function isAdOf(m: MediaMachine, t: Track): boolean {
  return m.suspended.get(t.browser)?.ad === t
}

// ---------- spans and binding ----------

function emitSpan(b: Binding, rec: SpanRecord, fx: MachineEffect[]): void {
  fx.push({ type: 'span', noteId: b.noteId, span: rec })
}

function openSpan(b: Binding, wall: number, pos: number | null, rate: number): void {
  if (pos === null) return
  b.open = { wallStart: wall, posStartMs: Math.round(pos), rate }
}

function closeSpan(m: MediaMachine, b: Binding, wallEnd: number, posEnd: number | null, fx: MachineEffect[]): void {
  const o = b.open
  b.open = null
  if (!o) return
  const dur = wallEnd - o.wallStart
  if (dur <= 0) return
  const end = posEnd ?? o.posStartMs + dur * o.rate
  const rec: SpanRecord = { wallStart: o.wallStart, wallEnd, posStartMs: o.posStartMs, posEndMs: Math.round(Math.max(end, o.posStartMs)), rate: o.rate }
  if (b.pending) {
    rec.wallStart = b.pending.wallStart
    rec.posStartMs = b.pending.posStartMs
    b.pending = null
  }
  if (dur < m.limits.spanMergeMs) {
    b.pending = rec
    return
  }
  emitSpan(b, rec, fx)
}

function flushPending(b: Binding, fx: MachineEffect[]): void {
  if (b.pending) emitSpan(b, b.pending, fx)
  b.pending = null
}

function setBinding(b: Binding, state: BindingState, fx: MachineEffect[]): void {
  if (b.state === state) return
  b.state = state
  fx.push({ type: 'binding', noteId: b.noteId, state, playbackId: b.playbackId })
}

/** The bound playback is gone, replaced or discarded at `at`. */
function releaseBinding(m: MediaMachine, t: Track, at: number, state: 'lost' | 'ended', fx: MachineEffect[]): void {
  const b = m.binding
  if (!b || b.playbackId !== t.id) return
  closeSpan(m, b, at, positionAt(t, at), fx)
  flushPending(b, fx)
  setBinding(b, state, fx)
  b.playbackId = null
}

// ---------- life cycle ----------

function finish(m: MediaMachine, t: Track, at: number, reason: EndReason, fx: MachineEffect[]): void {
  accumulate(t, at)
  if (m.tracks.get(t.browser) === t) m.tracks.delete(t.browser)
  t.state = 'ended'
  t.endReason = reason
  m.ended.push(t)
  fx.push({ type: 'ended', playbackId: t.id, reason })
  releaseBinding(m, t, at, reason === 'gone' ? 'ended' : 'lost', fx)
  fx.push({ type: 'changed' })
}

/** A new sample for the same playback: spans follow play, pause, seek and rate changes. */
function updateSample(m: MediaMachine, t: Track, s: MediaSession, now: number, fx: MachineEffect[]): void {
  // A sample without a timeline (a closing session, see lines.ts) keeps the last known one.
  const timeline = s.positionMs !== null
  const freshSample = timeline && (s.lastUpdatedAt !== t.sampleAt || s.positionMs !== t.positionMs)
  const at = freshSample ? Math.min(s.lastUpdatedAt, now) : now
  const expected = positionAt(t, at)
  const statusChange = s.status !== t.status
  const rateChange = s.rate !== t.rate
  const seek =
    !statusChange &&
    t.status === 'playing' &&
    freshSample &&
    s.positionMs !== null &&
    expected !== null &&
    Math.abs(s.positionMs - expected) > SEEK_TOLERANCE_MS
  const b = m.binding
  if (b && b.playbackId === t.id && b.state === 'bound' && (statusChange || seek || rateChange)) {
    // Pause: the paused position is measured. Seek or rate change: where it was just before.
    const posEnd = statusChange && s.status !== 'playing' && timeline ? s.positionMs : expected
    closeSpan(m, b, at, posEnd, fx)
  }
  const changed = statusChange || seek || rateChange || freshSample || (s.endMs !== null && s.endMs !== t.endMs)
  t.status = s.status
  t.rate = s.rate
  if (s.endMs !== null) t.endMs = s.endMs
  if (freshSample) {
    t.positionMs = s.positionMs
    t.sampleAt = s.lastUpdatedAt
  }
  if (b && b.playbackId === t.id && b.state === 'bound' && !b.open && t.status === 'playing') openSpan(b, at, positionAt(t, at), t.rate)
  if (changed) {
    t.changedAt = now
    fx.push({ type: 'changed' })
  }
}

function applySession(m: MediaMachine, s: MediaSession, now: number, fx: MachineEffect[]): void {
  const cur = m.tracks.get(s.browser)
  const ident = identOf(s)
  if (cur && cur.ident === ident) {
    accumulate(cur, now)
    if (cur.goneAt !== null) {
      // A flap: back before the debounce, the same playback. The gap isn't played time.
      cur.goneAt = null
      cur.accumAt = now
    }
    updateSample(m, cur, s, now, fx)
    return
  }
  const sus = m.suspended.get(s.browser)
  if (sus && sus.track.ident === ident) {
    // The interrupted title came back: the short item was an ad.
    m.suspended.delete(s.browser)
    if (cur) finish(m, cur, now, 'ad', fx)
    const t = sus.track
    m.tracks.set(s.browser, t)
    t.goneAt = null
    t.ad = false
    t.accumAt = now
    // Its clock stopped at the suspension.
    t.sampleAt = now
    t.status = 'paused'
    const b = m.binding
    if (b && b.playbackId === t.id) setBinding(b, 'bound', fx)
    updateSample(m, t, s, now, fx)
    t.changedAt = now
    fx.push({ type: 'changed' })
    return
  }
  if (sus) {
    if (cur) finish(m, cur, cur.goneAt ?? now, sus.ad === cur ? 'discarded' : 'replaced', fx)
    if (isPodItem(m, s)) {
      // The next ad of a pod.
      const t = newTrack(m, s, now)
      t.ad = true
      m.tracks.set(s.browser, t)
      sus.ad = t
      sus.adAt = now
      fx.push({ type: 'changed' })
      return
    }
    // A long new title instead of the interrupted one: the user moved on.
    m.suspended.delete(s.browser)
    finish(m, sus.track, sus.at, 'replaced', fx)
  } else if (cur) {
    accumulate(cur, now)
    if (cur.goneAt !== null) {
      // Ended (or a page start) before the new title; a title played under 30 s is discarded.
      finish(m, cur, cur.goneAt, cur.playedMs < AD_REPLACE_MS ? 'discarded' : 'gone', fx)
    } else if (cur.playedMs < AD_REPLACE_MS) {
      finish(m, cur, now, 'discarded', fx)
    } else if (isShortItem(s)) {
      // Possibly a mid-roll: keep the playing item aside until its title returns.
      m.tracks.delete(s.browser)
      const b = m.binding
      if (b && b.playbackId === cur.id) {
        closeSpan(m, b, now, positionAt(cur, now), fx)
        setBinding(b, 'ad', fx)
      }
      cur.positionMs = positionAt(cur, now)
      cur.sampleAt = now
      cur.changedAt = now
      const t = newTrack(m, s, now)
      t.ad = true
      m.tracks.set(s.browser, t)
      m.suspended.set(s.browser, { track: cur, at: now, ad: t, adAt: now })
      fx.push({ type: 'changed' })
      return
    } else {
      finish(m, cur, now, 'replaced', fx)
    }
  }
  m.tracks.set(s.browser, newTrack(m, s, now))
  fx.push({ type: 'changed' })
}

/** Timers: debounce, eligibility, ends, suspended items that never came back. */
function advance(m: MediaMachine, now: number, fx: MachineEffect[]): void {
  for (const t of [...m.tracks.values()]) {
    accumulate(t, now)
    if (t.goneAt !== null) {
      if (now - t.goneAt >= m.limits.debounceMs) finish(m, t, t.goneAt, isAdOf(m, t) ? 'ad' : t.state === 'seen' ? 'discarded' : 'gone', fx)
      continue
    }
    if (t.state === 'seen' && now - t.seenAt >= m.limits.debounceMs) {
      t.state = 'provisional'
      t.changedAt = now
      fx.push({ type: 'locate', playbackId: t.id, browser: t.browser, title: t.title })
      fx.push({ type: 'changed' })
    }
    if (t.state === 'provisional' && eligible(m, t)) {
      t.state = muted(m, t) ? 'muted' : 'candidate'
      t.changedAt = now
      if (t.state === 'candidate') fx.push({ type: 'candidate', playbackId: t.id })
      fx.push({ type: 'changed' })
    }
  }
  for (const [browser, sus] of [...m.suspended]) {
    if (now - sus.adAt < AD_RETURN_MS) continue
    // Not an ad after all: the interrupted item has ended, the short one is real.
    m.suspended.delete(browser)
    sus.ad.ad = false
    finish(m, sus.track, sus.at, 'gone', fx)
  }
}

// ---------- the step function ----------

export function step(m: MediaMachine, input: MachineInput, now: number): MachineEffect[] {
  const fx: MachineEffect[] = []
  switch (input.type) {
    case 'sessions': {
      const present = new Set<BrowserId>()
      for (const s of input.sessions) {
        // A session without a title (page start) counts as absent.
        if (!s.title || present.has(s.browser)) continue
        present.add(s.browser)
        applySession(m, s, now, fx)
      }
      for (const t of m.tracks.values()) {
        if (present.has(t.browser) || t.goneAt !== null) continue
        accumulate(t, now)
        t.goneAt = now
      }
      break
    }
    case 'tick':
      break
    case 'window': {
      const found = findTrack(m, input.playbackId)
      if (found) {
        const t = found.track
        t.privateWindow = input.privateWindow
        t.site = input.site
        t.url = input.url
        t.short = input.short
        t.changedAt = now
        if (t.state === 'candidate' && (t.short || muted(m, t))) t.state = t.short ? 'provisional' : 'muted'
        fx.push({ type: 'changed' })
      }
      break
    }
    case 'bind': {
      if (m.binding) step(m, { type: 'unbind' }, now).forEach((e) => fx.push(e))
      const found = findTrack(m, input.playbackId)
      const b: Binding = {
        noteId: input.noteId,
        canonicalKey: input.canonicalKey,
        playbackId: found ? found.track.id : null,
        state: 'unbound',
        held: false,
        open: null,
        pending: null
      }
      m.binding = b
      setBinding(b, !found ? 'lost' : found.suspended ? 'ad' : 'bound', fx)
      if (found && !found.suspended && found.track.status === 'playing') openSpan(b, now, positionAt(found.track, now), found.track.rate)
      break
    }
    case 'unbind': {
      const b = m.binding
      if (!b) break
      const found = findTrack(m, b.playbackId)
      closeSpan(m, b, now, found ? positionAt(found.track, now) : null, fx)
      flushPending(b, fx)
      setBinding(b, 'unbound', fx)
      m.binding = null
      break
    }
    case 'hold':
      if (m.binding) m.binding.held = input.on
      break
    case 'mutes':
      m.mutes = input.mutes.map((x) => x.toLowerCase())
      for (const t of m.tracks.values()) {
        if (t.state === 'candidate' && muted(m, t)) {
          t.state = 'muted'
          fx.push({ type: 'changed' })
        }
      }
      break
    case 'drop':
      for (const browser of input.browsers) {
        const t = m.tracks.get(browser)
        const sus = m.suspended.get(browser)
        m.tracks.delete(browser)
        m.suspended.delete(browser)
        for (const x of [t, sus?.track]) if (x) releaseBinding(m, x, now, 'lost', fx)
        if (t || sus) fx.push({ type: 'changed' })
      }
      break
  }
  advance(m, now, fx)
  return dedupeChanged(fx)
}

function dedupeChanged(fx: MachineEffect[]): MachineEffect[] {
  let seen = false
  return fx.filter((e) => {
    if (e.type !== 'changed') return true
    if (seen) return false
    seen = true
    return true
  })
}

/** Something is running that needs `tick`s (debounce, eligibility, ends, spans). */
export function needsTicks(m: MediaMachine): boolean {
  return m.tracks.size > 0 || m.suspended.size > 0
}

// ---------- outputs ----------

function toPlayback(t: Track, now: number, suspended: boolean): Playback {
  const pos = suspended ? t.positionMs : positionAt(t, now)
  return {
    id: t.id,
    provider: 'media-session',
    browser: t.browser,
    tabKey: null,
    title: t.title,
    artist: t.artist,
    status: suspended ? 'paused' : t.status,
    positionMs: pos === null ? null : Math.round(pos),
    durationMs: t.endMs !== null && t.endMs > 0 ? Math.round(t.endMs) : null,
    rate: t.rate,
    updatedAt: now,
    live: isLive(t),
    ad: suspended || t.ad,
    privateWindow: t.privateWindow,
    url: t.url,
    site: t.site,
    state: t.state,
    playedMs: Math.round(t.playedMs),
    seenAt: t.seenAt
  }
}

/**
 * The provider snapshot (bus `sources:playback`), the most recently changed first. A suspended
 * playback stands for its browser (with `ad: true`) and hides the short item; playbacks that
 * ended since the last snapshot are reported once, then forgotten.
 */
export function snapshot(m: MediaMachine, now: number): Playback[] {
  const out: { at: number; p: Playback }[] = []
  for (const t of m.tracks.values()) {
    const sus = m.suspended.get(t.browser)
    if (sus && sus.ad === t) continue
    out.push({ at: t.changedAt, p: toPlayback(t, now, false) })
  }
  for (const s of m.suspended.values()) out.push({ at: s.track.changedAt, p: toPlayback(s.track, now, true) })
  // Discarded titles and ads were never real playbacks.
  for (const t of m.ended) if (t.endReason !== 'discarded' && t.endReason !== 'ad') out.push({ at: t.changedAt, p: toPlayback(t, now, false) })
  m.ended = []
  return out.sort((a, b) => b.at - a.at).map((x) => x.p)
}

/** The position feed of the bound note (`sources:position`), or null without a binding. */
export function feedSample(m: MediaMachine, now: number): SourcePosition | null {
  const b = m.binding
  if (!b) return null
  const found = findTrack(m, b.playbackId)
  if (!found) {
    return { noteId: b.noteId, canonicalKey: b.canonicalKey, positionMs: null, rate: 1, status: 'stopped', observedAt: now, ad: false, stamping: false, provider: 'media-session' }
  }
  const t = found.track
  const ad = found.suspended || t.ad
  const pos = ad ? null : positionAt(t, now)
  return {
    noteId: b.noteId,
    canonicalKey: b.canonicalKey,
    positionMs: pos === null ? null : Math.round(pos),
    rate: t.rate,
    status: found.suspended ? 'paused' : t.status,
    observedAt: now,
    ad,
    stamping: b.state === 'bound' && !b.held && pos !== null,
    provider: 'media-session'
  }
}

/** The binding as it stands, for status and the owner's decisions. */
export function bindingOf(m: MediaMachine): { noteId: string; canonicalKey: CanonicalKey; playbackId: string | null; state: BindingState; held: boolean } | null {
  const b = m.binding
  return b ? { noteId: b.noteId, canonicalKey: b.canonicalKey, playbackId: b.playbackId, state: b.state, held: b.held } : null
}
