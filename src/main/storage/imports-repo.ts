// SPDX-License-Identifier: Apache-2.0
// Recording imports: `audio_imports`.
// A job outlives a deleted note (it then shows failed); `source_path` stays in
// main and never reaches the renderer.

import type { ImportEngine, ImportJob, ImportPhase } from '@shared/types/recordings'
import type { ImportJobRow } from './api'
import { nowIso } from './rows'
import { invalid, notFound, type StoreCtx } from './store'

const COLS = 'id, note_id, file_name, source_path, size_bytes, phase, error, engine, created_at, updated_at'
const PHASES: readonly ImportPhase[] = ['queued', 'creating', 'reading', 'transcribing', 'summarizing', 'complete', 'failed']
const ENGINES: readonly ImportEngine[] = ['deepgram', 'assemblyai', 'local']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Finished jobs kept for the progress toast after a restart; older ones are pruned. */
const KEEP_FINISHED = 50

function toRow(r: Record<string, unknown>): ImportJobRow {
  return {
    id: String(r['id']),
    note_id: typeof r['note_id'] === 'string' ? r['note_id'] : null,
    file_name: String(r['file_name']),
    source_path: String(r['source_path']),
    size_bytes: Number(r['size_bytes'] ?? 0),
    phase: PHASES.includes(r['phase'] as ImportPhase) ? (r['phase'] as ImportPhase) : 'failed',
    error: typeof r['error'] === 'string' ? r['error'] : null,
    engine: ENGINES.includes(r['engine'] as ImportEngine) ? (r['engine'] as ImportEngine) : null,
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at'])
  }
}

/** The job without its source path. */
export function importJob(r: ImportJobRow): ImportJob {
  const { source_path: _path, ...job } = r
  return job
}

function get(s: StoreCtx, id: string): ImportJobRow {
  const row = s.db.prepare(`SELECT ${COLS} FROM audio_imports WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  if (!row) throw notFound('import', id)
  return toRow(row)
}

export function createImportJob(s: StoreCtx, j: { id: string; file_name: string; source_path: string; size_bytes: number }): ImportJob {
  if (!j || typeof j.id !== 'string' || !UUID.test(j.id)) throw invalid('import id must be a UUID')
  if (typeof j.file_name !== 'string' || !j.file_name || j.file_name.length > 1_000) throw invalid('file_name is required')
  if (typeof j.source_path !== 'string' || !j.source_path || j.source_path.length > 4_000) throw invalid('source_path is required')
  if (typeof j.size_bytes !== 'number' || !Number.isFinite(j.size_bytes) || j.size_bytes < 0) throw invalid('size_bytes must be a number')
  const now = nowIso()
  s.db
    .prepare(
      `INSERT INTO audio_imports (id, workspace_id, owner_id, note_id, file_name, source_path, size_bytes, phase,
         error, engine, created_at, updated_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, 'queued', NULL, NULL, ?, ?)`
    )
    .run(j.id, s.identity.workspaceId, s.identity.ownerId, j.file_name, j.source_path, Math.round(j.size_bytes), now, now)
  // Old finished jobs are pruned so the table stays small.
  s.db
    .prepare(
      `DELETE FROM audio_imports WHERE phase IN ('complete', 'failed') AND id NOT IN (
         SELECT id FROM audio_imports WHERE phase IN ('complete', 'failed') ORDER BY updated_at DESC LIMIT ?)`
    )
    .run(KEEP_FINISHED)
  s.touch('audio_imports', j.id)
  return importJob(get(s, j.id))
}

export function updateImportJob(
  s: StoreCtx,
  id: string,
  patch: { note_id?: string | null; phase?: ImportJob['phase']; error?: string | null; engine?: ImportJob['engine'] }
): ImportJob {
  if (typeof id !== 'string' || !id) throw invalid('id is required')
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch?.note_id !== undefined) {
    if (patch.note_id !== null && (typeof patch.note_id !== 'string' || !patch.note_id)) throw invalid('note_id must be a string')
    sets.push('note_id = ?')
    vals.push(patch.note_id)
  }
  if (patch?.phase !== undefined) {
    if (!PHASES.includes(patch.phase)) throw invalid('unknown import phase')
    sets.push('phase = ?')
    vals.push(patch.phase)
  }
  if (patch?.error !== undefined) {
    if (patch.error !== null && typeof patch.error !== 'string') throw invalid('error must be a string')
    sets.push('error = ?')
    vals.push(patch.error === null ? null : patch.error.slice(0, 1_000))
  }
  if (patch?.engine !== undefined) {
    if (patch.engine !== null && !ENGINES.includes(patch.engine)) throw invalid('unknown import engine')
    sets.push('engine = ?')
    vals.push(patch.engine)
  }
  if (sets.length) {
    sets.push('updated_at = ?')
    vals.push(nowIso())
    const changes = s.db.prepare(`UPDATE audio_imports SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id).changes
    if (!changes) throw notFound('import', id)
    s.touch('audio_imports', id)
  }
  return importJob(get(s, id))
}

/** Every job, oldest first (the queue order). */
export function listImportJobs(s: StoreCtx): ImportJobRow[] {
  const rows = s.db.prepare(`SELECT ${COLS} FROM audio_imports ORDER BY created_at ASC, rid ASC`).all() as Record<string, unknown>[]
  return rows.map(toRow)
}

export function deleteImportJob(s: StoreCtx, id: string): void {
  if (typeof id !== 'string' || !id) throw invalid('id is required')
  const changes = s.db.prepare(`DELETE FROM audio_imports WHERE id = ?`).run(id).changes
  if (changes) s.touch('audio_imports', id)
}
