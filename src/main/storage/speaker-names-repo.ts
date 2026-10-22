// SPDX-License-Identifier: Apache-2.0
// Speaker-name suggestions:
// `speaker_guesses`, deleted with the note by FK (both delete paths). Each run
// replaces the note's rows in one transaction; accept and reject delete one row.
//
// The `suggestion` column holds the suggestion object (identityKey, label, name,
// evidenceTypes, channel, labelStream, transcriptExcerpts); `position` and `created_at`
// are their own columns.

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
    created_at: typeof r['created_at'] === 'string' ? r['created_at'] : ''
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
      : []
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

export function deleteSpeakerNameSuggestion(s: StoreCtx, noteId: string, identityKey: string): void {
  if (typeof noteId !== 'string' || !noteId) throw invalid('noteId is required')
  if (typeof identityKey !== 'string' || !identityKey) throw invalid('identityKey is required')
  const changes = s.db
    .prepare(`DELETE FROM speaker_guesses WHERE document_id = ? AND speaker_key = ?`)
    .run(noteId, identityKey).changes
  if (changes > 0) s.touch('speaker_guesses', noteId)
}
