// SPDX-License-Identifier: Apache-2.0
// The live transcript store. Main owns it:
// results are merged into per-note chunk maps, persisted through StorageApi by a
// write-behind of at most 500 ms, and pushed to renderers as `transcript:changed`
// coalesced per 100 ms (plus the bus event for other main modules).

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
}

export class ChunkStore {
  private readonly notes = new Map<string, NoteState>()

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
        lastWriteOk: true
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

  /** Persisted rows merged with the live chunks, sorted (`transcript:get`). */
  async getTranscript(noteId: string): Promise<TranscriptChunk[]> {
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
    for (const c of n?.live.values() ?? []) merged.set(c.id, c)
    return [...merged.values()].sort(compareChunks)
  }

  liveChunks(noteId: string): TranscriptChunk[] {
    return [...(this.notes.get(noteId)?.live.values() ?? [])].sort(compareChunks)
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

  /** Drops the in-memory copy once everything reached storage. Kept otherwise. */
  release(noteId: string): void {
    const n = this.notes.get(noteId)
    if (!n || n.dirty.size || !n.lastWriteOk) return
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
    const p: TranscriptChanged = {
      noteId,
      upserted: [...n.pushUpserts.values()],
      removedIds: [...n.pushRemoved]
    }
    n.pushUpserts.clear()
    n.pushRemoved.clear()
    for (const wc of this.ctx.windows.targets()) wc.send('transcript:changed' satisfies PushChannel, p)
    this.ctx.bus.emit('transcript:changed', p)
  }

  private async write(n: NoteState, noteId: string): Promise<void> {
    if (!n.dirty.size) return
    const ids = [...n.dirty]
    const rows: TranscriptChunk[] = []
    for (const id of ids) {
      const live = n.live.get(id)
      if (live) rows.push(live)
      else {
        const gone = n.retracted.get(id)
        if (gone && n.persisted.has(id)) rows.push({ ...gone, text: DELETED_CHUNK_MARKER, is_final: true })
      }
    }
    n.dirty.clear()
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
