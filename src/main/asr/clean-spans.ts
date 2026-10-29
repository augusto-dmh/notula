// SPDX-License-Identifier: Apache-2.0
// The clean-span selector of speaker profiles: per cluster, the stretches of its own
// speech fit for an identification embedding (and for a clip).
//   1. take the cluster's turns;
//   2. cut out every stretch another turn on the same channel overlaps;
//   3. on the mic channel, also cut out stretches system-channel turns overlap (echo residue);
//   4. merge pieces separated by under 400 ms;
//   5. keep pieces of 1.5–10 s, clipping longer ones to their middle 10 s;
//   6. take the 12 longest per cluster.
// A merged span keeps its pieces: the length rule (step 5) reads the span, the embedding reads
// only the pieces, so a stretch cut in steps 2–3 never reaches the extractor.
//
// Step 3 compares two channels whose turns are in seconds into each channel's own back-to-back
// session files. Those timelines differ (each file starts at its own first write, and each later
// session starts after the previous one's length on that channel), so `echoOnMic` moves the
// system turns onto the mic's timeline through capture time first, widened by
// `ECHO_TOLERANCE_S` on each side.
// Pure: no I/O, so the worker and main share it.

import type { DiarizeFileTiming, DiarizeSegment } from './protocol'

/** One clean stretch of a cluster, in seconds from the start of the source's audio. */
export interface CleanSpan {
  /** The clustering's speaker number (`DiarizeSegment.speaker`). */
  speaker: number
  start: number
  end: number
  /** The clean pieces inside `[start, end]` (step 4 joins them across short gaps). */
  pieces: { start: number; end: number }[]
}

/** Step 4: pieces closer than this merge into one. */
const MERGE_GAP_S = 0.4
/** Step 5: shorter pieces are dropped, longer ones clipped to their middle. */
const MIN_SPAN_S = 1.5
const MAX_SPAN_S = 10
/** Step 6. */
const SPANS_PER_CLUSTER = 12
const SAMPLE_RATE = 16000
/**
 * Step 3's alignment tolerance, each side of a system turn on the mic timeline. A file trails
 * capture time by under 200 ms (the tee writes a gap as silence only above that), and the echo
 * reaches the mic a few tens of ms after the system plays it. Cutting a little more mic speech
 * is the safe side: the echo it would keep pollutes the vector.
 */
export const ECHO_TOLERANCE_S = 0.25

interface Interval {
  start: number
  end: number
}

interface Merged extends Interval {
  pieces: Interval[]
}

/** Sorted, non-overlapping cover of the intervals (touching ones join). */
function union(xs: readonly Interval[]): Interval[] {
  const sorted = xs.filter((x) => x.end > x.start).sort((a, b) => a.start - b.start || a.end - b.end)
  const out: Interval[] = []
  for (const x of sorted) {
    const last = out[out.length - 1]
    if (last && x.start <= last.end) last.end = Math.max(last.end, x.end)
    else out.push({ start: x.start, end: x.end })
  }
  return out
}

/** `pieces` minus `cuts`; both sorted and non-overlapping (from `union`). */
function subtract(pieces: readonly Interval[], cuts: readonly Interval[]): Interval[] {
  const out: Interval[] = []
  let c = 0
  for (const p of pieces) {
    let at = p.start
    while (c < cuts.length && (cuts[c] as Interval).end <= at) c++
    for (let i = c; i < cuts.length; i++) {
      const cut = cuts[i] as Interval
      if (cut.start >= p.end) break
      if (cut.start > at) out.push({ start: at, end: cut.start })
      at = Math.max(at, cut.end)
      if (at >= p.end) break
    }
    if (at < p.end) out.push({ start: at, end: p.end })
  }
  return out
}

/** Step 4: joins pieces whose gap is under 400 ms; the span covers the gap, its pieces don't. */
function mergeClose(pieces: readonly Interval[]): Merged[] {
  const out: Merged[] = []
  for (const p of pieces) {
    const last = out[out.length - 1]
    if (last && p.start - last.end < MERGE_GAP_S) {
      last.end = Math.max(last.end, p.end)
      last.pieces.push({ start: p.start, end: p.end })
    } else out.push({ start: p.start, end: p.end, pieces: [{ start: p.start, end: p.end }] })
  }
  return out
}

/** Step 5's clip: the middle 10 s of a longer span, its pieces cut to the same window. */
function clipped(p: Merged): Merged {
  if (p.end - p.start <= MAX_SPAN_S) return p
  const mid = (p.start + p.end) / 2
  const start = mid - MAX_SPAN_S / 2
  const end = mid + MAX_SPAN_S / 2
  const pieces = p.pieces.map((x) => ({ start: Math.max(x.start, start), end: Math.min(x.end, end) })).filter((x) => x.end > x.start)
  return { start, end, pieces }
}

/** The clean speech of a span in seconds: its pieces, without the gaps step 4 joined. */
export function spanSeconds(span: Pick<CleanSpan, 'pieces'>): number {
  return span.pieces.reduce((n, p) => n + (p.end - p.start), 0)
}

/**
 * `turns`: every turn of one channel. `otherChannelTurns`: the system channel's turns when
 * `turns` are the mic's (step 3), otherwise `[]`. Spans of every speaker, longest first per speaker.
 */
export function cleanSpans(turns: readonly DiarizeSegment[], otherChannelTurns: readonly DiarizeSegment[]): CleanSpan[] {
  const speakers = [...new Set(turns.map((t) => t.speaker))].sort((a, b) => a - b)
  const echo = union(otherChannelTurns)
  const out: CleanSpan[] = []
  for (const speaker of speakers) {
    const own = union(turns.filter((t) => t.speaker === speaker))
    const others = union(turns.filter((t) => t.speaker !== speaker))
    const clean = subtract(subtract(own, others), echo)
    const kept = mergeClose(clean)
      .filter((p) => p.end - p.start >= MIN_SPAN_S)
      .map(clipped)
      // Longest first; the earlier one wins a tie, so the choice is deterministic.
      .sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start)
      .slice(0, SPANS_PER_CLUSTER)
    for (const p of kept) out.push({ speaker, start: p.start, end: p.end, pieces: p.pieces })
  }
  return out
}

// ---------- step 3: the system turns on the mic's timeline ----------

/** Positions (seconds into the file) where it resumes after each cut gap, in order. */
function cutPositions(f: DiarizeFileTiming): number[] {
  let lost = 0
  return f.cuts.map((c) => {
    lost += c.lostMs
    return (c.atEpochMs - f.baseEpochMs - lost) / 1000
  })
}

/** Capture time (epoch ms) of a position in a file: the inverse of `diarize.ts`'s `fileSeconds`. */
function epochAt(f: DiarizeFileTiming, sec: number): number {
  const at = cutPositions(f)
  let lost = 0
  f.cuts.forEach((c, i) => {
    if ((at[i] as number) <= sec) lost += c.lostMs
  })
  return f.baseEpochMs + sec * 1000 + lost
}

/** Position in a file for a capture time; a time inside a cut gap maps to where the file resumes. */
function secondsAt(f: DiarizeFileTiming, ms: number): number {
  let lost = 0
  for (const c of f.cuts) {
    if (ms >= c.atEpochMs) {
      lost += c.lostMs
      continue
    }
    if (ms > c.atEpochMs - c.lostMs) return (c.atEpochMs - f.baseEpochMs - lost - c.lostMs) / 1000
    break
  }
  return (ms - f.baseEpochMs - lost) / 1000
}

/** A channel's files back to back, as the worker reads them: each file's offset and length in seconds. */
function laidOut(files: readonly DiarizeFileTiming[]): { f: DiarizeFileTiming; offset: number; dur: number }[] {
  let at = 0
  return files.map((f) => {
    const o = { f, offset: at, dur: f.samples / SAMPLE_RATE }
    at += o.dur
    return o
  })
}

/**
 * Step 3's echo turns: the system channel's turns moved onto the mic channel's timeline through
 * capture time, each widened by `ECHO_TOLERANCE_S` on both sides. Both file lists are in the
 * order the worker plays them back to back. The parts outside the mic's recorded time are
 * dropped.
 */
export function echoOnMic(
  systemTurns: readonly DiarizeSegment[],
  systemFiles: readonly DiarizeFileTiming[],
  micFiles: readonly DiarizeFileTiming[]
): DiarizeSegment[] {
  const from = laidOut(systemFiles)
  const to = laidOut(micFiles).map((m) => ({ ...m, startMs: m.f.baseEpochMs, endMs: epochAt(m.f, m.dur) }))
  const pad = ECHO_TOLERANCE_S * 1000
  const out: DiarizeSegment[] = []
  for (const t of systemTurns) {
    for (const s of from) {
      const lo = Math.max(t.start, s.offset) - s.offset
      const hi = Math.min(t.end, s.offset + s.dur) - s.offset
      if (hi <= lo) continue
      // A cut gap inside the turn splits it: the lost time held no audio.
      const bounds = [lo, ...cutPositions(s.f).filter((p) => p > lo && p < hi), hi]
      for (let i = 0; i + 1 < bounds.length; i++) {
        const a = bounds[i] as number
        const at = epochAt(s.f, a)
        const startMs = at - pad
        const endMs = at + ((bounds[i + 1] as number) - a) * 1000 + pad
        for (const m of to) {
          const x = Math.max(startMs, m.startMs)
          const y = Math.min(endMs, m.endMs)
          if (y > x) out.push({ start: m.offset + secondsAt(m.f, x), end: m.offset + secondsAt(m.f, y), speaker: t.speaker })
        }
      }
    }
  }
  return out.sort((a, b) => a.start - b.start)
}
