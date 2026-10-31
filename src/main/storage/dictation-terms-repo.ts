// SPDX-License-Identifier: Apache-2.0
// The voice typing dictionary: `dictation_terms`, keyed by the normalised term, and its local
// usage in `dictation_term_usage` (migration 14). Usage never leaves the device.
//
// - A term is 1–50 characters, at most 6 words and has no comma. At most 300 live terms (manual
//   adds included) and 20 starred.
// - Adding an existing live term changes nothing. Adding a removed one restores it.
// - Removing soft-deletes (`deleted_at`): the term stays known, so learning never brings it
//   back, and Restore undoes it. Learned terms never overwrite a removed one.
// - An edit that changes the spelling moves the row to the new id; usage follows (cascade).

import {
  DICTATION_TERM_LIMITS as L,
  normaliseTerm,
  validTerm,
  type DictationTerm,
  type DictationTermResult
} from '@shared/types/dictation'
import { nowIso } from './rows'
import { inTransaction, invalid, type StoreCtx } from './store'

const COLS = `t.id, t.term, t.source, t.starred, t.created_at, t.updated_at, t.deleted_at,
  coalesce(u.use_count, 0) AS use_count, u.last_used_at`
const FROM = `dictation_terms t LEFT JOIN dictation_term_usage u ON u.term_id = t.id`

const clean = (term: string): string => term.normalize('NFC').trim().replace(/\s+/g, ' ')

function toTerm(r: Record<string, unknown>): DictationTerm {
  const source = r['source']
  return {
    id: String(r['id']),
    term: String(r['term']),
    source: source === 'learned' || source === 'imported' ? source : 'manual',
    starred: Number(r['starred']) === 1,
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at']),
    deleted_at: typeof r['deleted_at'] === 'string' ? r['deleted_at'] : null,
    use_count: Math.max(0, Number(r['use_count']) || 0),
    last_used_at: typeof r['last_used_at'] === 'string' ? r['last_used_at'] : null
  }
}

function read(s: StoreCtx, id: string): DictationTerm | null {
  const r = s.db.prepare(`SELECT ${COLS} FROM ${FROM} WHERE t.id = ?`).get(id) as Record<string, unknown> | undefined
  return r ? toTerm(r) : null
}

function counts(s: StoreCtx): { live: number; starred: number } {
  const r = s.db
    .prepare(`SELECT count(*) AS live, coalesce(sum(starred), 0) AS starred FROM dictation_terms WHERE deleted_at IS NULL`)
    .get() as { live: number; starred: number }
  return { live: Number(r.live), starred: Number(r.starred) }
}

/** Live terms first (starred, then by term), then removed ones (newest removal first). */
export function listDictationTerms(s: StoreCtx): DictationTerm[] {
  const rows = s.db
    .prepare(`SELECT ${COLS} FROM ${FROM} ORDER BY t.deleted_at IS NOT NULL, t.starred DESC, t.deleted_at DESC, t.term COLLATE NOCASE`)
    .all() as Record<string, unknown>[]
  return rows.map(toTerm)
}

export function addDictationTerm(s: StoreCtx, p: { term: string; source: 'manual' | 'learned' }): DictationTermResult {
  if (!p || !validTerm(p.term)) return { ok: false, error: 'invalid' }
  if (p.source !== 'manual' && p.source !== 'learned') throw invalid('source must be manual or learned')
  const term = clean(p.term)
  const id = normaliseTerm(term)
  const existing = read(s, id)
  if (existing && existing.deleted_at === null) return { ok: true, term: existing }
  // Learning never brings a removed term back.
  if (existing && p.source === 'learned') return { ok: true, term: existing }
  if (counts(s).live >= L.maxTerms) return { ok: false, error: 'full' }
  const now = nowIso()
  inTransaction(s.db, () => {
    if (existing) {
      s.db.prepare(`UPDATE dictation_terms SET term = ?, deleted_at = NULL, updated_at = ? WHERE id = ?`).run(term, now, id)
    } else {
      s.db
        .prepare(`INSERT INTO dictation_terms (id, term, source, starred, created_at, updated_at, deleted_at) VALUES (?, ?, ?, 0, ?, ?, NULL)`)
        .run(id, term, p.source, now, now)
    }
  })
  s.touch('dictation_terms', id)
  return { ok: true, term: read(s, id)! }
}

export function updateDictationTerm(s: StoreCtx, p: { id: string; term?: string; starred?: boolean }): DictationTermResult {
  if (!p || typeof p.id !== 'string') throw invalid('id is required')
  const row = read(s, p.id)
  if (!row || row.deleted_at !== null) return { ok: false, error: 'not-found' }
  if (p.term !== undefined && !validTerm(p.term)) return { ok: false, error: 'invalid' }
  if (p.starred === true && !row.starred && counts(s).starred >= L.maxStarred) return { ok: false, error: 'starred-full' }
  const now = nowIso()
  const term = p.term !== undefined ? clean(p.term) : row.term
  const nextId = normaliseTerm(term)
  // Another row already holds the new spelling: the edit can't merge into it.
  if (nextId !== row.id && read(s, nextId)) return { ok: false, error: 'invalid' }
  inTransaction(s.db, () => {
    s.db
      .prepare(`UPDATE dictation_terms SET id = ?, term = ?, starred = ?, updated_at = ? WHERE id = ?`)
      .run(nextId, term, (p.starred ?? row.starred) ? 1 : 0, now, row.id)
  })
  s.touch('dictation_terms', nextId)
  return { ok: true, term: read(s, nextId)! }
}

export function removeDictationTerm(s: StoreCtx, id: string): DictationTermResult {
  const row = typeof id === 'string' ? read(s, id) : null
  if (!row) return { ok: false, error: 'not-found' }
  if (row.deleted_at === null) {
    const now = nowIso()
    s.db.prepare(`UPDATE dictation_terms SET deleted_at = ?, starred = 0, updated_at = ? WHERE id = ?`).run(now, now, id)
    s.touch('dictation_terms', id)
  }
  return { ok: true, term: read(s, id)! }
}

export function restoreDictationTerm(s: StoreCtx, id: string): DictationTermResult {
  const row = typeof id === 'string' ? read(s, id) : null
  if (!row) return { ok: false, error: 'not-found' }
  if (row.deleted_at === null) return { ok: true, term: row }
  if (counts(s).live >= L.maxTerms) return { ok: false, error: 'full' }
  s.db.prepare(`UPDATE dictation_terms SET deleted_at = NULL, updated_at = ? WHERE id = ?`).run(nowIso(), id)
  s.touch('dictation_terms', id)
  return { ok: true, term: read(s, id)! }
}

/** One more use, now, for each live term id. */
export function recordDictationTermUse(s: StoreCtx, ids: string[]): void {
  if (!Array.isArray(ids) || ids.length === 0) return
  if (ids.length > L.maxTerms || ids.some((id) => typeof id !== 'string')) throw invalid('ids must be strings')
  const now = nowIso()
  inTransaction(s.db, () => {
    const bump = s.db.prepare(
      `INSERT INTO dictation_term_usage (term_id, use_count, last_used_at)
       SELECT id, 1, ? FROM dictation_terms WHERE id = ? AND deleted_at IS NULL
       ON CONFLICT (term_id) DO UPDATE SET use_count = use_count + 1, last_used_at = excluded.last_used_at`
    )
    for (const id of new Set(ids)) bump.run(now, id)
  })
}
