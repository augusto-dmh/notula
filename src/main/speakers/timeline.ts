// SPDX-License-Identifier: Apache-2.0
// The speaker timeline and the chunk / word stamping. Pure main-process logic over speaker
// events, whatever reader
// produced them.
//
// - A ring buffer of at most 10,000 events. A new speaker starts at the event time minus
//   the app's detection lag, never before the previous event's start; the same speaker
//   again only refreshes "last seen"; a clear appends a "nobody" marker.
// - Intervals: each event lasts until the next one; the last stays open up to now, but at
//   most 10 s after its speaker was last seen. Nobody markers are not intervals, and
//   intervals under 200 ms are ignored.
// - Chunk speaker: over [start − 500 ms, end + 300 ms], each interval scores its overlap
//   inside the chunk plus 0.25 × its overlap in the padding; the best participant wins.
// - Word speaker: among intervals of at least 200 ms overlapping the chunk ± 500 ms, the
//   one overlapping the word most, else the one holding the word's start.

import { ATTRIBUTION_LIMITS, type AttributionSource } from '@shared/types/transcript'

export interface SpeakerEvent {
  /** null = the "nobody" marker of a clear. */
  participantId: string | null
  participantName: string | null
  source: AttributionSource | null
  startMs: number
  lastSeenMs: number
}

export interface SpeakerInterval {
  participantId: string
  participantName: string
  source: AttributionSource
  startMs: number
  endMs: number
}

export interface Winner {
  participantId: string
  participantName: string
  source: AttributionSource
}

const L = ATTRIBUTION_LIMITS

function overlap(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

export class SpeakerTimeline {
  private events: SpeakerEvent[] = []

  get size(): number {
    return this.events.length
  }

  clearAll(): void {
    this.events = []
  }

  private last(): SpeakerEvent | undefined {
    return this.events[this.events.length - 1]
  }

  private push(e: SpeakerEvent): void {
    this.events.push(e)
    if (this.events.length > L.timelineMax) this.events.splice(0, this.events.length - L.timelineMax)
  }

  /** An accepted speaker event. Returns whether the speaker changed or was only refreshed. */
  speaker(id: string, name: string, source: AttributionSource, atMs: number, lagMs: number): 'changed' | 'refreshed' {
    const last = this.last()
    if (last && last.participantId === id) {
      last.lastSeenMs = Math.max(last.lastSeenMs, atMs)
      last.participantName = name
      return 'refreshed'
    }
    const start = Math.max(atMs - lagMs, last ? last.startMs : Number.NEGATIVE_INFINITY)
    this.push({ participantId: id, participantName: name, source, startMs: start, lastSeenMs: atMs })
    return 'changed'
  }

  /** A clear: nobody (or only the user) is speaking. Returns false when already clear. */
  clear(atMs: number): boolean {
    const last = this.last()
    if (!last || last.participantId === null) return false
    this.push({ participantId: null, participantName: null, source: null, startMs: Math.max(atMs, last.startMs), lastSeenMs: atMs })
    return true
  }

  /** The current speaker (the last event, when it names someone), with when they were last seen. */
  current(): SpeakerEvent | null {
    const last = this.last()
    return last && last.participantId !== null ? last : null
  }

  /** Intervals overlapping [fromMs, toMs]. */
  intervals(nowMs: number, fromMs = Number.NEGATIVE_INFINITY, toMs = Number.POSITIVE_INFINITY): SpeakerInterval[] {
    const out: SpeakerInterval[] = []
    // Walk back from the newest event: chunks are recent, so this stays short.
    for (let i = this.events.length - 1; i >= 0; i--) {
      const e = this.events[i] as SpeakerEvent
      const next = this.events[i + 1]
      const end = next ? next.startMs : Math.min(nowMs, e.lastSeenMs + L.openIntervalMaxMs)
      if (end < fromMs) break
      if (e.participantId === null || e.source === null || e.startMs > toMs) continue
      if (end - e.startMs < L.minIntervalMs) continue
      out.push({ participantId: e.participantId, participantName: e.participantName ?? e.participantId, source: e.source, startMs: e.startMs, endMs: end })
    }
    return out.reverse()
  }

  /** The chunk's participant, or null when no interval scores. */
  chunkSpeaker(startMs: number, endMs: number, nowMs: number): Winner | null {
    const w0 = startMs - L.padBeforeMs
    const w1 = endMs + L.padAfterMs
    const scores = new Map<string, { score: number; winner: Winner }>()
    for (const iv of this.intervals(nowMs, w0, w1)) {
      const inside = overlap(iv.startMs, iv.endMs, startMs, endMs)
      const padded = overlap(iv.startMs, iv.endMs, w0, w1) - inside
      const score = inside + L.padWeight * padded
      if (score <= 0) continue
      const prev = scores.get(iv.participantId)
      const winner = { participantId: iv.participantId, participantName: iv.participantName, source: iv.source }
      if (prev) {
        prev.score += score
        prev.winner = winner
      } else scores.set(iv.participantId, { score, winner })
    }
    let best: { score: number; winner: Winner } | null = null
    for (const s of scores.values()) if (!best || s.score > best.score) best = s
    return best?.winner ?? null
  }

  /** Each word's participant id (undefined when none), for words in unix ms. */
  wordSpeakers(words: readonly { startMs: number; endMs: number }[], chunkStartMs: number, chunkEndMs: number, nowMs: number): (string | undefined)[] {
    const ivs = this.intervals(nowMs, chunkStartMs - L.padBeforeMs, chunkEndMs + L.padBeforeMs)
    return words.map((w) => {
      let best: SpeakerInterval | null = null
      let bestOverlap = 0
      for (const iv of ivs) {
        const o = overlap(iv.startMs, iv.endMs, w.startMs, w.endMs)
        if (o > bestOverlap) {
          bestOverlap = o
          best = iv
        }
      }
      if (best) return best.participantId
      const holder = ivs.find((iv) => iv.startMs <= w.startMs && w.startMs < iv.endMs)
      return holder?.participantId
    })
  }
}
