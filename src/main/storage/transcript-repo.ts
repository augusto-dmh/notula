// SPDX-License-Identifier: Apache-2.0
// `transcript_chunks` and `transcription_sessions`, kept in the single storage layer
// beside the notes rather than in a separate cache.

import type { IsoTime } from '@shared/types/common'
import type { TranscriptChunk } from '@shared/types/transcript'
import type { NewTranscriptionSession, TranscriptionSession } from './api'
import { nowIso, toChunk, toJson, toSession } from './rows'
import { inTransaction, invalid, type StoreCtx } from './store'

const CHUNK_COLS = [
  'id',
  'document_id',
  'workspace_id',
  'owner_id',
  'transcription_session_id',
  'source',
  'start_timestamp',
  'end_timestamp',
  'text',
  'is_final',
  'detected_speaker_name',
  'detected_speaker',
  'provider_details'
].join(', ')

/**
 * Sorted in merge order: start, end, id. Leaves out the chunks of a source note's superseded
 * sessions (`note_sources.superseded_session_ids`): they are kept but hidden from
 * every reader of the transcript, prompts included. A note without a source,
 * every meeting, gets exactly the rows it got before.
 */
export function getTranscript(s: StoreCtx, noteId: string): TranscriptChunk[] {
  const rows = s.db
    .prepare(
      `SELECT ${CHUNK_COLS} FROM transcript_chunks WHERE document_id = ?
       ORDER BY start_timestamp ASC, end_timestamp ASC, id ASC`
    )
    .all(noteId) as Record<string, unknown>[]
  const hidden = supersededSessions(s, noteId)
  return (hidden.size ? rows.filter((r) => !hidden.has(r['transcription_session_id'] as string)) : rows).map(toChunk)
}

/** The note's superseded session ids; empty without a source. */
function supersededSessions(s: StoreCtx, noteId: string): Set<string> {
  const row = s.db.prepare(`SELECT superseded_session_ids AS ids FROM note_sources WHERE note_id = ?`).get(noteId) as { ids?: unknown } | undefined
  if (!row || typeof row.ids !== 'string' || row.ids === '[]') return new Set()
  try {
    const ids: unknown = JSON.parse(row.ids)
    return new Set(Array.isArray(ids) ? ids.filter((x): x is string => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

export function upsertChunks(s: StoreCtx, chunks: TranscriptChunk[]): void {
  if (!Array.isArray(chunks)) throw invalid('chunks must be an array')
  if (chunks.length === 0) return
  const now = nowIso()
  const stmt = s.db.prepare(
    `INSERT INTO transcript_chunks (${CHUNK_COLS}, created_at, updated_at)
     VALUES (@id, @document_id, @workspace_id, @owner_id, @transcription_session_id, @source,
       @start_timestamp, @end_timestamp, @text, @is_final, @detected_speaker_name, @detected_speaker,
       @provider_details, @now, @now)
     ON CONFLICT (id) DO UPDATE SET
       document_id = excluded.document_id,
       transcription_session_id = excluded.transcription_session_id,
       source = excluded.source,
       start_timestamp = excluded.start_timestamp,
       end_timestamp = excluded.end_timestamp,
       text = excluded.text,
       is_final = excluded.is_final,
       detected_speaker_name = excluded.detected_speaker_name,
       detected_speaker = excluded.detected_speaker,
       provider_details = excluded.provider_details,
       updated_at = excluded.updated_at`
  )
  const docs = new Set<string>()
  // A row for a note that no longer exists is dropped: a diarization pass that
  // read the chunks before a permanent delete must not write the transcript back. Notes
  // are always created before their first chunk; a trashed note still has its row.
  const exists = s.db.prepare(`SELECT 1 FROM documents WHERE id = ?`)
  const known = new Map<string, boolean>()
  let dropped = 0
  inTransaction(s.db, () => {
    for (const c of chunks) {
      let live = known.get(c.document_id)
      if (live === undefined) {
        live = exists.get(c.document_id) !== undefined
        known.set(c.document_id, live)
      }
      if (!live) {
        dropped++
        continue
      }
      stmt.run({
        id: c.id,
        document_id: c.document_id,
        workspace_id: c.workspace_id || s.identity.workspaceId,
        owner_id: c.owner_id || s.identity.ownerId,
        transcription_session_id: c.transcription_session_id,
        source: c.source,
        start_timestamp: c.start_timestamp,
        end_timestamp: c.end_timestamp,
        text: c.text ?? '',
        is_final: c.is_final ? 1 : 0,
        detected_speaker_name: c.detected_speaker_name ?? null,
        detected_speaker: toJson(c.detectedSpeaker) ?? null,
        provider_details: toJson(c.providerDetails) ?? null,
        now
      })
      docs.add(c.document_id)
    }
  })
  if (dropped) s.log('warn', 'transcript:chunks-for-missing-note-dropped', { count: dropped })
  if (docs.size) s.touch('transcript_chunks', ...docs)
}

export function createSession(s: StoreCtx, x: NewTranscriptionSession): void {
  inTransaction(s.db, () =>
    s.db
      .prepare(
        `INSERT INTO transcription_sessions (id, document_id, workspace_id, owner_id, provider, model, language, started_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        x.id,
        x.document_id,
        s.identity.workspaceId,
        s.identity.ownerId,
        x.provider,
        x.model,
        x.language,
        x.started_at
      )
  )
  s.touch('transcription_sessions', x.id, x.document_id)
}

export function endSession(s: StoreCtx, id: string, endedAt: IsoTime, endReason: string): void {
  const row = inTransaction(
    s.db,
    () =>
      s.db
        .prepare(`UPDATE transcription_sessions SET ended_at = ?, end_reason = ? WHERE id = ? RETURNING document_id`)
        .get(endedAt, endReason, id) as { document_id: string } | undefined
  )
  if (row) s.touch('transcription_sessions', id, row.document_id)
}

export function latestSession(s: StoreCtx, noteId: string): TranscriptionSession | null {
  const row = s.db
    .prepare(`SELECT * FROM transcription_sessions WHERE document_id = ? ORDER BY started_at DESC, id DESC LIMIT 1`)
    .get(noteId) as Record<string, unknown> | undefined
  return row ? toSession(row) : null
}

/** Startup housekeeping: leftover partials become final. */
export function finalizePartialChunks(s: StoreCtx): number {
  const docs = inTransaction(s.db, () =>
    (
      s.db
        .prepare(`UPDATE transcript_chunks SET is_final = 1, updated_at = ? WHERE is_final = 0 RETURNING document_id`)
        .all(nowIso()) as { document_id: string }[]
    ).map((r) => r.document_id)
  )
  if (docs.length) s.touch('transcript_chunks', ...new Set(docs))
  return docs.length
}
