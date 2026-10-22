// SPDX-License-Identifier: Apache-2.0
// Dictation attempts: `dictation_sessions`, with
// the NAU1 key of a failed attempt's audio; files are queued for deletion by trigger.
//
// The key is the attempt's per-file content key, kept in this encrypted database and
// dropped with its row (crypto-shredding, as recordings do). `dictation_sessions_ad`
// queues `rel:dictation-audio/<id>` whenever a row with a key goes; clearing the key of a
// kept row (`audio_purge_at: null` after a sweep or a Retry) queues the file here.

import type { IsoTime } from '@shared/types/common'
import type { DictationAttempt, DictationAttemptStatus, DictationFailureReason } from '@shared/types/dictation'
import type { DictationAttemptPatch, DictationAttemptRow } from './api'
import { nowIso, toBuffer } from './rows'
import { inTransaction, invalid, notFound, type StoreCtx } from './store'
import { processFileDeletions } from './trash-repo'

const COLS = 'id, created_at, status, failure_reason, language, audio_duration_ms, text, audio_purge_at, audio_key'
const STATUSES: readonly DictationAttemptStatus[] = ['recording', 'pasted', 'clipboard', 'delivery_failed', 'empty', 'failed', 'cancelled', 'retried']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ISO = /^\d{4}-\d{2}-\d{2}T/
const MAX_IDS = 10_000

function toRow(r: Record<string, unknown>): DictationAttemptRow {
  const key = r['audio_key']
  return {
    id: String(r['id']),
    created_at: String(r['created_at']),
    status: STATUSES.includes(r['status'] as DictationAttemptStatus) ? (r['status'] as DictationAttemptStatus) : 'failed',
    failure_reason: typeof r['failure_reason'] === 'string' ? (r['failure_reason'] as DictationFailureReason) : null,
    language: typeof r['language'] === 'string' ? r['language'] : null,
    audio_duration_ms: Number(r['audio_duration_ms'] ?? 0),
    text: typeof r['text'] === 'string' ? r['text'] : null,
    audio_purge_at: typeof r['audio_purge_at'] === 'string' ? r['audio_purge_at'] : null,
    has_audio: key instanceof Uint8Array && key.byteLength > 0,
    audio_key: key instanceof Uint8Array && key.byteLength > 0 ? key : null
  }
}

function toAttempt(r: DictationAttemptRow): DictationAttempt {
  const { audio_key: _key, ...a } = r
  return a
}

function read(s: StoreCtx, id: string): DictationAttemptRow | null {
  const r = s.db.prepare(`SELECT ${COLS} FROM dictation_sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined
  return r ? toRow(r) : null
}

function queueFile(s: StoreCtx, id: string): void {
  s.db
    .prepare(`INSERT OR IGNORE INTO file_deletions (path, reason, queued_at) VALUES (?, 'dictation-deleted', ?)`)
    .run(`rel:dictation-audio/${id}`, nowIso())
}

export function createDictationAttempt(s: StoreCtx, a: { id: string; created_at: IsoTime; language: string | null; audio_key: Uint8Array | null }): DictationAttempt {
  if (!a || typeof a.id !== 'string' || !UUID.test(a.id)) throw invalid('attempt id must be a UUID')
  if (typeof a.created_at !== 'string' || !ISO.test(a.created_at)) throw invalid('created_at must be an ISO time')
  if (a.audio_key !== null && (!(a.audio_key instanceof Uint8Array) || a.audio_key.byteLength !== 32)) throw invalid('audio_key must be 32 bytes')
  s.db
    .prepare(
      `INSERT INTO dictation_sessions (id, workspace_id, owner_id, created_at, status, failure_reason, language, audio_duration_ms, text,
         audio_purge_at, audio_key)
       VALUES (?, ?, ?, ?, 'recording', NULL, ?, 0, NULL, NULL, ?)`
    )
    .run(a.id, s.identity.workspaceId, s.identity.ownerId, a.created_at, typeof a.language === 'string' ? a.language : null, a.audio_key ? toBuffer(a.audio_key) : null)
  s.touch('dictation_sessions', a.id)
  return toAttempt(read(s, a.id)!)
}

/**
 * `audio_purge_at: null` on a row that has a key also drops the key and queues its file
 * (the sweep's "clear expiry on the rest" and Retry's "delete the audio").
 */
export function updateDictationAttempt(s: StoreCtx, id: string, patch: DictationAttemptPatch): DictationAttempt {
  const row = read(s, id)
  if (!row) throw notFound('dictation attempt', id)
  if (patch.status !== undefined && !STATUSES.includes(patch.status)) throw invalid('unknown status')
  const next = { ...row, ...patch }
  const dropKey = 'audio_purge_at' in patch && patch.audio_purge_at === null && row.audio_key !== null
  inTransaction(s.db, () => {
    s.db
      .prepare(
        `UPDATE dictation_sessions SET status = ?, failure_reason = ?, language = ?, audio_duration_ms = ?, text = ?, audio_purge_at = ?
           ${dropKey ? ', audio_key = NULL' : ''} WHERE id = ?`
      )
      .run(next.status, next.failure_reason ?? null, next.language ?? null, Math.max(0, Math.round(Number(next.audio_duration_ms) || 0)), next.text ?? null, next.audio_purge_at ?? null, id)
    if (dropKey) queueFile(s, id)
  })
  s.touch('dictation_sessions', id)
  if (dropKey) processFileDeletions(s)
  return toAttempt(read(s, id)!)
}

export function listDictationAttempts(s: StoreCtx, limit: number): DictationAttempt[] {
  const n = Math.max(1, Math.min(1_000, Math.floor(Number(limit) || 200)))
  const rows = s.db.prepare(`SELECT ${COLS} FROM dictation_sessions ORDER BY created_at DESC, rid DESC LIMIT ?`).all(n) as Record<string, unknown>[]
  return rows.map((r) => toAttempt(toRow(r)))
}

export function getDictationAttempt(s: StoreCtx, id: string): DictationAttemptRow | null {
  return typeof id === 'string' ? read(s, id) : null
}

export function deleteDictationAttempts(s: StoreCtx, q: { ids?: string[]; all?: true; expiredBefore?: IsoTime }): { deleted: string[] } {
  if (!q || typeof q !== 'object') throw invalid('a query is required')
  let ids: string[]
  if (q.all === true) {
    ids = (s.db.prepare(`SELECT id FROM dictation_sessions WHERE status <> 'recording'`).all() as { id: string }[]).map((r) => r.id)
  } else if (typeof q.expiredBefore === 'string') {
    if (!ISO.test(q.expiredBefore)) throw invalid('expiredBefore must be an ISO time')
    // Rows past the window that have no text go; the others only lose their audio (caller).
    ids = (
      s.db
        .prepare(`SELECT id FROM dictation_sessions WHERE created_at < ? AND (text IS NULL OR text = '') AND status <> 'recording'`)
        .all(q.expiredBefore) as { id: string }[]
    ).map((r) => r.id)
  } else if (Array.isArray(q.ids)) {
    if (q.ids.length > MAX_IDS || q.ids.some((id) => typeof id !== 'string')) throw invalid('ids must be strings')
    ids = [...new Set(q.ids)]
  } else {
    throw invalid('ids, all or expiredBefore is required')
  }
  const deleted: string[] = []
  inTransaction(s.db, () => {
    const del = s.db.prepare(`DELETE FROM dictation_sessions WHERE id = ?`)
    for (const id of ids) if (del.run(id).changes) deleted.push(id)
  })
  if (deleted.length) s.touch('dictation_sessions', ...deleted)
  return { deleted }
}

/**
 * At startup: rows still `recording` were cut off by a crash or a quit. They stay as they
 * are (the history shows them as "Dictation interrupted"); rows with neither audio nor
 * text can never be retried and are removed. Returns how many remain interrupted.
 */
export function markInterruptedDictations(s: StoreCtx): number {
  s.db.prepare(`DELETE FROM dictation_sessions WHERE status = 'recording' AND audio_key IS NULL AND (text IS NULL OR text = '')`).run()
  const r = s.db.prepare(`SELECT count(*) AS n FROM dictation_sessions WHERE status = 'recording'`).get() as { n: number }
  return Number(r.n)
}
