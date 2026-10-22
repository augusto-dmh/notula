// SPDX-License-Identifier: Apache-2.0
// The speaker-labelled transcript (the `transcript` prompt input). Turns come from the
// shared `speakerTurns` (chunk-level Me/Them by default, word-level when diarization is
// on), so the
// prompts, the transcript view and chat agree on who said what. A label is written at
// each speaker change as "\n<label>: " (label + 3 characters) and each turn as
// "<text> ", so for chunk-level turns the length follows one simple rule (each
// chunk adds its text + 1) and one formatter serves both the prompt and the 2,500 and
// 200 character gates.
//
// A source note's transcript (content sources) is the sound of a video: no speaker labels, and
// each line starts with its video time, `[mm:ss] `, from the chunk's mapped position. A line
// runs about 15 s of video; a chunk with no known position joins the line before it.
//
// No transcript input carries wall times, so an untimed import shows none either:
// its chunks have no video position.

import { formatPosition } from '@shared/lib/position'
import { chunkPositionMs } from '@shared/lib/source-transcript'
import { labelMode, speakerTurns, type LabelMode, type SpeakerTurn } from '@shared/lib/speakers'
import {
  DELETED_CHUNK_MARKER,
  SPEAKER_LABEL_ME,
  SPEAKER_LABEL_THEM,
  SPEAKER_UNATTRIBUTED,
  type TranscriptChunk
} from '@shared/types/transcript'

/** A participant name that looks like a meeting room gets a `[Room]` label. */
const ROOM_NAME = /\b(room|boardroom|conference|huddle|meeting space)\b/i
const ROOM_PREFIX = '[Room] '
const GENERIC = new Set([SPEAKER_LABEL_ME, SPEAKER_LABEL_THEM, SPEAKER_UNATTRIBUTED])

export type TranscriptLabels = LabelMode

export interface FormattedTranscript {
  text: string
  labels: TranscriptLabels
  justMic: boolean
  hasRoomLabels: boolean
  /** Start of the earliest chunk, ms since the epoch; null without chunks. */
  firstChunkMs: number | null
  turns: SpeakerTurn[]
}

export interface TranscriptOptions {
  /** Word-level attribution (`transcription.diarization` on). */
  wordLevel?: boolean
  /** The meeting is still being transcribed. */
  live?: boolean
  /** A source note: video-time lines instead of speaker turns. */
  media?: boolean
}

/** A media line spans about this much video before the next one starts. */
const MEDIA_LINE_MS = 15_000

function compareChunks(a: TranscriptChunk, b: TranscriptChunk): number {
  if (a.start_timestamp !== b.start_timestamp) return a.start_timestamp < b.start_timestamp ? -1 : 1
  if (a.end_timestamp !== b.end_timestamp) return a.end_timestamp < b.end_timestamp ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/** Chunks that count: not deleted, sorted in the store's merge order. */
export function transcriptChunks(chunks: TranscriptChunk[]): TranscriptChunk[] {
  return chunks.filter((c) => c.text !== DELETED_CHUNK_MARKER).sort(compareChunks)
}

/** The prompt label: a room-like participant name is marked `[Room]`. */
function promptLabel(label: string): string {
  if (GENERIC.has(label) || label.startsWith(ROOM_PREFIX) || /^Speaker [A-Z]+$/.test(label)) return label
  return ROOM_NAME.test(label) ? `${ROOM_PREFIX}${label}` : label
}

/** Speaker turns with their prompt labels. */
export function promptTurns(chunks: TranscriptChunk[], opts: TranscriptOptions = {}): SpeakerTurn[] {
  return speakerTurns(chunks, { wordLevel: opts.wordLevel === true, live: opts.live === true }).map((t) => ({
    ...t,
    label: promptLabel(t.label)
  }))
}

/** `[mm:ss] text` lines for a source note's transcript. */
function mediaText(input: TranscriptChunk[]): string {
  const lines: string[] = []
  let line = ''
  let lineStart: number | null = null
  for (const c of transcriptChunks(input)) {
    const text = c.text.trim()
    if (!text) continue
    const pos = chunkPositionMs(c)
    if (pos !== null && (lineStart === null || pos - lineStart >= MEDIA_LINE_MS || pos < lineStart)) {
      if (line) lines.push(line)
      line = `[${formatPosition(pos)}] ${text}`
      lineStart = pos
      continue
    }
    line = line ? `${line} ${text}` : text
  }
  if (line) lines.push(line)
  return lines.length ? `\n${lines.join('\n')}` : ''
}

export function formatTranscript(input: TranscriptChunk[], opts: TranscriptOptions = {}): FormattedTranscript {
  const turns = promptTurns(input, opts)
  if (opts.media) {
    const first = transcriptChunks(input)[0]
    const firstMs = first ? Date.parse(first.start_timestamp) : NaN
    return {
      text: mediaText(input),
      labels: 'unlabeled',
      justMic: false,
      hasRoomLabels: false,
      firstChunkMs: Number.isFinite(firstMs) ? firstMs : null,
      turns
    }
  }
  let text = ''
  let last: string | null = null
  for (const t of turns) {
    if (t.label !== last) {
      text += `\n${t.label}: `
      last = t.label
    }
    text += `${t.text} `
  }
  const { mode, hasRoomLabels } = labelMode(turns)
  const justMic = text.length > 0 && turns.length > 0 && turns.every((t) => t.source === 'microphone')
  const first = transcriptChunks(input)[0]
  const firstMs = first ? Date.parse(first.start_timestamp) : NaN
  return {
    text,
    labels: mode,
    justMic,
    hasRoomLabels,
    firstChunkMs: Number.isFinite(firstMs) ? firstMs : null,
    turns
  }
}

/** The last `n` words of the transcript, still speaker-labelled (meeting-end-check input). */
export function lastWords(transcript: string, n: number): string {
  // Words sit at the even indexes, the whitespace between them (line breaks kept) at the odd.
  const parts = transcript.trim().split(/(\s+)/)
  return parts.slice(Math.max(0, parts.length - (n * 2 - 1))).join('')
}
