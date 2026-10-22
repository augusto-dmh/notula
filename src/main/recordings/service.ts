// SPDX-License-Identifier: Apache-2.0
// Kept meeting audio.
//
// - Opt-in (`audio.keepRecordings`, off by default). While it is on, every 16 kHz s16le
//   batch a transcription session hands to ASR is teed into one recording per (session,
//   source): `<userData>/audio/<noteId>/<recordingId>.naud`, NAU1 with a random per-file
//   key that lives only in the recording's row inside the encrypted database. The
//   row is created first, then the file: a file never exists without its row.
// - The writer frames at 64 KiB and at least once per second (crypto/blobs.ts), so a crash
//   loses about 1 s. At startup `recording` rows become `incomplete`; their sizes are
//   recounted from the complete frames on disk, and those frames still export.
// - Retention (`audio.retention`): at startup and every 24 h on a main timer, rows whose
//   `ended_at` is older than the period are deleted (the key first), then their files
//   (a missing file is fine). `note` keeps them as long as the note. A file without a row
//   (its note purged before the `rel:` resolver ran) is removed by the same sweep.
// - Export writes standard WAVs to a folder the user picks; nothing else ever decrypts.
//   Neither audio bytes nor keys reach the renderer.

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import type { AudioRetention, RecordingInfo, RecordingsUsage } from '@shared/types/recordings'
import { RECORDING_LIMITS } from '@shared/types/recordings'
import type { AudioSource } from '@shared/types/common'
import type { MainContext } from '../context'
import { FramedWriter, framedToWav, randomKey } from '../crypto/blobs'
import { log } from '../log'
import type { RecordingRow } from '../storage/api'

const DAY_MS = 86_400_000
const RETENTION_DAYS: Record<Exclude<AudioRetention, 'note'>, number> = { '1d': 1, '7d': 7, '30d': 30, '90d': 90, '365d': 365 }
/** Bytes per ms of 16 kHz s16le mono. */
const BYTES_PER_MS = 32
/** NAU1 sizes: the header, and each frame's nonce · length · tag. */
const NAU1_HEADER = 31
const FRAME_OVERHEAD = 12 + 4 + 16
/** A live recording's row is refreshed this often, so usage and a crash's leftovers stay close. */
const PROGRESS_EVERY_MS = 10_000
/** An orphan file younger than this may belong to a recording being created: left alone. */
const ORPHAN_MIN_AGE_MS = 60_000
const FILE_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.naud$/i
const MAX_TITLE_CHARS = 120

interface LiveRecording {
  id: string
  noteId: string
  source: AudioSource
  path: string
  writer: FramedWriter | null
  opening: Promise<void>
  queue: Buffer[]
  dead: boolean
  plainBytes: number
  frames: number
  lastProgressAt: number
}

/** The per-session tee: one live recording per source, created on the source's first batch. */
export class SessionRecorder {
  private readonly files: Partial<Record<AudioSource, LiveRecording>> = {}
  private closed = false

  constructor(
    private readonly svc: RecordingsService,
    readonly noteId: string,
    readonly sessionId: string
  ) {}

  append(source: AudioSource, pcm: Buffer): void {
    if (this.closed || !pcm.byteLength) return
    const f = this.files[source] ?? this.open(source)
    if (f.dead) return
    // The writer may hold the buffer until its next frame: never the caller's copy.
    const copy = Buffer.from(pcm)
    if (f.writer) f.writer.append(copy)
    else f.queue.push(copy)
    f.plainBytes += copy.byteLength
    // At most one frame per 64 KiB, plus the 1 s flushes (counted when the row is refreshed).
    if (Date.now() - f.lastProgressAt >= PROGRESS_EVERY_MS) this.svc.progress(f)
  }

  private open(source: AudioSource): LiveRecording {
    const f: LiveRecording = {
      id: randomUUID(),
      noteId: this.noteId,
      source,
      path: '',
      writer: null,
      opening: Promise.resolve(),
      queue: [],
      dead: false,
      plainBytes: 0,
      frames: 0,
      lastProgressAt: Date.now()
    }
    this.files[source] = f
    f.opening = this.svc.start(f, this.sessionId)
    return f
  }

  /** Writes the last frames, closes the files and completes the rows. */
  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    await Promise.all(Object.values(this.files).map((f) => this.svc.finish(f)))
  }
}

export class RecordingsService {
  /** Startup housekeeping (interrupted rows, the first sweep) runs before any new row. */
  private readonly ready: Promise<void>
  private markReady: () => void = () => undefined
  private readonly live = new Map<string, LiveRecording>()
  private sweepTimer: NodeJS.Timeout | null = null
  private housekeepingStarted = false

  constructor(private readonly ctx: MainContext) {
    this.ready = new Promise<void>((resolve) => {
      this.markReady = resolve
    })
  }

  get root(): string {
    return join(this.ctx.userDataPath, 'audio')
  }

  private pathOf(noteId: string, id: string): string {
    return join(this.root, noteId, `${id}.naud`)
  }

  /** The session's tee, or null while "Keep meeting audio" is off. */
  recorderFor(noteId: string, sessionId: string, enabled: boolean): SessionRecorder | null {
    return enabled ? new SessionRecorder(this, noteId, sessionId) : null
  }

  /** Once storage is ready: interrupted rows, the first sweep, then the 24 h timer. */
  async housekeeping(): Promise<void> {
    if (this.housekeepingStarted) return
    this.housekeepingStarted = true
    try {
      const n = await this.ctx.storage.markInterruptedRecordings()
      if (n) {
        log('warn', 'recordings:interrupted', { count: n })
        await this.recountIncomplete()
      }
    } catch (err) {
      log('error', 'recordings:interrupted-sweep-failed', { err })
    } finally {
      this.markReady()
    }
    await this.sweep('startup')
    this.sweepTimer = setInterval(() => void this.sweep('timer'), RECORDING_LIMITS.sweepMs)
    this.sweepTimer.unref()
  }

  // ---------- live recordings ----------

  async start(f: LiveRecording, sessionId: string): Promise<void> {
    await this.ready
    const key = randomKey()
    try {
      await this.ctx.storage.createRecording({
        id: f.id,
        note_id: f.noteId,
        session_id: sessionId,
        source: f.source,
        started_at: new Date().toISOString(),
        file_key: new Uint8Array(key)
      })
    } catch (err) {
      f.dead = true
      f.queue = []
      log('warn', 'recordings:row-failed', { noteId: f.noteId, source: f.source, err })
      return
    }
    f.path = this.pathOf(f.noteId, f.id)
    try {
      mkdirSync(join(this.root, f.noteId), { recursive: true })
      f.writer = await FramedWriter.create({ path: f.path, key, id: f.id })
    } catch (err) {
      f.dead = true
      f.queue = []
      log('warn', 'recordings:open-failed', { noteId: f.noteId, recordingId: f.id, err })
      await this.ctx.storage.deleteRecordings([f.id]).catch(() => undefined)
      return
    }
    if (f.dead) {
      // Deleted while it was opening.
      await f.writer.abort().catch(() => undefined)
      f.writer = null
      return
    }
    for (const b of f.queue.splice(0)) f.writer.append(b)
    this.live.set(f.id, f)
    log('info', 'recordings:started', { noteId: f.noteId, recordingId: f.id, source: f.source })
  }

  progress(f: LiveRecording): void {
    f.lastProgressAt = Date.now()
    if (f.dead || !f.writer) return
    const frames = Math.ceil(f.plainBytes / RECORDING_LIMITS.frameBytes)
    void this.ctx.storage
      .updateRecording(f.id, {
        duration_ms: Math.round(f.plainBytes / BYTES_PER_MS),
        bytes: NAU1_HEADER + f.plainBytes + frames * FRAME_OVERHEAD
      })
      .catch((err: unknown) => log('warn', 'recordings:progress-failed', { recordingId: f.id, err }))
  }

  async finish(f: LiveRecording): Promise<void> {
    await f.opening
    this.live.delete(f.id)
    if (f.dead || !f.writer) return
    const writer = f.writer
    f.writer = null
    try {
      const { fileBytes, plainBytes } = await writer.close()
      await this.ctx.storage.updateRecording(f.id, {
        ended_at: new Date().toISOString(),
        duration_ms: Math.round(plainBytes / BYTES_PER_MS),
        bytes: fileBytes,
        state: 'complete'
      })
      log('info', 'recordings:completed', { noteId: f.noteId, recordingId: f.id, source: f.source, ms: Math.round(plainBytes / BYTES_PER_MS) })
    } catch (err) {
      // The frames written so far stay readable; the row says so.
      log('warn', 'recordings:close-failed', { recordingId: f.id, err })
      await this.ctx.storage
        .updateRecording(f.id, { ended_at: new Date().toISOString(), state: 'incomplete' })
        .catch(() => undefined)
    }
  }

  /** Stops the live recordings among `ids`, removing their files (they are being deleted). */
  private async abortLive(ids: Set<string> | null): Promise<void> {
    const targets = [...this.live.values()].filter((f) => !ids || ids.has(f.id))
    await Promise.all(
      targets.map(async (f) => {
        f.dead = true
        this.live.delete(f.id)
        const w = f.writer
        f.writer = null
        await w?.abort().catch(() => undefined)
      })
    )
  }

  // ---------- reads ----------

  async list(noteId: string): Promise<RecordingInfo[]> {
    const rows = await this.ctx.storage.listRecordings({ noteId })
    return rows.map(info)
  }

  usage(): Promise<RecordingsUsage> {
    return this.ctx.storage.recordingsUsage()
  }

  // ---------- deletion ----------

  /** Rows first (the keys go with them, and the trigger queues the files), then the files. */
  async deleteRows(rows: RecordingRow[], why: string): Promise<number> {
    if (!rows.length) return 0
    await this.abortLive(new Set(rows.map((r) => r.id)))
    const { deleted } = await this.ctx.storage.deleteRecordings(rows.map((r) => r.id))
    const gone = new Set(deleted)
    for (const r of rows) if (gone.has(r.id)) this.removeFile(r.note_id, r.id)
    log('info', 'recordings:deleted', { count: deleted.length, why })
    return deleted.length
  }

  async deleteForNote(noteId: string): Promise<void> {
    await this.deleteRows(await this.ctx.storage.listRecordings({ noteId }), 'user-note')
  }

  async deleteOne(recordingId: string): Promise<void> {
    const row = (await this.ctx.storage.listRecordings({})).find((r) => r.id === recordingId)
    if (row) await this.deleteRows([row], 'user-recording')
  }

  async deleteAll(): Promise<void> {
    await this.abortLive(null)
    await this.deleteRows(await this.ctx.storage.listRecordings({}), 'user-all')
    this.sweepOrphans(new Set(), 0)
  }

  private removeFile(noteId: string, id: string): void {
    try {
      rmSync(this.pathOf(noteId, id), { force: true })
    } catch (err) {
      // The key is gone with the row; the next sweep retries the file.
      log('warn', 'recordings:file-delete-failed', { recordingId: id, err })
    }
    removeIfEmpty(join(this.root, noteId))
  }

  // ---------- retention ----------

  /** Retention, then orphan files. Also run after a retention change. */
  async sweep(why: 'startup' | 'timer' | 'setting'): Promise<void> {
    try {
      const retention = await this.ctx.settings.get('audio.retention')
      if (retention !== 'note') {
        const days = RETENTION_DAYS[retention] ?? 7
        const endedBefore = new Date(devNow() - days * DAY_MS).toISOString()
        const old = await this.ctx.storage.listRecordings({ endedBefore })
        if (old.length) await this.deleteRows(old, `retention-${retention}`)
      }
      const known = new Set((await this.ctx.storage.listRecordings({})).map((r) => `${r.note_id}/${r.id}`))
      this.sweepOrphans(known, ORPHAN_MIN_AGE_MS)
      log('debug', 'recordings:sweep', { why, retention })
    } catch (err) {
      log('warn', 'recordings:sweep-failed', { why, err })
    }
  }

  /** Files without a row (their note was purged, or a delete's file removal failed). */
  private sweepOrphans(known: Set<string>, minAgeMs: number): void {
    let notes: string[] = []
    try {
      notes = readdirSync(this.root)
    } catch {
      return
    }
    const live = new Set([...this.live.values()].map((f) => `${f.noteId}/${f.id}`))
    const cutoff = Date.now() - minAgeMs
    let removed = 0
    for (const noteId of notes) {
      const dir = join(this.root, noteId)
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!FILE_NAME.test(name)) continue
        const key = `${noteId}/${name.slice(0, -'.naud'.length)}`
        if (known.has(key) || live.has(key)) continue
        const path = join(dir, name)
        try {
          if (statSync(path).mtimeMs > cutoff) continue
          rmSync(path, { force: true })
          removed++
        } catch {
          // Next sweep.
        }
      }
      removeIfEmpty(dir)
    }
    if (removed) log('info', 'recordings:orphans-removed', { files: removed })
  }

  /**
   * After a crash: each interrupted recording's size and duration, from the complete frames
   * on disk (only the frame lengths are read; nothing is decrypted).
   */
  private async recountIncomplete(): Promise<void> {
    const rows = await this.ctx.storage.listRecordings({ states: ['incomplete'] })
    for (const r of rows) {
      const path = this.pathOf(r.note_id, r.id)
      if (!existsSync(path)) continue
      try {
        const { fileBytes, plainBytes } = await scanFrames(path)
        await this.ctx.storage.updateRecording(r.id, { bytes: fileBytes, duration_ms: Math.round(plainBytes / BYTES_PER_MS) })
      } catch (err) {
        log('warn', 'recordings:recount-failed', { recordingId: r.id, err })
      }
    }
  }

  // ---------- export ----------

  /**
   * One standard WAV per recording into `folder`: `<note title> – Me.wav` / `– Them.wav`,
   * with a session suffix when the note has several sessions. Never overwrites.
   */
  async exportNote(noteId: string, folder: string, title: string): Promise<string[]> {
    // A recording still being written exports the frames written so far.
    const rows = await this.ctx.storage.listRecordings({ noteId })
    const sessions = [...new Set(rows.map((r) => r.session_id))]
    const base = safeFileName(title)
    const out: string[] = []
    for (const r of rows) {
      const who = r.source === 'microphone' ? 'Me' : 'Them'
      const suffix = sessions.length > 1 ? ` – Session ${sessions.indexOf(r.session_id) + 1}` : ''
      const target = freeName(folder, `${base} – ${who}${suffix}`, '.wav')
      const key = Buffer.from(r.file_key)
      try {
        await framedToWav({ path: this.pathOf(r.note_id, r.id), key, id: r.id, allowTruncated: r.state !== 'complete' }, target)
        out.push(target)
      } catch (err) {
        log('warn', 'recordings:export-failed', { recordingId: r.id, err })
      } finally {
        key.fill(0)
      }
    }
    log('info', 'recordings:exported', { noteId, files: out.length, of: rows.length })
    return out
  }
}

/**
 * The sweep's "now". Dev builds only: `NOTULA_DEV_CLOCK_OFFSET_MS` moves it forward, so a
 * retention can be checked without waiting a day.
 */
function devNow(): number {
  const raw = !app.isPackaged ? Number(process.env['NOTULA_DEV_CLOCK_OFFSET_MS'] ?? 0) : 0
  return Date.now() + (Number.isFinite(raw) ? raw : 0)
}

function info(r: RecordingRow): RecordingInfo {
  return {
    id: r.id,
    note_id: r.note_id,
    session_id: r.session_id,
    source: r.source,
    started_at: r.started_at,
    ended_at: r.ended_at,
    duration_ms: r.duration_ms,
    bytes: r.bytes,
    state: r.state
  }
}

/** Walks an NAU1 file's frame lengths: the complete frames' file and plaintext sizes. */
async function scanFrames(path: string): Promise<{ fileBytes: number; plainBytes: number }> {
  const h = await open(path, 'r')
  try {
    const size = (await h.stat()).size
    let position = NAU1_HEADER
    let plainBytes = 0
    const lead = Buffer.alloc(16)
    while (position + 16 <= size) {
      const { bytesRead } = await h.read(lead, 0, 16, position)
      if (bytesRead < 16) break
      const ct = lead.readUInt32LE(12)
      if (ct > RECORDING_LIMITS.frameBytes || position + FRAME_OVERHEAD + ct > size) break
      position += FRAME_OVERHEAD + ct
      plainBytes += ct
    }
    return { fileBytes: Math.min(size, position), plainBytes }
  } finally {
    await h.close()
  }
}

/** A file-system-safe base name from a note title. */
export function safeFileName(title: string): string {
  const cleaned = title
    // eslint-disable-next-line no-control-regex
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
    .slice(0, MAX_TITLE_CHARS)
    .trim()
  return cleaned || 'Untitled meeting'
}

/** `<dir>/<base><ext>`, or `<base> (2)<ext>`… when taken. */
function freeName(dir: string, base: string, ext: string): string {
  let candidate = join(dir, `${base}${ext}`)
  for (let n = 2; existsSync(candidate) && n < 1000; n++) candidate = join(dir, `${base} (${n})${ext}`)
  return candidate
}

function removeIfEmpty(dir: string): void {
  try {
    if (!readdirSync(dir).length) rmdirSync(dir)
  } catch {
    // Not there, or not empty.
  }
}

let service: RecordingsService | null = null

/** The app-wide service; created by whichever module needs it first (the transcription manager or registerRecordings). */
export function getRecordings(ctx: MainContext): RecordingsService {
  if (!service) service = new RecordingsService(ctx)
  return service
}
