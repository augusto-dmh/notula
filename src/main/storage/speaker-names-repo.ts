// SPDX-License-Identifier: Apache-2.0
// Speaker-name suggestions:
// `speaker_guesses`, deleted with the note by FK (both delete paths). Each run
// replaces the note's rows in one transaction; accept and reject delete one row.
//
// The `suggestion` column holds the suggestion object (identityKey, label, name,
// evidenceTypes, channel, labelStream, transcriptExcerpts, and the speaker-profiles fields band,
// candidates, passId, pending); `position` and `created_at` are their own columns. A row stored
// before speaker profiles reads as `suggest` with a name, else `none`.

import type { SpeakerBand, SpeakerCandidate } from '@shared/types/speakers'
import type { SpeakerEvidenceType, SpeakerNameSuggestion } from '@shared/types/transcript'
import { nowIso, parseJson } from './rows'
import { inTransaction, invalid, type StoreCtx } from './store'

const EVIDENCE: readonly SpeakerEvidenceType[] = [
  'introduced_self',
  'named_then_replied',
  'elimination',
  'addressed_not_speaking',
  'app_speaker_data'
]
const BANDS: readonly SpeakerBand[] = ['auto', 'suggest', 'tie', 'none']
const CANDIDATE_SOURCES: readonly SpeakerCandidate['source'][] = ['app', 'voice', 'conversation', 'elimination']
const MAX_CANDIDATES = 2
const MAX_ROWS = 200
const MAX_EXCERPTS = 4
const MAX_EXCERPT_CHARS = 240

interface StoredSuggestion {
  identityKey: string
  label: string
  name: string | null
  evidenceTypes: SpeakerEvidenceType[]
  channel: 'microphone' | 'system'
  labelStream: 'reconciled' | 'provider'
  transcriptExcerpts: string[]
  band: SpeakerBand
  candidates: SpeakerCandidate[]
  passId: string | null
  pending: boolean
}

function candidatesOf(v: unknown): SpeakerCandidate[] {
  if (!Array.isArray(v)) return []
  const out: SpeakerCandidate[] = []
  for (const c of v as Partial<SpeakerCandidate>[]) {
    if (out.length >= MAX_CANDIDATES) break
    if (!c || typeof c.name !== 'string' || !c.name.trim() || !CANDIDATE_SOURCES.includes(c.source as SpeakerCandidate['source'])) continue
    const name = c.name.trim().slice(0, 200)
    const personId = typeof c.personId === 'string' && c.personId ? c.personId.slice(0, 64) : undefined
    out.push(personId ? { personId, name, source: c.source as SpeakerCandidate['source'] } : { name, source: c.source as SpeakerCandidate['source'] })
  }
  return out
}

function toSuggestion(r: Record<string, unknown>): SpeakerNameSuggestion {
  const s = parseJson<Partial<StoredSuggestion>>(r['suggestion'], {})
  const key = typeof r['speaker_key'] === 'string' ? r['speaker_key'] : ''
  return {
    identityKey: key,
    label: typeof s.label === 'string' ? s.label : '',
    name: typeof s.name === 'string' && s.name.trim() ? s.name : null,
    evidenceTypes: Array.isArray(s.evidenceTypes) ? s.evidenceTypes.filter((t) => EVIDENCE.includes(t)) : [],
    channel: s.channel === 'microphone' ? 'microphone' : 'system',
    labelStream: s.labelStream === 'provider' ? 'provider' : 'reconciled',
    transcriptExcerpts: Array.isArray(s.transcriptExcerpts) ? s.transcriptExcerpts.filter((e) => typeof e === 'string') : [],
    position: Number(r['position'] ?? 0),
    created_at: typeof r['created_at'] === 'string' ? r['created_at'] : '',
    band: BANDS.includes(s.band as SpeakerBand) ? (s.band as SpeakerBand) : typeof s.name === 'string' && s.name.trim() ? 'suggest' : 'none',
    candidates: candidatesOf(s.candidates),
    passId: typeof s.passId === 'string' && s.passId ? s.passId : null,
    pending: s.pending === true
  }
}

/** Every row of the note, in `position` order. */
export function listSpeakerNameSuggestions(s: StoreCtx, noteId: string): SpeakerNameSuggestion[] {
  if (typeof noteId !== 'string' || !noteId) throw invalid('noteId is required')
  const rows = s.db
    .prepare(
      `SELECT speaker_key, position, suggestion, created_at FROM speaker_guesses
       WHERE document_id = ? ORDER BY position ASC, speaker_key ASC`
    )
    .all(noteId) as Record<string, unknown>[]
  return rows.map(toSuggestion)
}

function clean(row: Omit<SpeakerNameSuggestion, 'created_at'>): StoredSuggestion {
  if (!row || typeof row.identityKey !== 'string' || !row.identityKey) throw invalid('identityKey is required')
  return {
    identityKey: row.identityKey,
    label: typeof row.label === 'string' ? row.label.slice(0, 200) : '',
    name: typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 200) : null,
    evidenceTypes: Array.isArray(row.evidenceTypes) ? [...new Set(row.evidenceTypes.filter((t) => EVIDENCE.includes(t)))] : [],
    channel: row.channel === 'microphone' ? 'microphone' : 'system',
    labelStream: row.labelStream === 'provider' ? 'provider' : 'reconciled',
    transcriptExcerpts: Array.isArray(row.transcriptExcerpts)
      ? row.transcriptExcerpts
          .filter((e) => typeof e === 'string')
          .slice(0, MAX_EXCERPTS)
          .map((e) => e.slice(0, MAX_EXCERPT_CHARS))
      : [],
    band: BANDS.includes(row.band) ? row.band : 'none',
    candidates: candidatesOf(row.candidates),
    passId: typeof row.passId === 'string' && row.passId ? row.passId.slice(0, 64) : null,
    pending: row.pending === true
  }
}

/** One transaction: deletes the note's rows, then inserts these in order. */
export function replaceSpeakerNameSuggestions(s: StoreCtx, noteId: string, rows: Omit<SpeakerNameSuggestion, 'created_at'>[]): void {
  if (typeof noteId !== 'string' || !noteId) throw invalid('noteId is required')
  if (!Array.isArray(rows)) throw invalid('rows must be an array')
  if (rows.length > MAX_ROWS) throw invalid('too many suggestions')
  const cleaned = rows.map(clean)
  const now = nowIso()
  inTransaction(s.db, () => {
    s.db.prepare(`DELETE FROM speaker_guesses WHERE document_id = ?`).run(noteId)
    // A note deleted meanwhile keeps no rows (the FK would refuse them anyway).
    if (!s.db.prepare(`SELECT 1 FROM documents WHERE id = ?`).get(noteId)) return
    const insert = s.db.prepare(
      `INSERT OR REPLACE INTO speaker_guesses
         (document_id, speaker_key, position, suggestion, workspace_id, owner_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    cleaned.forEach((row, i) => {
      insert.run(noteId, row.identityKey, i, JSON.stringify(row), s.identity.workspaceId, s.identity.ownerId, now)
    })
  })
  s.touch('speaker_guesses', noteId)
}

/** One row's band, candidates or pending flag; a missing row is a no-op. */
export function patchSpeakerNameSuggestion(
  s: StoreCtx,
  noteId: string,
  identityKey: string,
  patch: { band?: SpeakerBand; candidates?: SpeakerCandidate[]; pending?: boolean }
): void {
  if (typeof noteId !== 'string' || !noteId) throw invalid('noteId is required')
  if (typeof identityKey !== 'string' || !identityKey) throw invalid('identityKey is required')
  if (!patch || typeof patch !== 'object') throw invalid('patch is required')
  if (patch.band !== undefined && !BANDS.includes(patch.band)) throw invalid('unknown band')
  if (patch.candidates !== undefined && !Array.isArray(patch.candidates)) throw invalid('candidates must be an array')
  if (patch.pending !== undefined && typeof patch.pending !== 'boolean') throw invalid('pending must be a boolean')
  const changed = inTransaction(s.db, () => {
    const r = s.db
      .prepare(`SELECT * FROM speaker_guesses WHERE document_id = ? AND speaker_key = ?`)
      .get(noteId, identityKey) as Record<string, unknown> | undefined
    if (!r) return false
    const row = toSuggestion(r)
    const next = clean({
      ...row,
      ...(patch.band !== undefined ? { band: patch.band } : {}),
      ...(patch.candidates !== undefined ? { candidates: patch.candidates } : {}),
      ...(patch.pending !== undefined ? { pending: patch.pending } : {})
    })
    s.db.prepare(`UPDATE speaker_guesses SET suggestion = ? WHERE document_id = ? AND speaker_key = ?`).run(JSON.stringify(next), noteId, identityKey)
    return true
  })
  if (changed) s.touch('speaker_guesses', noteId)
}

/**
 * A dropped request leaves the speaker unnamed: `pending: true`
 * goes from the suggestion rows of these notes once a note holds no `speaker_pending` row. The
 * row names no person, so a note that still holds another request keeps its flags. Inside
 * the caller's transaction; returns the notes changed, for the caller's touch.
 */
export function clearDroppedPendingFlags(s: StoreCtx, noteIds: string[] | 'all'): string[] {
  if (noteIds !== 'all' && !noteIds.length) return []
  const rows = s.db
    .prepare(
      `UPDATE speaker_guesses SET suggestion = json_set(suggestion, '$.pending', json('false'))
       WHERE owner_id = @owner AND (@all = 1 OR document_id IN (SELECT value FROM json_each(@ids)))
         AND json_valid(suggestion) AND json_extract(suggestion, '$.pending') = 1
         AND NOT EXISTS (SELECT 1 FROM speaker_pending p WHERE p.note_id = speaker_guesses.document_id)
       RETURNING document_id`
    )
    .all({ owner: s.identity.ownerId, all: noteIds === 'all' ? 1 : 0, ids: JSON.stringify(noteIds === 'all' ? [] : noteIds) }) as {
    document_id: string
  }[]
  return [...new Set(rows.map((r) => r.document_id))]
}

export function deleteSpeakerNameSuggestion(s: StoreCtx, noteId: string, identityKey: string): void {
  if (typeof noteId !== 'string' || !noteId) throw invalid('noteId is required')
  if (typeof identityKey !== 'string' || !identityKey) throw invalid('identityKey is required')
  const changes = s.db
    .prepare(`DELETE FROM speaker_guesses WHERE document_id = ? AND speaker_key = ?`)
    .run(noteId, identityKey).changes
  if (changes > 0) s.touch('speaker_guesses', noteId)
}
