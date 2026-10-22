// SPDX-License-Identifier: Apache-2.0
// The renderer's content-sources state, shared by the note chip, the editor's stamping plugin,
// the Link source dialog and Settings ▸ Sources:
// - the active source note: the note page's chip registers the open note's source, and the
//   notes editor stamps, links and projects only for that note;
// - the position feed (`sources:position`, about 1 Hz): the last sample per note, interpolated
//   by its rate while playing, and the paused position while paused;
// - local spans: a span closed by a pause, a rate change or an end, whose measured rate differs
//   from the rate stamps used, asks the editor to recompute that span's stamps from their wall
//   times;
// - `sources:get-status`, mirrored for the settings rows and the dialog.
// Nothing here runs at import; every channel may still answer "No handler registered" while its
// main-side handler is missing, and that reads as "not available", never as an error to the user.

import { useSyncExternalStore } from 'react'
import { parseError } from '@shared/errors'
import type { CanonicalKey, SourcePosition, SourcesStatus } from '@shared/types/sources'
import { debugLog } from '../../../app/platform'

/** The main-side handler isn't registered yet (Sources is off in main). */
export function isMissingHandler(err: unknown): boolean {
  return /No handler registered/i.test(String(err instanceof Error ? err.message : err))
}

/** Runs a sources call; a failure is logged (code only) and reads as null. */
export async function trySources<T>(event: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run()
  } catch (err) {
    debugLog(event, isMissingHandler(err) ? { missingHandler: true } : { code: parseError(err).code })
    return null
  }
}

function emitter(): { subscribe(cb: () => void): () => void; emit(): void } {
  const listeners = new Set<() => void>()
  return {
    subscribe(cb) {
      listeners.add(cb)
      return () => listeners.delete(cb)
    },
    emit() {
      for (const l of listeners) l()
    }
  }
}

// ---------- the active source note ----------

export interface ActiveSource {
  noteId: string
  canonicalKey: CanonicalKey
  url: string | null
  /** The stored stamped projection, when the chip loaded it. */
  stamped: string | null
}

const activeEvents = emitter()
let active: ActiveSource | null = null

/** The note page's chip: this note is open and has this source; null clears it. */
export function setActiveSource(next: ActiveSource | null): void {
  if (active?.noteId === next?.noteId && active?.url === next?.url && active?.canonicalKey === next?.canonicalKey) return
  active = next
  activeEvents.emit()
}

/** Clears the active source only if it is still this note's. */
export function clearActiveSource(noteId: string): void {
  if (active?.noteId === noteId) setActiveSource(null)
}

export function getActiveSource(): ActiveSource | null {
  return active
}

export function subscribeActiveSource(cb: () => void): () => void {
  return activeEvents.subscribe(cb)
}

// ---------- the position feed ----------

/** Without a push for this long, the position is unknown (the feed stopped or was unbound). */
const STALE_MS = 5_000
/** A playing sample this far from where the span predicts is a new span (a seek or a correction). */
const JUMP_MS = 1_500
/** Spans shorter than this can't measure a rate. */
const MIN_MEASURE_MS = 2_000
/** Measured rates outside this range are a seek, not a speed. */
const RATE_MIN = 0.25
const RATE_MAX = 4
const RATE_EPSILON = 0.05

interface Sample extends SourcePosition {
  receivedAt: number
}

interface LocalSpan {
  noteId: string
  wallStart: number
  posStart: number
  rate: number
  lastObservedAt: number
  lastPos: number
}

/** A closed span whose stamps should be recomputed with its measured rate. */
export interface SpanCorrection {
  noteId: string
  wallStart: number
  wallEnd: number
  posStart: number
  rate: number
}

const samples = new Map<string, Sample>()
const spans = new Map<string, LocalSpan>()
const corrections = new Set<(c: SpanCorrection) => void>()
let feedStarted = false

function closeSpan(span: LocalSpan, s: SourcePosition): void {
  spans.delete(span.noteId)
  if (s.positionMs === null) return
  const wall = s.observedAt - span.wallStart
  if (wall < MIN_MEASURE_MS) return
  const measured = (s.positionMs - span.posStart) / wall
  if (measured < RATE_MIN || measured > RATE_MAX || Math.abs(measured - span.rate) <= RATE_EPSILON) return
  const c: SpanCorrection = { noteId: span.noteId, wallStart: span.wallStart, wallEnd: s.observedAt, posStart: span.posStart, rate: measured }
  debugLog('sources:span-rate-corrected', { rate: Math.round(measured * 100) / 100 })
  for (const cb of corrections) cb(c)
}

function openSpan(s: SourcePosition): void {
  if (s.positionMs === null) return
  spans.set(s.noteId, {
    noteId: s.noteId,
    wallStart: s.observedAt,
    posStart: s.positionMs,
    rate: s.rate,
    lastObservedAt: s.observedAt,
    lastPos: s.positionMs
  })
}

/**
 * Spans as the renderer saw them. Only a pause, a rate change or an end closes a span with a
 * measurable rate: a jump while playing may be a seek, so it opens a new span without one.
 */
function trackSpan(s: SourcePosition): void {
  const span = spans.get(s.noteId)
  const usable = s.stamping && !s.ad && s.positionMs !== null
  if (!usable) {
    if (span) spans.delete(s.noteId)
    return
  }
  if (s.status !== 'playing') {
    if (span) closeSpan(span, s)
    return
  }
  if (!span) {
    openSpan(s)
    return
  }
  if (s.observedAt === span.lastObservedAt && s.positionMs === span.lastPos && s.rate === span.rate) return
  if (s.rate !== span.rate) {
    closeSpan(span, s)
    openSpan(s)
    return
  }
  const expected = span.posStart + (s.observedAt - span.wallStart) * span.rate
  if (Math.abs((s.positionMs as number) - expected) > JUMP_MS) {
    spans.delete(s.noteId)
    openSpan(s)
    return
  }
  span.lastObservedAt = s.observedAt
  span.lastPos = s.positionMs as number
}

/** Starts listening to `sources:position` once per window. */
export function startPositionFeed(): void {
  if (feedStarted) return
  feedStarted = true
  window.notula.sources.onPosition((p) => {
    samples.set(p.noteId, { ...p, receivedAt: Date.now() })
    trackSpan(p)
  })
}

/**
 * The note's video position now, for a stamp: null without a recent sample, with no known
 * position, during an ad, or while stamping is held (a Next item card, a lost binding). A
 * playing sample is interpolated with its rate; a paused one gives its paused position.
 */
export function positionNow(noteId: string, canonicalKey: CanonicalKey | null, now = Date.now()): { positionMs: number; wallMs: number } | null {
  const s = samples.get(noteId)
  if (!s || now - s.receivedAt > STALE_MS) return null
  if (canonicalKey !== null && s.canonicalKey !== canonicalKey) return null
  if (!s.stamping || s.ad || s.positionMs === null) return null
  const positionMs = s.status === 'playing' ? s.positionMs + Math.max(0, now - s.observedAt) * s.rate : s.positionMs
  return { positionMs: Math.max(0, Math.round(positionMs)), wallMs: now }
}

/** Subscribes to span rate corrections; returns the unsubscribe. */
export function onSpanCorrection(cb: (c: SpanCorrection) => void): () => void {
  corrections.add(cb)
  return () => corrections.delete(cb)
}

// ---------- status ----------

const statusEvents = emitter()
let status: SourcesStatus | null = null
let statusUnavailable = false
let statusStarted = false

function loadStatus(): void {
  void window.notula.sources
    .getStatus()
    .then((s) => {
      status = s
      statusUnavailable = false
      statusEvents.emit()
    })
    .catch((err: unknown) => {
      debugLog('sources:get-status-failed', isMissingHandler(err) ? { missingHandler: true } : { code: parseError(err).code })
      statusUnavailable = true
      statusEvents.emit()
    })
}

function startStatus(): void {
  if (statusStarted) return
  statusStarted = true
  window.notula.sources.onStatusChanged((s) => {
    status = s
    statusUnavailable = false
    statusEvents.emit()
  })
  loadStatus()
}

interface StatusSnapshot {
  status: SourcesStatus | null
  /** `sources:get-status` failed (its handler isn't there yet). */
  unavailable: boolean
}

let statusSnapshot: StatusSnapshot = { status: null, unavailable: false }

function getStatusSnapshot(): StatusSnapshot {
  if (statusSnapshot.status !== status || statusSnapshot.unavailable !== statusUnavailable) {
    statusSnapshot = { status, unavailable: statusUnavailable }
  }
  return statusSnapshot
}

/** `sources:get-status`, kept current by `sources:status-changed`. */
export function useSourcesStatus(): StatusSnapshot {
  return useSyncExternalStore((cb) => {
    startStatus()
    return statusEvents.subscribe(cb)
  }, getStatusSnapshot)
}

/** Applies a status a call returned (grant, tools) before the push arrives. */
export function patchSourcesStatus(patch: Partial<SourcesStatus>): void {
  if (!status) return
  status = { ...status, ...patch }
  statusEvents.emit()
}
