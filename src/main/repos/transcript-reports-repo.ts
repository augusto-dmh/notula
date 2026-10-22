// SPDX-License-Identifier: Apache-2.0
// Transcript reports: the storage-worker side of their StorageApi group. Worker-safe: no
// Electron imports.
//
// A report keeps a snapshot of the reported excerpt, so
// it holds transcript text: retention deletes it with the transcript, and a note purge cascades.

import type { IsoTime } from '@shared/types/common'
import {
  SPEAKER_LABEL_ME,
  SPEAKER_LABEL_THEM,
  DELETED_CHUNK_MARKER,
  type TranscriptChunk
} from '@shared/types/transcript'
import { TRANSCRIPT_REPORT_LIMITS, type TranscriptReport, type TranscriptReportCategory } from '@shared/types/transcript-reports'
import type { NewTranscriptReport } from '../storage/api'
import { nowIso, toChunk } from '../storage/rows'
import { inTransaction, invalid, type StoreCtx } from '../storage/store'
import { randomUUID } from 'node:crypto'

type Row = Record<string, unknown>

const CATEGORIES: readonly TranscriptReportCategory[] = ['misheard_words', 'gaps', 'language_wrong', 'speaker_errors', 'other']
const MAX_SELECTION = 5_000

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function toReport(r: Row): TranscriptReport {
  return {
    id: String(r['id']),
    note_id: String(r['note_id']),
    category: CATEGORIES.includes(r['category'] as TranscriptReportCategory) ? (r['category'] as TranscriptReportCategory) : 'other',
    comments: String(r['comments'] ?? ''),
    start_timestamp: str(r['start_timestamp']),
    end_timestamp: str(r['end_timestamp']),
    excerpt_text: String(r['excerpt_text'] ?? ''),
    asr_provider: str(r['asr_provider']),
    asr_model: str(r['asr_model']),
    asr_language: str(r['asr_language']),
    asr_local: Number(r['asr_local'] ?? 0) === 1,
    created_at: String(r['created_at'])
  }
}

export function createTranscriptReport(s: StoreCtx, r: NewTranscriptReport): TranscriptReport {
  if (!r || typeof r.note_id !== 'string' || !r.note_id) throw invalid('note_id is required')
  if (!CATEGORIES.includes(r.category)) throw invalid('Choose an issue type')
  const comments = typeof r.comments === 'string' ? r.comments.trim().slice(0, TRANSCRIPT_REPORT_LIMITS.commentsMax) : ''
  const id = randomUUID()
  const now = nowIso()
  return inTransaction(s.db, () => {
    const doc = s.db.prepare(`SELECT 1 FROM documents WHERE id = ? AND owner_id = ?`).get(r.note_id, s.identity.ownerId)
    if (!doc) throw invalid(`note ${r.note_id} not found`)
    s.db
      .prepare(
        `INSERT INTO transcript_reports (id, workspace_id, owner_id, note_id, category, comments, start_timestamp, end_timestamp,
           excerpt, excerpt_text, asr_provider, asr_model, asr_language, asr_local, created_at)
         VALUES (@id, @ws, @owner, @note, @category, @comments, @start, @end, @excerpt, @text, @provider, @model, @language, @local, @now)`
      )
      .run({
        id,
        ws: s.identity.workspaceId,
        owner: s.identity.ownerId,
        note: r.note_id,
        category: r.category,
        comments,
        start: str(r.start_timestamp),
        end: str(r.end_timestamp),
        excerpt: JSON.stringify(Array.isArray(r.excerpt) ? r.excerpt : []),
        text: typeof r.excerpt_text === 'string' ? r.excerpt_text : '',
        provider: str(r.asr_provider),
        model: str(r.asr_model),
        language: str(r.asr_language),
        local: r.asr_local ? 1 : 0,
        now
      })
    s.touch('transcript_reports', r.note_id)
    return toReport(s.db.prepare(`SELECT * FROM transcript_reports WHERE id = ?`).get(id) as Row)
  })
}

export function listTranscriptReports(s: StoreCtx, q: { noteId?: string }): TranscriptReport[] {
  const noteId = typeof q?.noteId === 'string' && q.noteId ? q.noteId : null
  const rows = s.db
    .prepare(
      `SELECT * FROM transcript_reports WHERE owner_id = @owner AND workspace_id = @ws AND (@note IS NULL OR note_id = @note)
       ORDER BY created_at DESC, rid DESC`
    )
    .all({ owner: s.identity.ownerId, ws: s.identity.workspaceId, note: noteId }) as Row[]
  return rows.map(toReport)
}

export function deleteTranscriptReport(s: StoreCtx, id: string): boolean {
  if (typeof id !== 'string' || !id) return false
  const row = s.db.prepare(`SELECT note_id FROM transcript_reports WHERE id = ? AND owner_id = ?`).get(id, s.identity.ownerId) as
    | { note_id: string }
    | undefined
  if (!row) return false
  s.db.prepare(`DELETE FROM transcript_reports WHERE id = ?`).run(id)
  s.touch('transcript_reports', row.note_id)
  return true
}

function speakerOf(c: TranscriptChunk): string {
  const name = c.detected_speaker_name?.trim()
  if (c.source === 'microphone') return name && name !== 'You' ? name : SPEAKER_LABEL_ME
  return name || SPEAKER_LABEL_THEM
}

function visible(c: TranscriptChunk): boolean {
  return c.text !== DELETED_CHUNK_MARKER && c.text.trim().length > 0
}

/**
 * The snapshot of the reported stretch. A selection uses only its finalized chunks; the
 * range is their earliest start to latest end. Without a selection, or when the selection has no
 * finalized chunk, the snapshot is the first 2,000 characters of the transcript and has no range.
 */
export function reportExcerpt(
  s: StoreCtx,
  noteId: string,
  chunkIds?: string[]
): { text: string; excerpt: unknown[]; start: IsoTime | null; end: IsoTime | null } {
  if (typeof noteId !== 'string' || !noteId) throw invalid('noteId is required')
  const all = (
    s.db
      .prepare(`SELECT * FROM transcript_chunks WHERE document_id = ? AND is_final = 1 ORDER BY start_timestamp, end_timestamp, id`)
      .all(noteId) as Row[]
  )
    .map(toChunk)
    .filter(visible)
  const ids = Array.isArray(chunkIds) ? new Set(chunkIds.filter((i) => typeof i === 'string').slice(0, MAX_SELECTION)) : null
  const picked = ids && ids.size ? all.filter((c) => ids.has(c.id)) : []
  const line = (c: TranscriptChunk): string => `${speakerOf(c)}: ${c.text.trim()}`
  if (picked.length) {
    const excerpt = picked.map((c) => ({
      id: c.id,
      source: c.source,
      speaker: speakerOf(c),
      start_timestamp: c.start_timestamp,
      end_timestamp: c.end_timestamp,
      text: c.text
    }))
    const start = picked.reduce((m, c) => (c.start_timestamp < m ? c.start_timestamp : m), picked[0]!.start_timestamp)
    const end = picked.reduce((m, c) => (c.end_timestamp > m ? c.end_timestamp : m), picked[0]!.end_timestamp)
    return { text: picked.map(line).join('\n'), excerpt, start, end }
  }
  const lines: string[] = []
  const excerpt: unknown[] = []
  let used = 0
  for (const c of all) {
    if (used >= TRANSCRIPT_REPORT_LIMITS.noRangeExcerptChars) break
    const l = line(c)
    const room = TRANSCRIPT_REPORT_LIMITS.noRangeExcerptChars - used
    lines.push(l.length > room ? l.slice(0, room) : l)
    excerpt.push({ id: c.id, source: c.source, speaker: speakerOf(c), text: c.text.slice(0, room) })
    used += Math.min(l.length, room) + 1
  }
  return { text: lines.join('\n').slice(0, TRANSCRIPT_REPORT_LIMITS.noRangeExcerptChars), excerpt, start: null, end: null }
}
