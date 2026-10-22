// SPDX-License-Identifier: Apache-2.0
// Kept meeting audio: `recordings`.
// Main writes the encrypted `.naud` files (NAU1) with the per-file key it
// gets back from `createRecording`; the key stays in this encrypted database and goes
// with its row (crypto-shredding). The `recordings_ad` trigger queues the file in
// `file_deletions` as `rel:audio/<note_id>/<id>.naud` whenever a row goes, by any path:
// the user's delete, the retention sweep, or the note's permanent delete (FK cascade).

import type { IsoTime } from '@shared/types/common'
import type { RecordingInfo, RecordingState, RecordingsUsage } from '@shared/types/recordings'
import type { NewRecording, RecordingRow } from './api'
import { nowIso, toBuffer } from './rows'
import { inTransaction, invalid, notFound, type StoreCtx } from './store'

const COLS = 'id, note_id, session_id, source, started_at, ended_at, duration_ms, bytes, state, file_key'
const STATES: readonly RecordingState[] = ['recording', 'complete', 'incomplete']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO = /^\d{4}-\d{2}-\d{2}T/
const MAX_IDS = 10_000

function toRecording(r: Record<string, unknown>): RecordingRow {
  const key = r['file_key']
  return {
    id: String(r['id']),
    note_id: String(r['note_id']),
    session_id: String(r['session_id']),
    source: r['source'] === 'system' ? 'system' : 'microphone',
    started_at: String(r['started_at']),
    ended_at: typeof r['ended_at'] === 'string' ? r['ended_at'] : null,
    duration_ms: Number(r['duration_ms'] ?? 0),
    bytes: Number(r['bytes'] ?? 0),
    state: STATES.includes(r['state'] as RecordingState) ? (r['state'] as RecordingState) : 'incomplete',
    file_key: key instanceof Uint8Array ? key : new Uint8Array(0)
  }
}

/** The row without its key (what the renderer may see). */
export function recordingInfo(r: RecordingRow): RecordingInfo {
  const { file_key: _key, ...info } = r
  return info
}

export function createRecording(s: StoreCtx, r: NewRecording): RecordingRow {
  if (!r || typeof r.id !== 'string' || !UUID.test(r.id)) throw invalid('recording id must be a UUID')
  if (typeof r.note_id !== 'string' || !r.note_id) throw invalid('note_id is required')
  if (typeof r.session_id !== 'string' || !r.session_id) throw invalid('session_id is required')
  if (r.source !== 'microphone' && r.source !== 'system') throw invalid('source must be microphone or system')
  if (typeof r.started_at !== 'string' || !ISO.test(r.started_at)) throw invalid('started_at must be an ISO time')
  if (!(r.file_key instanceof Uint8Array) || r.file_key.byteLength !== 32) throw invalid('file_key must be 32 bytes')
  if (!s.db.prepare(`SELECT 1 FROM documents WHERE id = ?`).get(r.note_id)) throw notFound('note', r.note_id)
  s.db
    .prepare(
      `INSERT INTO recordings (id, workspace_id, owner_id, note_id, session_id, source, started_at, ended_at,
         duration_ms, bytes, state, file_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 0, 0, 'recording', ?)`
    )
    .run(r.id, s.identity.workspaceId, s.identity.ownerId, r.note_id, r.session_id, r.source, r.started_at, toBuffer(r.file_key))
  s.touch('recordings', r.id, r.note_id)
  const row = s.db.prepare(`SELECT ${COLS} FROM recordings WHERE id = ?`).get(r.id) as Record<string, unknown>
  return toRecording(row)
}

export function updateRecording(
  s: StoreCtx,
  id: string,
  patch: { ended_at?: IsoTime | null; duration_ms?: number; bytes?: number; state?: RecordingState }
): void {
  if (typeof id !== 'string' || !id) throw invalid('id is required')
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch?.ended_at !== undefined) {
    if (patch.ended_at !== null && (typeof patch.ended_at !== 'string' || !ISO.test(patch.ended_at))) throw invalid('ended_at must be an ISO time')
    sets.push('ended_at = ?')
    vals.push(patch.ended_at)
  }
  for (const k of ['duration_ms', 'bytes'] as const) {
    const v = patch?.[k]
    if (v === undefined) continue
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw invalid(`${k} must be a non-negative number`)
    sets.push(`${k} = ?`)
    vals.push(Math.round(v))
  }
  if (patch?.state !== undefined) {
    if (!STATES.includes(patch.state)) throw invalid('unknown recording state')
    sets.push('state = ?')
    vals.push(patch.state)
  }
  if (!sets.length) return
  const row = s.db.prepare(`SELECT note_id FROM recordings WHERE id = ?`).get(id) as { note_id: string } | undefined
  // A recording whose note was deleted meanwhile is gone: nothing to update.
  if (!row) return
  s.db.prepare(`UPDATE recordings SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  s.touch('recordings', id, row.note_id)
}

export function listRecordings(s: StoreCtx, q: { noteId?: string; endedBefore?: IsoTime; states?: RecordingState[] }): RecordingRow[] {
  const where: string[] = []
  const vals: unknown[] = []
  if (q?.noteId !== undefined) {
    if (typeof q.noteId !== 'string' || !q.noteId) throw invalid('noteId must be a string')
    where.push('note_id = ?')
    vals.push(q.noteId)
  }
  if (q?.endedBefore !== undefined) {
    if (typeof q.endedBefore !== 'string' || !ISO.test(q.endedBefore)) throw invalid('endedBefore must be an ISO time')
    where.push('ended_at IS NOT NULL AND ended_at < ?')
    vals.push(q.endedBefore)
  }
  if (q?.states !== undefined) {
    if (!Array.isArray(q.states) || q.states.some((st) => !STATES.includes(st))) throw invalid('unknown recording state')
    if (!q.states.length) return []
    where.push(`state IN (${q.states.map(() => '?').join(', ')})`)
    vals.push(...q.states)
  }
  const rows = s.db
    .prepare(
      `SELECT ${COLS} FROM recordings ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY started_at ASC, source ASC, id ASC`
    )
    .all(...vals) as Record<string, unknown>[]
  return rows.map(toRecording)
}

/** Deletes the rows (and so their keys); the trigger queues their files. */
export function deleteRecordings(s: StoreCtx, ids: string[]): { deleted: string[] } {
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw invalid('ids must be strings')
  if (ids.length > MAX_IDS) throw invalid('too many ids')
  const deleted: string[] = []
  const notes = new Set<string>()
  inTransaction(s.db, () => {
    const find = s.db.prepare(`SELECT note_id FROM recordings WHERE id = ?`)
    const del = s.db.prepare(`DELETE FROM recordings WHERE id = ?`)
    for (const id of new Set(ids)) {
      const row = find.get(id) as { note_id: string } | undefined
      if (!row) continue
      del.run(id)
      deleted.push(id)
      notes.add(row.note_id)
    }
  })
  if (deleted.length) s.touch('recordings', ...deleted, ...notes)
  return { deleted }
}

export function recordingsUsage(s: StoreCtx): RecordingsUsage {
  const r = s.db.prepare(`SELECT count(*) AS n, coalesce(sum(bytes), 0) AS b FROM recordings`).get() as { n: number; b: number }
  return { totalBytes: Number(r.b), count: Number(r.n) }
}

/**
 * At startup: a recording still `recording` was cut off by a crash or a kill. It becomes
 * `incomplete`, with `ended_at` set so the retention sweep can age it; its complete
 * frames stay readable.
 */
export function markInterruptedRecordings(s: StoreCtx): number {
  const now = nowIso()
  const rows = s.db.prepare(`SELECT id, note_id FROM recordings WHERE state = 'recording'`).all() as { id: string; note_id: string }[]
  if (!rows.length) return 0
  inTransaction(s.db, () => {
    s.db
      .prepare(`UPDATE recordings SET state = 'incomplete', ended_at = coalesce(ended_at, ?) WHERE state = 'recording'`)
      .run(now)
  })
  s.touch('recordings', ...rows.map((r) => r.id), ...new Set(rows.map((r) => r.note_id)))
  return rows.length
}
