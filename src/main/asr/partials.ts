// SPDX-License-Identifier: Apache-2.0
// The local engine's live line, pure (type imports only, so a dev check runs it with node).
//
// The segmenter offers the whole open segment about every 2 s of audio (vad.ts). The
// worker decides here:
// - when a partial decode may start: at least 2 s after the last one began (Whisper 3 s),
//   which only bites after a backlog, when the newest snapshot waits instead of being
//   decoded twice;
// - how much of the snapshot a Parakeet partial reads: its last 8 s, so a 25 s segment
//   costs about 84 s of partial audio instead of about 300 s;
// - how the live line is put back together: the previous partial's words that start
//   before window start + 1 s, then the new decode's words from there on. The 1 s
//   drops a word the window's edge may have cut. Two decodes can place the same word up to a
//   frame or two apart, so a word within 200 ms of the seam is matched by its text: it is kept
//   once, whichever side of the seam each decode put it. The final replaces the whole line.
// Whisper decodes the whole open segment: its encoder pads every input to a fixed length,
// and its evenly spread word times can't be spliced.

import type { AsrWorkerWord } from './protocol'
import type { Segment } from './vad'

export type PartialEngine = 'parakeet' | 'whisper'

/** Partial decodes start at least this far apart. */
export const PARTIAL_FLOOR_MS = 2_000
/** Whisper partials are a full decode of the open segment: at most one per this. */
export const WHISPER_PARTIAL_EVERY_MS = 3_000
/** A Parakeet partial reads at most this much of the open segment, its newest audio. */
export const PARTIAL_WINDOW_MS = 8_000
/** The seam sits this far into the window, past a word its edge may have split. */
export const SPLICE_GUARD_MS = 1_000
/** Two decodes of the same word may start this far apart (a frame is 80 ms). */
export const SEAM_TOLERANCE_MS = 200

/** How long until a partial decode may start: 0 means now. */
export function partialWaitMs(lastStartMs: number, nowMs: number, engine: PartialEngine): number {
  const floor = engine === 'whisper' ? WHISPER_PARTIAL_EVERY_MS : PARTIAL_FLOOR_MS
  return Math.max(0, lastStartMs + floor - nowMs)
}

export function partialDue(lastStartMs: number, nowMs: number, engine: PartialEngine): boolean {
  return partialWaitMs(lastStartMs, nowMs, engine) === 0
}

/** The audio a partial decodes: the newest 8 s for Parakeet, the whole segment for Whisper. */
export function partialWindow(seg: Segment, engine: PartialEngine, sampleRate: number): { startSample: number; samples: Float32Array } {
  const max = Math.round((PARTIAL_WINDOW_MS * sampleRate) / 1000)
  if (engine === 'whisper' || seg.samples.length <= max) return { startSample: seg.startSample, samples: seg.samples }
  const from = seg.samples.length - max
  return { startSample: seg.startSample + from, samples: seg.samples.subarray(from) }
}

/** The live line last sent for the open segment. */
export interface LiveLine {
  words: readonly AsrWorkerWord[]
  endMs: number
}

/**
 * An earlier line a window starting at `windowStartMs` can be spliced onto: it reaches past the
 * seam by the same margin as the window's own edge. Known before the decode, so a partial that
 * can't be spliced decodes the whole segment once instead of its window first.
 */
export function lineReachesSeam(prev: LiveLine | null, windowStartMs: number): boolean {
  return !!prev && prev.endMs >= windowStartMs + 2 * SPLICE_GUARD_MS
}

/**
 * The words of a partial whose decode began at `windowStartMs`. A window at the segment's
 * start needs no splice. Without token times, or without an earlier line that reaches past
 * the seam, the windowed decode can't be placed: decode the whole segment instead.
 */
export function splicePartial(
  prev: LiveLine | null,
  decoded: readonly AsrWorkerWord[],
  timed: boolean,
  windowStartMs: number,
  segStartMs: number
): { words: AsrWorkerWord[]; spliced: boolean } | 'whole-segment' {
  if (windowStartMs <= segStartMs) return { words: [...decoded], spliced: false }
  if (!timed || !prev || !lineReachesSeam(prev, windowStartMs)) return 'whole-segment'
  const cut = windowStartMs + SPLICE_GUARD_MS
  const kept = prev.words.filter((w) => w.s_ms < cut)
  const past = prev.words.filter((w) => w.s_ms >= cut)
  const keptUsed = new Set<number>()
  const pastUsed = new Set<number>()
  const fresh: AsrWorkerWord[] = []
  for (const w of decoded) {
    if (w.s_ms < cut - SEAM_TOLERANCE_MS) continue
    if (w.s_ms < cut) {
      // Just before the seam here, past it in the earlier line: without it the word is lost.
      if (claim(past, pastUsed, w)) fresh.push(w)
      continue
    }
    // Just past the seam here, before it in the earlier line: it is already kept.
    if (w.s_ms < cut + SEAM_TOLERANCE_MS && claim(kept, keptUsed, w)) continue
    fresh.push(w)
  }
  return { words: [...kept, ...fresh], spliced: true }
}

/** Seam words compare without case or punctuation. */
function wordKey(w: AsrWorkerWord): string {
  return w.w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** Marks the first unclaimed word of `from` that is `w` within the tolerance; false when none is. */
function claim(from: readonly AsrWorkerWord[], used: Set<number>, w: AsrWorkerWord): boolean {
  const key = wordKey(w)
  const i = from.findIndex((o, j) => !used.has(j) && Math.abs(o.s_ms - w.s_ms) <= SEAM_TOLERANCE_MS && wordKey(o) === key)
  if (i < 0) return false
  used.add(i)
  return true
}
