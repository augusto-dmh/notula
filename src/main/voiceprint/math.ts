// SPDX-License-Identifier: Apache-2.0
// The voiceprint's maths: classification, self match, labels, chunk assignment and the
// centroid fold. Pure functions; main only. Thresholds live in VOICEPRINT_LIMITS.

import type { IsoTime } from '@shared/types/common'
import { MEETING_APPS } from '@shared/types/meetings'
import type { TranscriptChunk } from '@shared/types/transcript'
import { VOICEPRINT_LIMITS as L, type VoiceprintClassification } from '@shared/types/voiceprint'
import type { VoiceprintRow } from '../storage/api'
import { BROWSER_IDS } from '../consent/apps'
import type { VoiceprintSegment, VoiceprintSpeaker } from './protocol'

export type Centroid = VoiceprintRow['centroids'][number]

export function cosine(a: readonly number[], b: readonly number[]): number {
  let dot = 0
  let na = 0
  let nb = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) {
    const x = a[i] as number
    const y = b[i] as number
    dot += x * y
    na += x * x
    nb += y * y
  }
  return na > 0 && nb > 0 ? dot / Math.sqrt(na * nb) : 0
}

function normalize(v: number[]): number[] {
  const len = Math.sqrt(v.reduce((n, x) => n + x * x, 0))
  return len > 0 ? v.map((x) => x / len) : v
}

function speechMs(chunks: TranscriptChunk[], source: TranscriptChunk['source']): number {
  let ms = 0
  for (const c of chunks) {
    if (c.source !== source || !c.is_final || !c.text.trim()) continue
    const d = Date.parse(c.end_timestamp) - Date.parse(c.start_timestamp)
    if (Number.isFinite(d) && d > 0) ms += d
  }
  return ms
}

/** In person or online, from a session's final chunks and the mic apps seen during it. */
export function classify(chunks: TranscriptChunk[], appsSeen: Iterable<string>): VoiceprintClassification {
  const system = speechMs(chunks, 'system')
  const mic = speechMs(chunks, 'microphone')
  const conferencingApp = [...appsSeen].some((id) => id in MEETING_APPS && !BROWSER_IDS.has(id))
  if (system >= L.onlineSystemSpeechMs || conferencingApp) return 'online'
  if (mic >= L.inPersonMicMs && system <= L.inPersonSystemMaxMs) return 'in_person'
  return 'unknown'
}

/** The diarized speaker that is the user, if any, with the best cosine and margin (debug logs only). */
export function matchSelf(speakers: VoiceprintSpeaker[], centroids: Centroid[]): { self: number | null; best: number; margin: number } {
  const scored = speakers
    .filter((s): s is VoiceprintSpeaker & { vector: number[] } => !!s.vector)
    .map((s) => ({ speaker: s.speaker, score: Math.max(...centroids.map((c) => cosine(s.vector, c.vector)), -1) }))
    .sort((a, b) => b.score - a.score)
  const top = scored[0]
  if (!top) return { self: null, best: 0, margin: 0 }
  const margin = top.score - (scored[1]?.score ?? -1)
  const ok = top.score >= L.selfCosine && margin >= L.selfMargin
  return { self: ok ? top.speaker : null, best: top.score, margin }
}

/** `Me`, then `Speaker N` in order of first appearance (N from 2 with a self speaker, else 1). */
export function labels(segments: VoiceprintSegment[], self: number | null): Map<number, string> {
  const out = new Map<number, string>()
  let n = self !== null ? 2 : 1
  for (const s of [...segments].sort((a, b) => a.start - b.start)) {
    if (out.has(s.speaker)) continue
    out.set(s.speaker, s.speaker === self ? 'Me' : `Speaker ${n++}`)
  }
  return out
}

/** Where wall-clock time sits in the temp file: one anchor per contiguous run of audio. */
export interface Anchor {
  sample: number
  unixMs: number
}

export function fileSeconds(anchors: readonly Anchor[], unixMs: number): number | null {
  let a: Anchor | null = null
  for (const x of anchors) {
    if (x.unixMs <= unixMs) a = x
    else break
  }
  if (!a) return null
  return (a.sample + ((unixMs - a.unixMs) * 16000) / 1000) / 16000
}

/** The speaker overlapping a final mic chunk most, when coverage ≥ 0.5 and share ≥ 0.7. */
export function assignSpeaker(chunk: TranscriptChunk, segments: VoiceprintSegment[], anchors: readonly Anchor[]): number | null {
  const spans: [number, number][] = []
  const d = chunk.providerDetails
  if (d?.words?.length) {
    for (const w of d.words) spans.push([d.wallClockAnchorMs + w.s_ms, d.wallClockAnchorMs + w.e_ms])
  } else {
    spans.push([Date.parse(chunk.start_timestamp), Date.parse(chunk.end_timestamp)])
  }
  let total = 0
  let covered = 0
  const per = new Map<number, number>()
  for (const [from, to] of spans) {
    const a = fileSeconds(anchors, from)
    const b = fileSeconds(anchors, to)
    if (a === null || b === null || !(b > a)) continue
    total += b - a
    for (const s of segments) {
      const o = Math.min(b, s.end) - Math.max(a, s.start)
      if (o <= 0) continue
      covered += o
      per.set(s.speaker, (per.get(s.speaker) ?? 0) + o)
    }
  }
  if (total <= 0 || covered <= 0) return null
  const [winner, amount] = [...per.entries()].sort((x, y) => y[1] - x[1])[0] as [number, number]
  if (Math.min(covered, total) / total < L.chunkCoverage || amount / covered < L.chunkShare) return null
  return winner
}

/** The dominant speaker of an enrolment input, when it passes 20 s and a 0.8 share. */
export function dominant(speakers: VoiceprintSpeaker[]): { speaker: VoiceprintSpeaker | null; speechMs: number; reason: 'too-little-speech' | 'not-dominant' | null } {
  const total = speakers.reduce((n, s) => n + s.speechMs, 0)
  const top = [...speakers].sort((a, b) => b.speechMs - a.speechMs)[0]
  if (!top || top.speechMs < L.enrolDominantMs || !top.vector) return { speaker: null, speechMs: top?.speechMs ?? 0, reason: 'too-little-speech' }
  if (top.speechMs / total < L.enrolShare) return { speaker: null, speechMs: top.speechMs, reason: 'not-dominant' }
  return { speaker: top, speechMs: top.speechMs, reason: null }
}

/** Average into the nearest centroid at cosine ≥ 0.6 (old weight capped at 10 min), else a new one; keep 4. */
export function fold(centroids: Centroid[], vector: number[], ms: number, now: IsoTime): Centroid[] {
  const v = normalize(vector)
  let best = -1
  let at = -1
  centroids.forEach((c, i) => {
    const s = cosine(c.vector, v)
    if (s > best) {
      best = s
      at = i
    }
  })
  const out = centroids.map((c) => ({ ...c, vector: [...c.vector] }))
  if (at >= 0 && best >= L.mergeCosine) {
    const c = out[at] as Centroid
    const w = Math.min(c.totalSpeechMs, L.weightCapMs)
    c.vector = normalize(c.vector.map((x, i) => x * w + (v[i] ?? 0) * ms))
    c.totalSpeechMs += ms
    c.updatedAt = now
  } else {
    out.push({ vector: v, totalSpeechMs: ms, updatedAt: now })
  }
  return out.sort((a, b) => b.totalSpeechMs - a.totalSpeechMs).slice(0, L.maxCentroids)
}
