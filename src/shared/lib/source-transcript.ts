// SPDX-License-Identifier: Apache-2.0
// A source note's transcript (content sources): which caption track is the video's own,
// which chunks count, and where a chunk sits on the video timeline. Pure: main (prompts, the
// position mapping) and the renderer (the transcript panel) share it.
//
// - Video captions are written as a session whose chunks carry `providerDetails.provider =
//   'captions'` and an exact `sourcePositionMs`.
// - Sessions listed in `NoteSource.superseded_session_ids` are hidden everywhere.
// - While captions exist, the system-audio sessions added by Transcribe audio are kept and can be
//   viewed, but prompts use the captions only.

import { IMPORT_SESSION } from '../types/imports-markdown'
import type { CaptionTrack, NoteSource, SourceEnrichment, SourceSpan } from '../types/sources'
import { DELETED_CHUNK_MARKER, type TranscriptChunk } from '../types/transcript'

/** The caption session's provider id (`TranscriptProviderId`). */
export const CAPTIONS_PROVIDER = 'captions'

function base(lang: string): string {
  return lang.toLowerCase().split(/[-_]/)[0] ?? ''
}

/**
 * The track in the video's own language: a manual track before the automatic one. Manual
 * tracks rank exact language, then the same base language; automatic tracks rank the original
 * (`<lang>-orig`), then exact, then the same base language. Null without a known language, for
 * a live video, or without a match.
 */
export function pickCaptionTrack(enrichment: SourceEnrichment | null, opts: { live?: boolean } = {}): CaptionTrack | null {
  if (opts.live || !enrichment?.language) return null
  const lang = enrichment.language.toLowerCase()
  const own = base(lang)
  const rank = (t: CaptionTrack): number => {
    const l = t.lang.toLowerCase()
    if (t.kind === 'manual') return l === lang ? 0 : base(l) === own && !l.endsWith('-orig') ? 1 : -1
    if (l === `${lang}-orig` || (l.endsWith('-orig') && base(l) === own)) return 2
    return l === lang ? 3 : base(l) === own ? 4 : -1
  }
  let best: CaptionTrack | null = null
  let bestRank = Infinity
  for (const t of enrichment.captionTracks) {
    const r = rank(t)
    if (r >= 0 && r < bestRank) {
      best = t
      bestRank = r
    }
  }
  return best
}

/**
 * A chunk of an untimed import: its times are 1 s offsets, never shown. The import
 * writes the session's provider and model on each chunk.
 */
export function isUntimedChunk(c: TranscriptChunk): boolean {
  return c.providerDetails?.provider === IMPORT_SESSION.provider && c.providerDetails.model === IMPORT_SESSION.untimed
}

export function isCaptionChunk(c: TranscriptChunk): boolean {
  return c.providerDetails?.provider === CAPTIONS_PROVIDER
}

/** The chunk's video position when known (captions are exact; audio is mapped through spans). */
export function chunkPositionMs(c: TranscriptChunk): number | null {
  const p = c.providerDetails?.sourcePositionMs
  return typeof p === 'number' && Number.isFinite(p) && p >= 0 ? p : null
}

export type SourceTranscriptView = 'captions' | 'audio'

/** The views a source note's transcript offers: captions and/or audio, from its live chunks. */
export function sourceTranscriptViews(chunks: TranscriptChunk[], source: Pick<NoteSource, 'superseded_session_ids'>): SourceTranscriptView[] {
  const hidden = new Set(source.superseded_session_ids)
  let captions = false
  let audio = false
  for (const c of chunks) {
    if (hidden.has(c.transcription_session_id) || c.text === DELETED_CHUNK_MARKER) continue
    if (isCaptionChunk(c)) captions = true
    else audio = true
    if (captions && audio) break
  }
  return [...(captions ? (['captions'] as const) : []), ...(audio ? (['audio'] as const) : [])]
}

/**
 * The chunks one view shows: never a superseded session; `captions` = caption chunks only,
 * `audio` = the rest. Without a view, the prompt rule: captions when they exist, else audio.
 */
export function sourceTranscriptChunks(
  chunks: TranscriptChunk[],
  source: Pick<NoteSource, 'superseded_session_ids'>,
  view?: SourceTranscriptView
): TranscriptChunk[] {
  const hidden = new Set(source.superseded_session_ids)
  const live = hidden.size ? chunks.filter((c) => !hidden.has(c.transcription_session_id)) : chunks
  const want = view ?? (live.some((c) => isCaptionChunk(c) && c.text !== DELETED_CHUNK_MARKER) ? 'captions' : 'audio')
  return live.filter((c) => isCaptionChunk(c) === (want === 'captions'))
}

/** How far before the first span, or after a span's end, a chunk still maps to that span's edge. */
const EDGE_SLACK_MS = 5_000

/**
 * A wall time (epoch ms) as a video position through the watched spans: inside a span, its
 * start plus the elapsed wall time at its rate (capped at its end); in a gap after a span (a
 * pause), that span's end; just before the first span, its start. Null otherwise (no span yet,
 * or a span still open).
 */
export function positionFromSpans(wallMs: number, spans: readonly Pick<SourceSpan, 'wall_start' | 'wall_end' | 'pos_start_ms' | 'pos_end_ms' | 'rate'>[]): number | null {
  if (!Number.isFinite(wallMs) || spans.length === 0) return null
  let prev: (typeof spans)[number] | null = null
  for (const s of spans) {
    if (wallMs < s.wall_start) {
      if (prev) return Math.max(0, Math.round(prev.pos_end_ms))
      return s.wall_start - wallMs <= EDGE_SLACK_MS ? Math.max(0, Math.round(s.pos_start_ms)) : null
    }
    if (wallMs <= s.wall_end) {
      const pos = s.pos_start_ms + (wallMs - s.wall_start) * (s.rate > 0 ? s.rate : 1)
      const hi = Math.max(s.pos_start_ms, s.pos_end_ms)
      return Math.max(0, Math.round(Math.min(pos, hi)))
    }
    prev = s
  }
  // After the last closed span: only just after it (the audio of its last moments).
  return prev && wallMs - prev.wall_end <= EDGE_SLACK_MS ? Math.max(0, Math.round(prev.pos_end_ms)) : null
}

const TIME_CITATION = /\[(\d{1,2}):(\d{2})(?::(\d{2}))?\](?!\()/g

/**
 * Enhanced notes of a source note: each plain `[mm:ss]` (or `[h:mm:ss]`) citation becomes a
 * link to the source at that time. Already-linked stamps are left alone.
 */
export function linkTimeCitations(markdown: string, url: string, link: (url: string, ms: number) => string): string {
  return markdown.replace(TIME_CITATION, (all, a: string, b: string, c: string | undefined) => {
    const [h, m, s] = c === undefined ? [0, Number(a), Number(b)] : [Number(a), Number(b), Number(c)]
    if (m > 59 && c !== undefined) return all
    if (s > 59) return all
    return `${all}(${link(url, ((h * 60 + m) * 60 + s) * 1000)})`
  })
}
