// SPDX-License-Identifier: Apache-2.0
// Meeting classification tags: `documents.tags`,
// mirrored into `document_tags` by the migration-4 triggers.
//
// - Only the two categories survive a write; one entry per category.
// - The classifier never replaces a `manual` meeting type.
// - The manual override stamps strictly increasing times within the session and
//   returns an undo that restores only notes still carrying its own stamp. Undo tokens
//   live in this worker's memory (the session), as the override's optimism does.

import { randomUUID } from 'node:crypto'
import { MEETING_TYPE_PENDING, MEETING_TYPES_V2, type DocumentTag, type TagCategory } from '@shared/types/notes'
import { nowIso, parseJson } from './rows'
import { inTransaction, invalid, notFound, type StoreCtx } from './store'

const CATEGORIES: readonly TagCategory[] = ['meeting_kind', 'is_sensitive']
const SOURCE_LOCAL = 'notula-local'
const SOURCE_MANUAL = 'manual'
const MAX_NOTES = 1_000
const MAX_UNDO = 200

/** The note's tag entries, objects of the two categories only, one per category (the first wins). */
function readTags(s: StoreCtx, noteId: string): DocumentTag[] {
  const row = s.db.prepare(`SELECT tags FROM documents WHERE id = ?`).get(noteId) as { tags: string } | undefined
  if (!row) throw notFound('note', noteId)
  const raw = parseJson<unknown>(row.tags, [])
  const out: DocumentTag[] = []
  for (const t of Array.isArray(raw) ? raw : []) {
    if (typeof t !== 'object' || t === null) continue
    const e = t as Partial<DocumentTag>
    if (!CATEGORIES.includes(e.category as TagCategory) || out.some((x) => x.category === e.category)) continue
    out.push({
      category: e.category as TagCategory,
      value: typeof e.value === 'string' ? e.value : null,
      source: typeof e.source === 'string' ? e.source : SOURCE_LOCAL,
      updated_at: typeof e.updated_at === 'string' ? e.updated_at : nowIso()
    })
  }
  return out
}

/** One update of `tags`: the `document_tags_au` trigger rewrites the mirror rows. */
function writeTags(s: StoreCtx, noteId: string, tags: DocumentTag[]): void {
  const ordered = CATEGORIES.map((c) => tags.find((t) => t.category === c)).filter((t): t is DocumentTag => !!t)
  s.db.prepare(`UPDATE documents SET tags = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(ordered), nowIso(), noteId)
}

/** The classifier's verdict; a `manual` meeting type is kept as it is. */
export function setClassifierTags(s: StoreCtx, noteId: string, t: { meetingType: string; isSensitive: boolean }): DocumentTag[] {
  if (typeof noteId !== 'string' || !noteId) throw invalid('noteId is required')
  if (typeof t !== 'object' || t === null || typeof t.isSensitive !== 'boolean') throw invalid('tags are invalid')
  const meetingType = MEETING_TYPES_V2.includes(t.meetingType) ? t.meetingType : 'unknown'
  const tags = inTransaction(s.db, () => {
    const current = readTags(s, noteId)
    const now = nowIso()
    const manual = current.find((x) => x.category === 'meeting_kind' && x.source === SOURCE_MANUAL)
    const next: DocumentTag[] = [
      manual ?? { category: 'meeting_kind', value: meetingType, source: SOURCE_LOCAL, updated_at: now },
      { category: 'is_sensitive', value: t.isSensitive ? 'true' : 'false', source: SOURCE_LOCAL, updated_at: now }
    ]
    writeTags(s, noteId, next)
    return next
  })
  s.touch('documents', noteId)
  s.log('info', 'tags-classified', { noteId, manualKept: tags[0]?.source === SOURCE_MANUAL })
  return tags
}

interface UndoEntry {
  noteId: string
  previous: DocumentTag | null
  written: string
}

const undoLog = new Map<string, UndoEntry[]>()
let lastStamp = 0

/** Strictly increasing within the session: the later of now and the previous stamp + 1 ms. */
function nextStamp(): string {
  lastStamp = Math.max(Date.now(), lastStamp + 1)
  return new Date(lastStamp).toISOString()
}

/** Sets (or clears, with null) the meeting type of every note, as `manual`. */
export function setManualMeetingType(s: StoreCtx, noteIds: string[], value: string | null): { undoToken: string } {
  if (!Array.isArray(noteIds) || noteIds.length === 0 || noteIds.length > MAX_NOTES || noteIds.some((n) => typeof n !== 'string' || !n)) {
    throw invalid('noteIds are invalid')
  }
  if (value !== null && (typeof value !== 'string' || !(MEETING_TYPES_V2.includes(value) || value === MEETING_TYPE_PENDING))) {
    throw invalid('value is not a meeting type')
  }
  const notes = [...new Set(noteIds)]
  const entries = inTransaction(s.db, () =>
    notes.map((noteId): UndoEntry => {
      const current = readTags(s, noteId)
      const previous = current.find((x) => x.category === 'meeting_kind') ?? null
      const written = nextStamp()
      writeTags(s, noteId, [
        ...current.filter((x) => x.category !== 'meeting_kind'),
        { category: 'meeting_kind', value, source: SOURCE_MANUAL, updated_at: written }
      ])
      return { noteId, previous, written }
    })
  )
  const undoToken = randomUUID()
  undoLog.set(undoToken, entries)
  while (undoLog.size > MAX_UNDO) undoLog.delete(undoLog.keys().next().value as string)
  s.touch('documents', ...notes)
  s.log('info', 'tags-manual-meeting-type', { notes: notes.length, cleared: value === null })
  return { undoToken }
}

/** Restores each note's previous meeting type, only where the stamp is still the one written. */
export function undoManualMeetingType(s: StoreCtx, undoToken: string): number {
  const entries = typeof undoToken === 'string' ? undoLog.get(undoToken) : undefined
  if (!entries) return 0
  undoLog.delete(undoToken)
  const restored = inTransaction(s.db, () => {
    const done: string[] = []
    for (const e of entries) {
      const exists = s.db.prepare(`SELECT 1 FROM documents WHERE id = ?`).get(e.noteId)
      if (!exists) continue
      const current = readTags(s, e.noteId)
      const mine = current.find((x) => x.category === 'meeting_kind')
      if (!mine || mine.source !== SOURCE_MANUAL || mine.updated_at !== e.written) continue
      writeTags(s, e.noteId, [...current.filter((x) => x.category !== 'meeting_kind'), ...(e.previous ? [e.previous] : [])])
      done.push(e.noteId)
    }
    return done
  })
  if (restored.length) s.touch('documents', ...restored)
  return restored.length
}
