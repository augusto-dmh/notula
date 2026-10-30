// SPDX-License-Identifier: Apache-2.0
// The live transcript store. Main owns it:
// results are merged into per-note chunk maps, persisted through StorageApi by a
// write-behind of at most 500 ms, and pushed to renderers as `transcript:changed`
// coalesced per 100 ms (plus the bus event for other main modules).
//
// The off-the-record hold: while a note is held, its chunks ending at or after the hold start
// stay in memory only. They are not written, not on the bus and not in `getTranscript` or
// `liveChunks`; renderer windows still get them, flagged `held: true`. Lifting the hold writes
// and publishes them as usual. A quit during a hold loses them, which errs toward privacy.

import type { PushChannel } from '@shared/ipc'
import { DELETED_CHUNK_MARKER, type TranscriptChanged, type TranscriptChunk } from '@shared/types/transcript'
import type { MainContext } from '../context'
import { log } from '../log'

const WRITE_BEHIND_MS = 500
const PUSH_COALESCE_MS = 100

/** The merge order: start time, then end time, then id. */
export function compareChunks(a: TranscriptChunk, b: TranscriptChunk): number {
  if (a.start_timestamp !== b.start_timestamp) return a.start_timestamp < b.start_timestamp ? -1 : 1
  if (a.end_timestamp !== b.end_timestamp) return a.end_timestamp < b.end_timestamp ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

interface NoteState {
  live: Map<string, TranscriptChunk>
  dirty: Set<string>
  persisted: Set<string>
  /** Retracted chunks (last state); persisted ones are rewritten with the deleted marker. */
  retracted: Map<string, TranscriptChunk>
  pushUpserts: Map<string, TranscriptChunk>
  pushRemoved: Set<string>
  writeTimer: NodeJS.Timeout | null
  pushTimer: NodeJS.Timeout | null
  writing: Promise<void>
  lastWriteOk: boolean
  /** The off-the-record hold start (epoch ms), or null. */
  holdFrom: number | null
}

export class ChunkStore {
  private readonly notes = new Map<string, NoteState>()
  /** Sessions erased by an off-the-record pause: their late results are dropped. */
  private readonly discarded = new Set<string>()

  constructor(private readonly ctx: MainContext) {}

  private note(noteId: string): NoteState {
    let n = this.notes.get(noteId)
    if (!n) {
      n = {
        live: new Map(),
        dirty: new Set(),
        persisted: new Set(),
        retracted: new Map(),
        pushUpserts: new Map(),
        pushRemoved: new Set(),
        writeTimer: null,
        pushTimer: null,
        writing: Promise.resolve(),
        lastWriteOk: true,
        holdFrom: null
      }
      this.notes.set(noteId, n)
    }
    return n
  }

  get(noteId: string, id: string): TranscriptChunk | undefined {
    return this.notes.get(noteId)?.live.get(id)
  }

  /** Upserts by id. A changed text drops stale provider details. */
  upsert(chunk: TranscriptChunk): void {
    if (this.discarded.has(chunk.transcription_session_id)) return
    const n = this.note(chunk.document_id)
    const prev = n.live.get(chunk.id)
    let next = prev ? { ...prev, ...chunk } : chunk
    if (prev && prev.text !== chunk.text && !chunk.providerDetails && next.providerDetails) {
      const { providerDetails: _stale, ...rest } = next
      next = rest
    }
    n.live.set(chunk.id, next)
    n.retracted.delete(chunk.id)
    this.touch(n, chunk.document_id, next)
  }

  /** A final with empty text finalizes the existing partial with the same id. */
  finalize(noteId: string, id: string): void {
    const n = this.notes.get(noteId)
    const prev = n?.live.get(id)
    if (!n || !prev || prev.is_final) return
    const next = { ...prev, is_final: true }
    n.live.set(id, next)
    this.touch(n, noteId, next)
  }

  /** Removes chunks (an old provider's partials on handoff). */
  retract(noteId: string, ids: string[]): void {
    const n = this.notes.get(noteId)
    if (!n || !ids.length) return
    for (const id of ids) {
      const prev = n.live.get(id)
      if (!prev) continue
      n.live.delete(id)
      n.retracted.set(id, prev)
      n.dirty.add(id)
      n.pushUpserts.delete(id)
      n.pushRemoved.add(id)
    }
    this.schedule(n, noteId)
  }

  /**
   * Persisted rows merged with the live chunks, sorted. Held chunks only with `includeHeld`
   * (`transcript:get`, for the renderer), flagged `held: true`.
   */
  async getTranscript(noteId: string, opts: { includeHeld?: boolean } = {}): Promise<TranscriptChunk[]> {
    let rows: TranscriptChunk[] = []
    try {
      rows = await this.ctx.storage.getTranscript(noteId)
    } catch (err) {
      log('warn', 'transcript:get-storage-failed', { noteId, err })
    }
    const n = this.notes.get(noteId)
    const merged = new Map<string, TranscriptChunk>()
    for (const r of rows) {
      if (n?.retracted.has(r.id)) continue
      merged.set(r.id, r)
    }
    for (const c of n?.live.values() ?? []) {
      if (!n || !isHeld(n, c)) merged.set(c.id, c)
      else if (opts.includeHeld) merged.set(c.id, { ...c, held: true })
    }
    return [...merged.values()].sort(compareChunks)
  }

  /** The live chunks, held ones left out. */
  liveChunks(noteId: string): TranscriptChunk[] {
    const n = this.notes.get(noteId)
    if (!n) return []
    return [...n.live.values()].filter((c) => !isHeld(n, c)).sort(compareChunks)
  }

  /** Non-final live chunks of one session and source. */
  partials(noteId: string, sessionId: string, source: TranscriptChunk['source']): TranscriptChunk[] {
    return [...(this.notes.get(noteId)?.live.values() ?? [])].filter(
      (c) => !c.is_final && c.transcription_session_id === sessionId && c.source === source
    )
  }

  /** Writes everything dirty for the note now, and pushes pending changes. */
  async flush(noteId: string): Promise<boolean> {
    const n = this.notes.get(noteId)
    if (!n) return true
    this.pushNow(n, noteId)
    if (n.writeTimer) clearTimeout(n.writeTimer)
    n.writeTimer = null
    n.writing = n.writing.then(() => this.write(n, noteId))
    await n.writing
    return n.lastWriteOk && n.dirty.size === 0
  }

  /**
   * Revised chunks of an earlier session: written through storage at once and pushed as
   * `transcript:changed`. A live copy is replaced too. Speaker and position fields are
   * revised only through the note's label-write queue (`speakers/label-queue.ts`), which
   * calls this with the chunks it patched inside its turn.
   */
  async publishRevisions(noteId: string, rows: TranscriptChunk[]): Promise<void> {
    if (!rows.length) return
    const n = this.notes.get(noteId)
    if (n) for (const r of rows) if (n.live.has(r.id)) n.live.set(r.id, r)
    await this.ctx.storage.upsertChunks(rows)
    if (n) for (const r of rows) n.persisted.add(r.id)
    const p: TranscriptChanged = { noteId, upserted: rows, removedIds: [] }
    for (const wc of this.ctx.windows.targets()) wc.send('transcript:changed' satisfies PushChannel, p)
    this.ctx.bus.emit('transcript:changed', p)
  }

  // ---------- the off-the-record hold ----------

  /** Holds the note's chunks ending at or after `fromMs`; an earlier start widens a running hold. */
  hold(noteId: string, fromMs: number): void {
    const n = this.note(noteId)
    if (n.holdFrom !== null && n.holdFrom <= fromMs) return
    n.holdFrom = fromMs
    // Windows that already have a chunk this hold covers get it again, flagged.
    for (const c of n.live.values()) if (isHeld(n, c)) n.pushUpserts.set(c.id, c)
    this.schedule(n, noteId)
  }

  /** Ends the hold: the held chunks are written and published as usual. */
  lift(noteId: string): void {
    const n = this.notes.get(noteId)
    if (!n || n.holdFrom === null) return
    const held = [...n.live.values()].filter((c) => isHeld(n, c))
    n.holdFrom = null
    for (const c of held) {
      n.dirty.add(c.id)
      n.pushRemoved.delete(c.id)
      n.pushUpserts.set(c.id, c)
    }
    this.schedule(n, noteId)
  }

  /** Drops every held chunk but `keepId`; the hold stays. */
  dropHeld(noteId: string, keepId: string): number {
    const n = this.notes.get(noteId)
    if (!n || n.holdFrom === null) return 0
    const ids = [...n.live.values()].filter((c) => c.id !== keepId && isHeld(n, c)).map((c) => c.id)
    this.retract(noteId, ids)
    return ids.length
  }

  /**
   * Deletes chunks, stored or live (rewritten with the deleted marker, without their words),
   * and puts `replacement` in place of its chunk. The caller flushes.
   */
  erase(noteId: string, chunks: readonly TranscriptChunk[], replacement: TranscriptChunk | null): void {
    const n = this.note(noteId)
    for (const c of chunks) {
      const prev = n.live.get(c.id) ?? c
      n.live.delete(c.id)
      const { providerDetails: _words, held: _held, ...rest } = prev
      n.retracted.set(c.id, { ...rest, detectedSpeaker: null })
      n.persisted.add(c.id)
      n.dirty.add(c.id)
      n.pushUpserts.delete(c.id)
      n.pushRemoved.add(c.id)
    }
    if (replacement) {
      n.live.set(replacement.id, replacement)
      n.retracted.delete(replacement.id)
      this.touch(n, noteId, replacement)
    } else {
      this.schedule(n, noteId)
    }
  }

  /** Results of this session that still arrive are dropped. */
  discardSession(sessionId: string): void {
    this.discarded.add(sessionId)
  }

  /** Drops the in-memory copy once everything reached storage. Kept otherwise. */
  release(noteId: string): void {
    const n = this.notes.get(noteId)
    if (!n || n.dirty.size || !n.lastWriteOk || n.holdFrom !== null) return
    if (n.writeTimer || n.pushTimer) return
    this.notes.delete(noteId)
  }

  private touch(n: NoteState, noteId: string, chunk: TranscriptChunk): void {
    n.dirty.add(chunk.id)
    n.pushRemoved.delete(chunk.id)
    n.pushUpserts.set(chunk.id, chunk)
    this.schedule(n, noteId)
  }

  private schedule(n: NoteState, noteId: string): void {
    if (!n.pushTimer) n.pushTimer = setTimeout(() => this.pushNow(n, noteId), PUSH_COALESCE_MS)
    if (!n.writeTimer) {
      n.writeTimer = setTimeout(() => {
        n.writeTimer = null
        n.writing = n.writing.then(() => this.write(n, noteId))
      }, WRITE_BEHIND_MS)
    }
  }

  private pushNow(n: NoteState, noteId: string): void {
    if (n.pushTimer) clearTimeout(n.pushTimer)
    n.pushTimer = null
    if (!n.pushUpserts.size && !n.pushRemoved.size) return
    const open: TranscriptChunk[] = []
    const held: TranscriptChunk[] = []
    for (const c of n.pushUpserts.values()) {
      if (isHeld(n, c)) held.push({ ...c, held: true })
      else open.push(c)
    }
    const removedIds = [...n.pushRemoved]
    n.pushUpserts.clear()
    n.pushRemoved.clear()
    const p: TranscriptChanged = { noteId, upserted: held.length ? [...open, ...held] : open, removedIds }
    for (const wc of this.ctx.windows.targets()) wc.send('transcript:changed' satisfies PushChannel, p)
    // Held chunks stay off the bus, so no summary, chat, export or other main reader sees them.
    if (!open.length && !removedIds.length) return
    this.ctx.bus.emit('transcript:changed', held.length ? { noteId, upserted: open, removedIds } : p)
  }

  private async write(n: NoteState, noteId: string): Promise<void> {
    if (!n.dirty.size) return
    const ids = [...n.dirty]
    const rows: TranscriptChunk[] = []
    const held: string[] = []
    for (const id of ids) {
      const live = n.live.get(id)
      if (live) {
        // A held chunk stays dirty, in memory only, until the hold lifts.
        if (isHeld(n, live)) held.push(id)
        else rows.push(live)
      } else {
        const gone = n.retracted.get(id)
        if (gone && n.persisted.has(id)) rows.push({ ...gone, text: DELETED_CHUNK_MARKER, is_final: true })
      }
    }
    n.dirty.clear()
    for (const id of held) n.dirty.add(id)
    if (!rows.length) return
    try {
      await this.ctx.storage.upsertChunks(rows)
      for (const r of rows) n.persisted.add(r.id)
      n.lastWriteOk = true
    } catch (err) {
      // Keep them dirty for the next write; the live copy stays visible meanwhile.
      for (const r of rows) n.dirty.add(r.id)
      if (n.lastWriteOk) log('warn', 'transcript:write-failed', { noteId, rows: rows.length, err })
      n.lastWriteOk = false
      if (!n.writeTimer) {
        n.writeTimer = setTimeout(() => {
          n.writeTimer = null
          n.writing = n.writing.then(() => this.write(n, noteId))
        }, 5_000)
      }
    }
  }
}

function isHeld(n: NoteState, c: TranscriptChunk): boolean {
  return n.holdFrom !== null && Date.parse(c.end_timestamp) >= n.holdFrom
}
