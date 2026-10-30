// SPDX-License-Identifier: Apache-2.0
// `speaker-names:clip`: a WAV of up to 8 s for one speaker, the middle
// of its longest clean span (the clean-span selector over its words), read from the note's
// diarization temp audio (alive about 2 h after the pass) or from its kept recordings
// (`audio.keepRecordings`). With neither, `{wav: null, reason: 'no-audio'}`. The clip is built
// in memory and goes to the renderer, which plays it from memory and never stores it. It is
// audio, not a vector, and is never logged.

import { join } from 'node:path'
import { speakerIdentities, wordIdentityKeys } from '@shared/lib/speakers'
import type { AudioSource } from '@shared/types/common'
import { SPEAKER_PROFILE_LIMITS } from '@shared/types/speakers'
import type { TranscriptChunk } from '@shared/types/transcript'
import { cleanSpans } from '../asr/clean-spans'
import { fileSeconds } from '../asr/diarize'
import type { DiarizeSegment } from '../asr/protocol'
import type { MainContext } from '../context'
import { readFramed } from '../crypto/blobs'
import { log } from '../log'
import { getTranscriptionManager } from '../transcription/manager'

const SAMPLE_RATE = 16_000
const BYTES_PER_SAMPLE = 2
/** Words closer than this form one turn of the speaker. */
const TURN_GAP_MS = 400

export type ClipResult = { wav: Uint8Array; reason?: never } | { wav: null; reason: 'no-audio' }

/** A stretch of one speaker, in wall-clock ms. */
interface Stretch {
  startMs: number
  endMs: number
}

/** Each identity's word turns on one channel, as segments in seconds from `base`. */
function turnsOf(chunks: readonly TranscriptChunk[], source: AudioSource, keys: Map<string, (string | null)[]>, speaker: Map<string, number>, base: number): DiarizeSegment[] {
  const words: { key: string; s: number; e: number }[] = []
  for (const c of chunks) {
    const d = c.providerDetails
    const ks = keys.get(c.id)
    if (c.source !== source || !c.is_final || !d || !ks) continue
    d.words.forEach((w, i) => {
      const k = ks[i]
      if (k) words.push({ key: k, s: d.wallClockAnchorMs + w.s_ms, e: d.wallClockAnchorMs + w.e_ms })
    })
  }
  words.sort((a, b) => a.s - b.s)
  const out: DiarizeSegment[] = []
  const last = new Map<string, DiarizeSegment>()
  for (const w of words) {
    let n = speaker.get(w.key)
    if (n === undefined) {
      n = speaker.size
      speaker.set(w.key, n)
    }
    const prev = last.get(w.key)
    if (prev && w.s - (base + prev.end * 1000) < TURN_GAP_MS) {
      prev.end = Math.max(prev.end, (w.e - base) / 1000)
      continue
    }
    const seg = { start: (w.s - base) / 1000, end: (w.e - base) / 1000, speaker: n }
    out.push(seg)
    last.set(w.key, seg)
  }
  return out
}

/** The identity's longest clean span (else its longest turn), cut to its middle 8 s. */
export function clipSpan(chunks: readonly TranscriptChunk[], identityKey: string): { source: AudioSource; span: Stretch } | null {
  const { identities } = speakerIdentities(chunks, { live: false })
  const id = identities.find((i) => i.key === identityKey)
  if (!id) return null
  const keys = wordIdentityKeys(chunks)
  const base = id.startMs
  const speaker = new Map<string, number>()
  const turns = turnsOf(chunks, id.channel, keys, speaker, base)
  // On the mic, system speech is echo residue.
  const echo = id.channel === 'microphone' ? turnsOf(chunks, 'system', keys, new Map(), base) : []
  const me = speaker.get(identityKey)
  if (me === undefined) return null
  const spans = cleanSpans(turns, echo).filter((s) => s.speaker === me)
  const longest = spans[0] ?? [...turns.filter((t) => t.speaker === me)].sort((a, b) => b.end - b.start - (a.end - a.start))[0]
  if (!longest) return null
  const max = SPEAKER_PROFILE_LIMITS.clipMaxMs / 1000
  let { start, end } = longest
  if (end - start > max) {
    const mid = (start + end) / 2
    start = mid - max / 2
    end = mid + max / 2
  }
  return { source: id.channel, span: { startMs: base + start * 1000, endMs: base + end * 1000 } }
}

/** PCM bytes `[from, to)` of one NAU1 file, or null when the file can't give all of them. */
async function readRange(o: { path: string; key: Buffer; id: string }, from: number, to: number): Promise<Buffer | null> {
  const parts: Buffer[] = []
  let at = 0
  try {
    for await (const pcm of readFramed({ ...o, allowTruncated: true })) {
      const end = at + pcm.length
      if (end > from) parts.push(pcm.subarray(Math.max(0, from - at), Math.min(pcm.length, to - at)))
      at = end
      if (at >= to) break
    }
  } catch (err) {
    log('warn', 'speaker-names:clip-read-failed', { err })
    return null
  }
  const out = Buffer.concat(parts)
  return out.length ? out : null
}

function byteOf(seconds: number): number {
  return Math.max(0, Math.round(seconds * SAMPLE_RATE)) * BYTES_PER_SAMPLE
}

/** From the diarization temp audio of the note. */
async function fromTempAudio(ctx: MainContext, noteId: string, source: AudioSource, span: Stretch): Promise<Buffer | null> {
  const files = getTranscriptionManager(ctx).diarizer.tempAudioFor(noteId)
  for (const f of files ?? []) {
    if (f.source !== source) continue
    const start = fileSeconds(f, span.startMs)
    const end = start + (span.endMs - span.startMs) / 1000
    if (start < 0 || end * SAMPLE_RATE > f.samples) continue
    const pcm = await readRange({ path: f.path, key: f.key, id: f.id }, byteOf(start), byteOf(end))
    if (pcm) return pcm
  }
  return null
}

/** From the note's kept recordings, one per (session, source), timed from `started_at`. */
async function fromRecordings(ctx: MainContext, noteId: string, source: AudioSource, span: Stretch): Promise<Buffer | null> {
  // Recordings kept while `audio.keepRecordings` was on still play after it is turned off.
  const rows = await ctx.storage.listRecordings({ noteId }).catch(() => [])
  for (const r of rows) {
    if (r.source !== source) continue
    const startedMs = Date.parse(r.started_at)
    const start = (span.startMs - startedMs) / 1000
    const end = start + (span.endMs - span.startMs) / 1000
    if (!Number.isFinite(start) || start < 0 || (r.duration_ms > 0 && end * 1000 > r.duration_ms)) continue
    const key = Buffer.from(r.file_key)
    try {
      const pcm = await readRange({ path: join(ctx.userDataPath, 'audio', noteId, `${r.id}.naud`), key, id: r.id }, byteOf(start), byteOf(end))
      if (pcm) return pcm
    } finally {
      key.fill(0)
    }
  }
  return null
}

function wav(pcm: Buffer): Uint8Array {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8, 'ascii')
  header.write('fmt ', 12, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(SAMPLE_RATE, 24)
  header.writeUInt32LE(SAMPLE_RATE * BYTES_PER_SAMPLE, 28)
  header.writeUInt16LE(BYTES_PER_SAMPLE, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(pcm.length, 40)
  return new Uint8Array(Buffer.concat([header, pcm]))
}

/** `speaker-names:has-clip`: the note has audio a clip can come from; without it the interface shows lines, not Play. */
export async function speakerClipAvailable(ctx: MainContext, noteId: string): Promise<boolean> {
  if (getTranscriptionManager(ctx).diarizer.tempAudioFor(noteId)?.length) return true
  return (await ctx.storage.listRecordings({ noteId }).catch(() => [])).length > 0
}

export async function speakerClip(ctx: MainContext, noteId: string, identityKey: string): Promise<ClipResult> {
  const chunks = (await getTranscriptionManager(ctx).store.getTranscript(noteId)).filter((c) => c.is_final)
  const at = clipSpan(chunks, identityKey)
  if (!at) return { wav: null, reason: 'no-audio' }
  const pcm = (await fromTempAudio(ctx, noteId, at.source, at.span)) ?? (await fromRecordings(ctx, noteId, at.source, at.span))
  if (!pcm) return { wav: null, reason: 'no-audio' }
  log('info', 'speaker-names:clip', { noteId, ms: Math.round(pcm.length / (SAMPLE_RATE * BYTES_PER_SAMPLE / 1000)) })
  return { wav: wav(pcm) }
}
