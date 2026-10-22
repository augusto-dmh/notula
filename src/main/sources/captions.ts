// SPDX-License-Identifier: Apache-2.0
// Video captions as a source note's transcript.
//
// - Fetch: the managed yt-dlp (`runYtDlp`, purpose `captions`: `--ignore-config`, no cookies,
//   the egress check before spawning, one job at a time) with `--skip-download --write-subs
//   --write-auto-subs --sub-format vtt --sub-langs <the track> -P <app temp>`. The folder is
//   deleted after the read, and swept at startup. Or the extension's cues for that video, when it
//   sent them (bus `media:extension-captions`).
// - Parse: `vtt.ts` (WebVTT cues, the rolling duplicates of automatic tracks collapsed, grouped
//   into chunks of about a sentence, at most 15 s). Measured on a public talk: the manual and the
//   automatic English tracks gave 2,232 and 2,253 words, with no repeated lines.
// - Write: the audio-import recipe up to "end session", and no further: a session
//   with provider `captions`, final `system` chunks whose start is the anchor plus the cue start
//   and whose `providerDetails.sourcePositionMs` is the exact video position, then the session
//   ends. No speaker naming, no automatic generation. The chunks go straight to storage (pushed
//   to the renderers only), and only while the note isn't capturing (`plan.ts`), so nothing it records is hidden.
//
// Logs carry states, counts and exit codes only: never a title, URL or caption text.

import { randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import { CAPTIONS_PROVIDER } from '@shared/lib/source-transcript'
import type { CaptionTrack, NoteSource } from '@shared/types/sources'
import type { PushChannel } from '@shared/ipc'
import type { TranscriptChanged, TranscriptChunk } from '@shared/types/transcript'
import type { ExtCaptions } from '@shared/types/extension-protocol'
import type { MainContext } from '../context'
import { log } from '../log'
import { runYtDlp } from './tools'
import { collapseRolling, cueText, cuesFromVtt, groupCues, type Cue } from './vtt'

export type { Cue } from './vtt'

export type CaptionsFailure = 'not-ready' | 'local-only' | 'off' | 'paused' | 'timeout' | 'failed' | 'no-track' | 'empty'

export type CaptionsFetch = { ok: true; cues: Cue[] } | { ok: false; reason: CaptionsFailure }

const TEMP_FOLDER = 'notula-captions'
/** A caption file larger than this is not a caption file. */
const MAX_VTT_BYTES = 16 * 1024 * 1024
const EXT_CUES_TTL_MS = 6 * 60 * 60_000

function tempRoot(): string {
  return join(app.getPath('temp'), TEMP_FOLDER)
}

/** Startup: removes caption folders an earlier run left behind. */
export async function sweepCaptionTemp(): Promise<void> {
  await rm(tempRoot(), { recursive: true, force: true }).catch(() => undefined)
}

// ---------- fetching ----------

/** A YouTube video's watch URL from its canonical key, without playlist or time parameters. */
export function watchUrl(source: Pick<NoteSource, 'provider' | 'canonical_key'>): string | null {
  if (source.provider !== 'youtube' || !source.canonical_key.startsWith('youtube:')) return null
  const id = source.canonical_key.slice('youtube:'.length)
  return /^[A-Za-z0-9_-]{6,20}$/.test(id) ? `https://www.youtube.com/watch?v=${id}` : null
}

const CAPTION_LANG = /^[A-Za-z0-9_-]{1,35}$/

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Fetches one track with yt-dlp into an app-temp folder, reads it and deletes the folder. */
export async function fetchWithYtDlp(ctx: MainContext, url: string, track: CaptionTrack, signal?: AbortSignal): Promise<CaptionsFetch> {
  // The key comes from YouTube's JSON or the extension: a `,` would make yt-dlp fetch several
  // tracks.
  if (!CAPTION_LANG.test(track.lang)) return { ok: false, reason: 'no-track' }
  const dir = join(tempRoot(), randomUUID())
  try {
    await mkdir(dir, { recursive: true })
    const r = await runYtDlp(ctx, {
      purpose: 'captions',
      args: [
        '--skip-download',
        '--write-subs',
        '--write-auto-subs',
        '--sub-format',
        'vtt',
        '--sub-langs',
        `^${escapeRegex(track.lang)}$`,
        '--no-playlist',
        '-P',
        dir,
        '-o',
        'captions.%(ext)s',
        url
      ],
      ...(signal ? { signal } : {})
    })
    if (!r.ok) return { ok: false, reason: r.reason }
    const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.vtt'))
    const file = files[0]
    if (!file) return { ok: false, reason: 'no-track' }
    const path = join(dir, file)
    if ((await stat(path)).size > MAX_VTT_BYTES) return { ok: false, reason: 'failed' }
    const cues = cuesFromVtt(await readFile(path, 'utf8'), track.kind === 'asr')
    return cues.length ? { ok: true, cues } : { ok: false, reason: 'empty' }
  } catch (err) {
    log('warn', 'sources:captions-read-failed', { code: (err as { code?: unknown })?.code === undefined ? 'error' : String((err as { code?: unknown }).code) })
    return { ok: false, reason: 'failed' }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

// ---------- the extension's cues ----------

interface ExtTrack {
  lang: string
  kind: 'manual' | 'asr'
  parts: Map<number, ExtCaptions['cues']>
  total: number
  at: number
}

/** The extension's cues per canonical key (memory only, the latest track per video). */
const extTracks = new Map<string, ExtTrack>()

export function rememberExtensionCaptions(e: ExtCaptions): void {
  if (!e.video || !Array.isArray(e.cues) || e.parts < 1 || e.part < 0 || e.part >= e.parts) return
  const now = Date.now()
  for (const [k, t] of extTracks) if (now - t.at > EXT_CUES_TTL_MS) extTracks.delete(k)
  let t = extTracks.get(e.video)
  if (!t || t.lang !== e.lang || t.kind !== e.kind || t.total !== e.parts) {
    t = { lang: e.lang, kind: e.kind, parts: new Map(), total: e.parts, at: now }
    extTracks.set(e.video, t)
  }
  t.parts.set(e.part, e.cues)
  t.at = now
}

/** The extension's track for a video, as caption tracks the plan can choose from. */
export function extensionTrack(canonicalKey: string): CaptionTrack | null {
  const t = extTracks.get(canonicalKey)
  return t && t.parts.size === t.total ? { lang: t.lang, kind: t.kind, name: null, via: 'extension' } : null
}

export function extensionCues(canonicalKey: string): CaptionsFetch {
  const t = extTracks.get(canonicalKey)
  if (!t || t.parts.size !== t.total) return { ok: false, reason: 'no-track' }
  const raw: { startMs: number; endMs: number; lines: string[] }[] = []
  for (let i = 0; i < t.total; i++) {
    for (const c of t.parts.get(i) ?? []) {
      if (typeof c.s !== 'number' || typeof c.e !== 'number' || typeof c.t !== 'string') continue
      const lines = c.t.split('\n').map(cueText).filter(Boolean)
      if (lines.length) raw.push({ startMs: Math.max(0, c.s), endMs: Math.max(c.s, c.e), lines })
    }
  }
  raw.sort((a, b) => a.startMs - b.startMs)
  const cues = groupCues(collapseRolling(raw, t.kind === 'asr'))
  return cues.length ? { ok: true, cues } : { ok: false, reason: 'empty' }
}

// ---------- writing ----------

/**
 * Writes the cues as a new `captions` session of the note, then ends the session: the import
 * recipe's steps 1–4, without speaker naming or generation. Returns the session id.
 */
export async function writeCaptionTranscript(
  ctx: MainContext,
  noteId: string,
  cues: Cue[],
  track: CaptionTrack
): Promise<{ sessionId: string; chunks: number }> {
  const note = await ctx.storage.getNote(noteId)
  if (!note) throw new Error('note-missing')
  const identity = await ctx.storage.identity()
  const created = Date.parse(note.created_at)
  // The anchor is the note's creation, so `start − session.started_at` is the video position too.
  const anchor = Number.isFinite(created) ? created : Date.now()
  const sessionId = randomUUID()
  const model = track.via === 'extension' ? `extension:${track.kind}` : `yt-dlp:${track.kind}`
  await ctx.storage.createSession({
    id: sessionId,
    document_id: noteId,
    provider: CAPTIONS_PROVIDER,
    model,
    language: track.lang,
    started_at: new Date(anchor).toISOString()
  })
  const rows: TranscriptChunk[] = []
  for (const c of cues) {
    rows.push({
      id: randomUUID(),
      document_id: noteId,
      workspace_id: identity.workspaceId,
      owner_id: identity.ownerId,
      transcription_session_id: sessionId,
      source: 'system',
      start_timestamp: new Date(anchor + c.startMs).toISOString(),
      end_timestamp: new Date(anchor + Math.max(c.endMs, c.startMs)).toISOString(),
      text: c.text,
      is_final: true,
      detected_speaker_name: null,
      detectedSpeaker: null,
      providerDetails: { words: [], provider: CAPTIONS_PROVIDER, model, wallClockAnchorMs: anchor, sourcePositionMs: c.startMs }
    })
  }
  // Straight to storage, never through the live chunk store: the bus `transcript:changed`
  // listeners (live context, consent, the dock, inactivity) would take them for speech.
  // Only the renderers hear of them, so an open transcript panel shows them.
  await ctx.storage.upsertChunks(rows)
  const changed: TranscriptChanged = { noteId, upserted: rows, removedIds: [] }
  for (const wc of ctx.windows.targets()) wc.send('transcript:changed' satisfies PushChannel, changed)
  await ctx.storage.endSession(sessionId, new Date().toISOString(), 'captions_complete')
  return { sessionId, chunks: cues.length }
}
