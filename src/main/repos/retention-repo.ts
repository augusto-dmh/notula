// SPDX-License-Identifier: Apache-2.0
// Retention: the storage-worker side of its StorageApi group. Worker-safe: no Electron imports.
//
// Age: a note's transcript is as old as its last section (`MAX(end_timestamp)`), so a
// resumed meeting is kept whole. Rows with an unparsable or future last section are skipped.
//
// One transaction per note: its transcript sections, speaker-name suggestions, transcript reports
// and recordings (the `recordings_ad` trigger queues their files) go; so do its speaker cluster
// vectors (secure-deleted), negatives, match rows and pending requests, by hand, because the
// `documents` row stays and no cascade fires. Its full-text rows are
// re-queued; its kept per-note temp audio is queued for deletion; `transcript_purged_at` is set.
// The note, its summaries, action items, chats, attachments and the voice profiles are kept. Files
// are deleted after commit (storage's `processFileDeletions`); a failed file delete is retried next run.

import { isAbsolute, relative, resolve } from 'node:path'
import type { IsoTime } from '@shared/types/common'
import { RETENTION_LIMITS, type RetentionHours, type RetentionPreview, type RetentionRun } from '@shared/types/retention'
import { nowIso, parseJson } from '../storage/rows'
import { checkpointVoice, deleteNoteVoiceRows, secureWrite } from '../storage/speaker-voice-repo'
import { inTransaction, invalid, type StoreCtx } from '../storage/store'
import { processFileDeletions } from '../storage/trash-repo'

type Row = Record<string, unknown>

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/
const HOURS: readonly RetentionHours[] = [24, 168, 720, 2160, 4320, 8760]

interface Candidate {
  id: string
  last: string
}

function validIso(v: unknown): v is IsoTime {
  return typeof v === 'string' && ISO.test(v) && Number.isFinite(Date.parse(v))
}

/** Notes with a transcript whose last section ended before `olderThan` (and not in the future). */
function candidates(s: StoreCtx, olderThan: IsoTime, skip: string[], limit: number | null): Candidate[] {
  const cutoff = Date.parse(olderThan)
  const now = Date.now()
  const rows = s.db
    .prepare(
      `SELECT c.document_id AS id, MAX(c.end_timestamp) AS last
       FROM transcript_chunks c JOIN documents d ON d.id = c.document_id
       WHERE d.owner_id = @owner AND d.workspace_id = @ws
         AND c.document_id NOT IN (SELECT value FROM json_each(@skip))
       GROUP BY c.document_id
       HAVING last < @olderThan
       ORDER BY last`
    )
    .all({ owner: s.identity.ownerId, ws: s.identity.workspaceId, skip: JSON.stringify(skip), olderThan }) as Row[]
  const out: Candidate[] = []
  for (const r of rows) {
    const last = r['last']
    // String order pre-filters; the parsed time decides (and drops unparsable or future rows).
    if (!validIso(last)) continue
    const t = Date.parse(last)
    if (t >= cutoff || t > now) continue
    out.push({ id: String(r['id']), last })
    if (limit !== null && out.length >= limit) break
  }
  return out
}

function checkQuery(q: { olderThan: IsoTime; skipNoteIds: string[] }): string[] {
  if (!q || !validIso(q.olderThan)) throw invalid('olderThan must be an ISO time')
  return Array.isArray(q.skipNoteIds) ? q.skipNoteIds.filter((i): i is string => typeof i === 'string') : []
}

export function previewRetention(s: StoreCtx, q: { olderThan: IsoTime; skipNoteIds: string[] }): RetentionPreview {
  const skip = checkQuery(q)
  const found = candidates(s, q.olderThan, skip, null)
  const ids = JSON.stringify(found.map((c) => c.id))
  const recordings = (
    s.db.prepare(`SELECT count(*) AS n FROM recordings WHERE note_id IN (SELECT value FROM json_each(?))`).get(ids) as { n: number }
  ).n
  return {
    notes: found.length,
    recordings,
    oldest: found.length ? found[0]!.last : null,
    newest: found.length ? found[found.length - 1]!.last : null,
    // Main sets the real effective time; the worker only counts.
    effectiveAt: q.olderThan
  }
}

/** `<tmpDir>/<noteId>`, or null when the id cannot name a folder inside `tmpDir`. */
function noteTmpPath(s: StoreCtx, noteId: string): string | null {
  const path = resolve(s.tmpDir, noteId)
  const rel = relative(resolve(s.tmpDir), path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? path : null
}

function purgeNote(s: StoreCtx, noteId: string, at: IsoTime): { sections: number; recordings: number; bytes: number; vectors: number } {
  return secureWrite(s, () => {
    const rec = s.db.prepare(`SELECT count(*) AS n, COALESCE(SUM(bytes), 0) AS b FROM recordings WHERE note_id = ?`).get(noteId) as {
      n: number
      b: number
    }
    const sections = s.db.prepare(`DELETE FROM transcript_chunks WHERE document_id = ?`).run(noteId).changes
    s.db.prepare(`DELETE FROM speaker_guesses WHERE document_id = ?`).run(noteId)
    const vectors = deleteNoteVoiceRows(s, noteId).vectors
    s.db.prepare(`DELETE FROM speaker_negatives WHERE note_id = ?`).run(noteId)
    s.db.prepare(`DELETE FROM speaker_matches WHERE note_id = ?`).run(noteId)
    s.db.prepare(`DELETE FROM transcript_reports WHERE note_id = ?`).run(noteId)
    // The recordings_ad trigger queues each file in file_deletions.
    s.db.prepare(`DELETE FROM recordings WHERE note_id = ?`).run(noteId)
    const tmp = noteTmpPath(s, noteId)
    if (tmp) {
      s.db
        .prepare(`INSERT INTO file_deletions (path, reason, queued_at) VALUES (?, 'transcript-retention', ?) ON CONFLICT (path) DO NOTHING`)
        .run(tmp, at)
    }
    // The indexer re-reads the note, whatever the FTS layout holds for it.
    s.db.prepare(`INSERT OR REPLACE INTO fts_queue (kind, row_id, queued_at) VALUES ('document', ?, ?)`).run(noteId, at)
    s.db.prepare(`UPDATE documents SET transcript_purged_at = ? WHERE id = ?`).run(at, noteId)
    return { sections, recordings: rec.n, bytes: rec.b, vectors }
  })
}

export function purgeTranscripts(
  s: StoreCtx,
  q: { olderThan: IsoTime; skipNoteIds: string[]; batch: number }
): { notes: number; sections: number; recordings: number; bytes: number; noteIds: string[]; errors: string[]; more: boolean } {
  const skip = checkQuery(q)
  const batch = Math.max(1, Math.min(RETENTION_LIMITS.batchNotes, Math.floor(Number(q.batch) || RETENTION_LIMITS.batchNotes)))
  const failed = new Set<string>()
  const found = candidates(s, q.olderThan, skip, batch + 1)
  const more = found.length > batch
  const out = { notes: 0, sections: 0, recordings: 0, bytes: 0, noteIds: [] as string[], errors: [] as string[], more }
  const at = nowIso()
  let vectors = 0
  for (const c of found.slice(0, batch)) {
    try {
      const r = purgeNote(s, c.id, at)
      out.notes += 1
      out.sections += r.sections
      out.recordings += r.recordings
      out.bytes += r.bytes
      vectors += r.vectors
      out.noteIds.push(c.id)
      s.touch('transcript_chunks', c.id)
      s.touch('documents', c.id)
      if (r.recordings) s.touch('recordings', c.id)
    } catch (err) {
      failed.add(c.id)
      out.errors.push(`${c.id}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (vectors) checkpointVoice(s)
  if (out.notes) for (const t of ['speaker_cluster_vectors', 'speaker_negatives', 'speaker_matches', 'speaker_pending']) s.touch(t, ...out.noteIds)
  // A note that failed would be selected again at once; the next run retries it.
  if (failed.size && out.notes === 0) out.more = false
  try {
    processFileDeletions(s)
  } catch (err) {
    out.errors.push(`files: ${err instanceof Error ? err.message : String(err)}`)
  }
  s.log('info', 'retention:batch', { notes: out.notes, sections: out.sections, recordings: out.recordings, errors: out.errors.length })
  return out
}

function toRun(r: Row): RetentionRun {
  const hours = Number(r['period_hours'])
  return {
    id: String(r['id']),
    ran_at: String(r['ran_at']),
    period_hours: (HOURS.includes(hours as RetentionHours) ? hours : 720) as RetentionHours,
    notes: Number(r['notes'] ?? 0),
    sections: Number(r['sections'] ?? 0),
    recordings: Number(r['recordings'] ?? 0),
    bytes_freed: Number(r['bytes_freed'] ?? 0),
    note_ids: parseJson<string[]>(r['note_ids'], []),
    errors: parseJson<string[]>(r['errors'], []),
    trigger: r['trigger'] === 'daily' ? 'daily' : 'startup'
  }
}

export function recordRetentionRun(s: StoreCtx, r: RetentionRun): void {
  if (!r || typeof r.id !== 'string' || !r.id || !validIso(r.ran_at) || !HOURS.includes(r.period_hours)) throw invalid('invalid retention run')
  s.db
    .prepare(
      `INSERT INTO retention_runs (id, workspace_id, owner_id, ran_at, period_hours, notes, sections, recordings, bytes_freed, note_ids, errors, "trigger")
       VALUES (@id, @ws, @owner, @ranAt, @hours, @notes, @sections, @recordings, @bytes, @noteIds, @errors, @trigger)`
    )
    .run({
      id: r.id,
      ws: s.identity.workspaceId,
      owner: s.identity.ownerId,
      ranAt: r.ran_at,
      hours: r.period_hours,
      notes: Math.max(0, Math.floor(r.notes) || 0),
      sections: Math.max(0, Math.floor(r.sections) || 0),
      recordings: Math.max(0, Math.floor(r.recordings) || 0),
      bytes: Math.max(0, Math.floor(r.bytes_freed) || 0),
      noteIds: JSON.stringify(Array.isArray(r.note_ids) ? r.note_ids : []),
      errors: JSON.stringify(Array.isArray(r.errors) ? r.errors.slice(0, 50) : []),
      trigger: r.trigger === 'daily' ? 'daily' : 'startup'
    })
  s.touch('retention_runs', r.id)
}

export function listRetentionRuns(s: StoreCtx, limit: number): RetentionRun[] {
  const n = Math.max(1, Math.min(200, Math.floor(Number(limit) || RETENTION_LIMITS.logRuns)))
  const rows = s.db
    .prepare(`SELECT * FROM retention_runs WHERE owner_id = ? AND workspace_id = ? ORDER BY ran_at DESC, rid DESC LIMIT ?`)
    .all(s.identity.ownerId, s.identity.workspaceId, n) as Row[]
  return rows.map(toRun)
}

export function deleteTranscriptSections(s: StoreCtx, noteId: string, chunkIds: string[]): { deleted: number } {
  if (typeof noteId !== 'string' || !noteId) throw invalid('noteId is required')
  const ids = Array.isArray(chunkIds) ? [...new Set(chunkIds.filter((i): i is string => typeof i === 'string' && i !== ''))] : []
  if (!ids.length) throw invalid('Select at least one transcript section.')
  if (ids.length > RETENTION_LIMITS.sectionDeleteMax) {
    throw invalid(`You can delete up to ${RETENTION_LIMITS.sectionDeleteMax} sections at a time. You selected ${ids.length}.`)
  }
  const at = nowIso()
  const deleted = inTransaction(s.db, () => {
    const doc = s.db.prepare(`SELECT 1 FROM documents WHERE id = ? AND owner_id = ?`).get(noteId, s.identity.ownerId)
    if (!doc) throw invalid(`note ${noteId} not found`)
    const n = s.db
      .prepare(`DELETE FROM transcript_chunks WHERE document_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .run(noteId, JSON.stringify(ids)).changes
    if (n) s.db.prepare(`INSERT OR REPLACE INTO fts_queue (kind, row_id, queued_at) VALUES ('document', ?, ?)`).run(noteId, at)
    return n
  })
  if (deleted) {
    s.touch('transcript_chunks', noteId)
    s.touch('documents', noteId)
  }
  s.log('info', 'retention:sections-deleted', { noteId, deleted })
  return { deleted }
}
