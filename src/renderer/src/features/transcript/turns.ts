// SPDX-License-Identifier: Apache-2.0
// Grouping chunks into speaker turns, labels and elapsed times. The copy format is the
// shared transcriptCopyText (src/shared/lib/transcript-text.ts).

import {
  DELETED_CHUNK_MARKER,
  SPEAKER_LABEL_ME,
  SPEAKER_LABEL_THEM,
  type TranscriptChunk
} from '@shared/types/transcript'

/** The gap rule exists but is off by default (`transcript_gap_grouping`). */
export const GAP_GROUPING = false
const GAP_MS = 1_000
const GAP_SOFT_CHARS = 250
const GAP_HARD_CHARS = 800
const SENTENCE_END = /[.!?]["'”’)\]]?$/
const LEADING_SPEAKER = /^(Speaker [^:\n]{1,24}):/

export interface Turn {
  /** The first chunk's id. */
  id: string
  source: TranscriptChunk['source']
  label: string
  chunkIds: string[]
  text: string
  startMs: number
  endMs: number
}

export function compareChunks(a: TranscriptChunk, b: TranscriptChunk): number {
  if (a.start_timestamp !== b.start_timestamp) return a.start_timestamp < b.start_timestamp ? -1 : 1
  if (a.end_timestamp !== b.end_timestamp) return a.end_timestamp < b.end_timestamp ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

export function isVisible(c: TranscriptChunk): boolean {
  return c.text !== DELETED_CHUNK_MARKER && c.text.trim().length > 0
}

function speakerKey(c: TranscriptChunk): string {
  // The attributed participant.
  const d = c.detectedSpeaker
  if (!d || typeof d !== 'object') return ''
  return String(d.participantId ?? '')
}

/** Me / Them, or an attributed name. */
export function speakerLabel(c: TranscriptChunk): string {
  const name = c.detected_speaker_name?.trim()
  if (c.source === 'microphone') return name && name !== 'You' ? name : SPEAKER_LABEL_ME
  return name || SPEAKER_LABEL_THEM
}

function capitalize(s: string): string {
  const t = s.trimStart()
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t
}

export function groupTurns(input: TranscriptChunk[]): Turn[] {
  let chunks = input.filter(isVisible)
  // Re-sort only if the input was out of order.
  for (let i = 1; i < chunks.length; i++) {
    if (compareChunks(chunks[i - 1] as TranscriptChunk, chunks[i] as TranscriptChunk) > 0) {
      chunks = [...chunks].sort(compareChunks)
      break
    }
  }
  const turns: Turn[] = []
  let cur: (Turn & { speaker: string; lead: string; lastText: string; session: string }) | null = null
  for (const c of chunks) {
    const text = c.text.trim()
    const speaker = speakerKey(c)
    const lead = LEADING_SPEAKER.exec(text)?.[1] ?? ''
    const start = Date.parse(c.start_timestamp)
    const end = Date.parse(c.end_timestamp)
    // Notula also starts a turn at a session boundary: text from before a pause and
    // after its resume is never one bubble under the earlier timestamp.
    let fresh =
      !cur ||
      cur.source !== c.source ||
      cur.speaker !== speaker ||
      cur.lead !== lead ||
      cur.session !== c.transcription_session_id
    if (!fresh && cur) {
      if (GAP_GROUPING) {
        fresh =
          start - cur.endMs > GAP_MS ||
          (cur.text.length >= GAP_SOFT_CHARS && SENTENCE_END.test(cur.lastText)) ||
          cur.text.length + text.length + 1 > GAP_HARD_CHARS
      } else {
        // By default a new turn starts after a chunk ending with a period.
        fresh = cur.lastText.endsWith('.')
      }
    }
    if (fresh || !cur) {
      cur = {
        id: c.id,
        source: c.source,
        label: speakerLabel(c),
        chunkIds: [c.id],
        text: capitalize(text),
        startMs: start,
        endMs: end,
        speaker,
        lead,
        lastText: text,
        session: c.transcription_session_id
      }
      turns.push(cur)
    } else {
      cur.chunkIds.push(c.id)
      cur.text = `${cur.text} ${text}`
      cur.endMs = Math.max(cur.endMs, end)
      cur.lastText = text
    }
  }
  return turns.map(({ id, source, label, chunkIds, text, startMs, endMs }) => ({
    id,
    source,
    label,
    chunkIds,
    text,
    startMs,
    endMs
  }))
}

function normalizeForMatch(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The turn a passage of the notes came from: a substring match, else
 * the turn holding at least half of the passage's words (longer than two letters), or
 * -1. The enhanced view and the panel share this rule, so a line offers "Show in
 * transcript" only when the panel will find its turn.
 */
export function findTurnForQuote(turns: Turn[], quote: string): number {
  const q = normalizeForMatch(quote)
  if (!q) return -1
  const norm = turns.map((t) => normalizeForMatch(t.text))
  const exact = norm.findIndex((t) => t.includes(q))
  if (exact >= 0) return exact
  const words = new Set(q.split(' ').filter((w) => w.length > 2))
  if (!words.size) return -1
  let best = -1
  let bestScore = 0
  norm.forEach((t, i) => {
    const tw = new Set(t.split(' '))
    let hit = 0
    for (const w of words) if (tw.has(w)) hit++
    const score = hit / words.size
    if (score > bestScore) {
      bestScore = score
      best = i
    }
  })
  return bestScore >= 0.5 ? best : -1
}

/** mm:ss since the first chunk (hh:mm:ss past one hour). */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const pad = (n: number): string => String(n).padStart(2, '0')
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`
}
