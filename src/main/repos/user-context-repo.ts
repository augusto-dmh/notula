// SPDX-License-Identifier: Apache-2.0
// User context: the storage-worker side of its StorageApi group. Worker-safe: no Electron imports.
//
// - Sections: one row per (owner, section id), Markdown, at most 4,000 characters.
// - Entries: the terms and projects tables, unique by name ignoring case within a kind, each
//   kind capped at its row limit. Main checks the field lengths. A refresh replaces the drafted
//   rows of a kind as a whole set and never touches the user's rows.
// - People: the people aggregate (read-only use), ranked with a recency decay.
// - Draft inputs: the user's own notes from the window, newest first, as the latest summary's
//   markdown (else the notes), within the note and character budgets.
// - Recorded notes: the user's own notes with a transcript (or one retention removed), demo and
//   shared notes aside, counted up to a cap; drafting unlocks at the cap.

import { randomUUID } from 'node:crypto'
import type { IsoTime } from '@shared/types/common'
import { DEMO_MEETING_PREFIX } from '@shared/types/notes'
import {
  USER_CONTEXT_LIMITS,
  USER_CONTEXT_SECTIONS,
  type UserContextEntry,
  type UserContextEntryKind,
  type UserContextPerson,
  type UserContextSection,
  type UserContextSectionId
} from '@shared/types/user-context'
import { listPeople } from '../storage/people-repo'
import { nowIso } from '../storage/rows'
import { inTransaction, invalid, notFound, type StoreCtx } from '../storage/store'

type Row = Record<string, unknown>

const IDS = new Set<string>(USER_CONTEXT_SECTIONS.map((s) => s.id))
const DAY_MS = 86_400_000

function toSection(r: Row): UserContextSection {
  return {
    section_id: String(r['section_id']) as UserContextSectionId,
    content: String(r['content'] ?? ''),
    origin: r['origin'] === 'drafted' ? 'drafted' : 'user',
    drafted_at: typeof r['drafted_at'] === 'string' && r['drafted_at'] ? r['drafted_at'] : null,
    updated_at: String(r['updated_at'])
  }
}

export function listUserContextSections(s: StoreCtx): UserContextSection[] {
  const rows = s.db.prepare(`SELECT * FROM user_context_sections WHERE owner_id = ?`).all(s.identity.ownerId) as Row[]
  const order = (id: string): number => USER_CONTEXT_SECTIONS.findIndex((x) => x.id === id)
  return rows.map(toSection).sort((a, b) => order(a.section_id) - order(b.section_id))
}

export function upsertUserContextSection(
  s: StoreCtx,
  section: { section_id: UserContextSectionId; content: string; origin: 'user' | 'drafted'; drafted_at: IsoTime | null }
): UserContextSection {
  if (!IDS.has(section.section_id)) throw invalid('Unknown section.')
  const content = section.content.slice(0, USER_CONTEXT_LIMITS.sectionMax)
  const now = nowIso()
  const row = inTransaction(s.db, () => {
    s.db
      .prepare(
        `INSERT INTO user_context_sections (id, workspace_id, owner_id, section_id, content, origin, drafted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (owner_id, section_id) DO UPDATE SET content = excluded.content, origin = excluded.origin,
           drafted_at = excluded.drafted_at, updated_at = excluded.updated_at`
      )
      .run(randomUUID(), s.identity.workspaceId, s.identity.ownerId, section.section_id, content, section.origin, section.drafted_at, now)
    return s.db.prepare(`SELECT * FROM user_context_sections WHERE owner_id = ? AND section_id = ?`).get(s.identity.ownerId, section.section_id) as Row
  })
  s.touch('user_context_sections', String(row['id']))
  return toSection(row)
}

function toEntry(r: Row): UserContextEntry {
  return {
    id: String(r['id']),
    kind: r['kind'] === 'project' ? 'project' : 'term',
    name: String(r['name']),
    body: String(r['body'] ?? ''),
    role: typeof r['role'] === 'string' && r['role'] ? r['role'] : null,
    origin: r['origin'] === 'drafted' ? 'drafted' : 'user',
    position: Number(r['position'] ?? 0),
    drafted_at: typeof r['drafted_at'] === 'string' && r['drafted_at'] ? r['drafted_at'] : null,
    updated_at: String(r['updated_at'])
  }
}

const entryKey = (name: string): string => name.normalize('NFC').trim().toLocaleLowerCase()
const entryMax = (kind: UserContextEntryKind): number => (kind === 'term' ? USER_CONTEXT_LIMITS.termsMax : USER_CONTEXT_LIMITS.projectsMax)
const entryNoun = (kind: UserContextEntryKind): string => (kind === 'term' ? 'terms' : 'projects')

function entriesOf(s: StoreCtx, kind: UserContextEntryKind): UserContextEntry[] {
  const rows = s.db.prepare(`SELECT * FROM user_context_entries WHERE owner_id = ? AND kind = ? ORDER BY position, rid`).all(s.identity.ownerId, kind) as Row[]
  return rows.map(toEntry)
}

export function listUserContextEntries(s: StoreCtx): UserContextEntry[] {
  return [...entriesOf(s, 'project'), ...entriesOf(s, 'term')]
}

/** Creates a row, or updates the row `id`. Refuses a name the kind already has, ignoring case. */
export function setUserContextEntry(
  s: StoreCtx,
  e: { id?: string; kind: UserContextEntryKind; name: string; body: string; role: string | null; origin: 'user' | 'drafted'; drafted_at: IsoTime | null }
): UserContextEntry {
  if (e.kind !== 'term' && e.kind !== 'project') throw invalid('Unknown table.')
  const name = e.name.normalize('NFC').trim()
  if (!name) throw invalid('Enter a name.')
  const now = nowIso()
  const id = inTransaction(s.db, () => {
    const rows = entriesOf(s, e.kind)
    const current = e.id ? rows.find((r) => r.id === e.id) : undefined
    if (e.id && !current) throw notFound('row', e.id)
    if (rows.some((r) => r.id !== e.id && entryKey(r.name) === entryKey(name))) {
      throw invalid(`“${name}” is already in your ${entryNoun(e.kind)}. Edit that row instead.`)
    }
    if (current) {
      s.db
        .prepare(`UPDATE user_context_entries SET name = ?, body = ?, role = ?, origin = ?, drafted_at = ?, updated_at = ? WHERE id = ?`)
        .run(name, e.body, e.role, e.origin, e.drafted_at, now, current.id)
      return current.id
    }
    const max = entryMax(e.kind)
    if (rows.length >= max) throw invalid(`You can keep up to ${max} ${entryNoun(e.kind)}. Delete one to add another.`)
    const next = randomUUID()
    s.db
      .prepare(
        `INSERT INTO user_context_entries (id, workspace_id, owner_id, kind, name, body, role, origin, position, drafted_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(next, s.identity.workspaceId, s.identity.ownerId, e.kind, name, e.body, e.role, e.origin, (rows.at(-1)?.position ?? -1) + 1, e.drafted_at, now)
    return next
  })
  s.touch('user_context_entries', id)
  return toEntry(s.db.prepare(`SELECT * FROM user_context_entries WHERE id = ?`).get(id) as Row)
}

/** Deletes a row and returns it, or null when it is already gone. */
export function deleteUserContextEntry(s: StoreCtx, id: string): UserContextEntry | null {
  const row = s.db.prepare(`SELECT * FROM user_context_entries WHERE id = ? AND owner_id = ?`).get(id, s.identity.ownerId) as Row | undefined
  if (!row) return null
  s.db.prepare(`DELETE FROM user_context_entries WHERE id = ?`).run(id)
  s.touch('user_context_entries', id)
  return toEntry(row)
}

/**
 * A refresh: the drafted rows of `kind` become `rows`, placed after the user's rows. A row whose
 * name matches one of the user's rows, a name in `skip` (lower-cased) or an earlier row is
 * dropped, and the kind stays within its row limit. Returns how many rows were written.
 */
export function replaceDraftedUserContextEntries(
  s: StoreCtx,
  q: { kind: UserContextEntryKind; rows: { name: string; body: string; role: string | null }[]; drafted_at: IsoTime; skip: string[] }
): number {
  if (q.kind !== 'term' && q.kind !== 'project') throw invalid('Unknown table.')
  const now = nowIso()
  const written = inTransaction(s.db, () => {
    s.db.prepare(`DELETE FROM user_context_entries WHERE owner_id = ? AND kind = ? AND origin = 'drafted'`).run(s.identity.ownerId, q.kind)
    const mine = entriesOf(s, q.kind)
    const seen = new Set([...mine.map((r) => entryKey(r.name)), ...q.skip])
    const insert = s.db.prepare(
      `INSERT INTO user_context_entries (id, workspace_id, owner_id, kind, name, body, role, origin, position, drafted_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'drafted', ?, ?, ?)`
    )
    let position = (mine.at(-1)?.position ?? -1) + 1
    let room = entryMax(q.kind) - mine.length
    let n = 0
    for (const r of q.rows) {
      if (room <= 0) break
      const name = r.name.normalize('NFC').trim()
      if (!name || seen.has(entryKey(name))) continue
      seen.add(entryKey(name))
      insert.run(randomUUID(), s.identity.workspaceId, s.identity.ownerId, q.kind, name, r.body, r.role, position++, q.drafted_at, now)
      room--
      n++
    }
    return n
  })
  s.touch('user_context_entries')
  return written
}

export function userContextPeople(s: StoreCtx, q: { decayDays: number; limit: number; myEmails: string[] }): UserContextPerson[] {
  const now = Date.now()
  return listPeople(s, { filter: 'all', myEmails: q.myEmails })
    .flatMap((p) => {
      if (p.isSelf || !p.email) return []
      const days = Math.max(0, (now - Date.parse(p.lastSeenAt)) / DAY_MS)
      return [{ email: p.email, name: p.name, count: p.count, lastSeenAt: p.lastSeenAt, score: Math.max(1, p.count) * Math.exp(-days / q.decayDays) }]
    })
    .sort((a, b) => b.score - a.score || b.lastSeenAt.localeCompare(a.lastSeenAt))
    .slice(0, q.limit)
}

export function userContextRecordedNotes(s: StoreCtx, q: { cap: number }): number {
  const row = s.db
    .prepare(
      `SELECT count(*) AS n FROM (
         SELECT 1 FROM documents d
         WHERE d.owner_id = ? AND d.deleted_at IS NULL AND d.is_shared = 0 AND d.is_scratchpad = 0
           AND d.id NOT LIKE '${DEMO_MEETING_PREFIX}%'
           AND (d.transcript_purged_at IS NOT NULL OR EXISTS (SELECT 1 FROM transcript_chunks c WHERE c.document_id = d.id))
         LIMIT ?
       )`
    )
    .get(s.identity.ownerId, Math.max(0, Math.floor(q.cap))) as { n: number }
  return row.n
}

/**
 * `since`: the notes dated in the window, newest first. With `changedSince`, the notes edited
 * (or summarized) after that time instead, with or without a recording, most recently edited first.
 */
export function userContextDraftInputs(
  s: StoreCtx,
  q: { since: IsoTime; changedSince?: IsoTime | null; notes: number; chars: number }
): { noteId: string; title: string | null; date: IsoTime; text: string }[] {
  const base = `SELECT d.id, d.title, d.sort_epoch AS t, d.notes_md, d.notes_text FROM documents d
       WHERE d.owner_id = ? AND d.deleted_at IS NULL AND d.is_scratchpad = 0 AND d.id NOT LIKE '${DEMO_MEETING_PREFIX}%'`
  const notes = (
    q.changedSince
      ? s.db
          .prepare(
            `${base} AND (d.updated_at > ? OR EXISTS (SELECT 1 FROM note_panels p WHERE p.document_id = d.id AND p.deleted_at IS NULL AND p.updated_at > ?))
             ORDER BY d.updated_at DESC LIMIT ?`
          )
          .all(s.identity.ownerId, q.changedSince, q.changedSince, q.notes)
      : s.db.prepare(`${base} AND d.sort_epoch >= ? ORDER BY d.sort_epoch DESC LIMIT ?`).all(s.identity.ownerId, Math.floor(Date.parse(q.since) / 1000), q.notes)
  ) as Row[]
  const summary = s.db.prepare(
    `SELECT coalesce(content_markdown, generated_content) AS md FROM note_panels
     WHERE document_id = ? AND deleted_at IS NULL AND trim(coalesce(content_markdown, generated_content, '')) <> ''
     ORDER BY created_at DESC LIMIT 1`
  )
  const out: { noteId: string; title: string | null; date: IsoTime; text: string }[] = []
  let left = q.chars
  for (const n of notes) {
    if (left <= 0) break
    const md = (summary.get(n['id']) as Row | undefined)?.['md']
    const text = String((typeof md === 'string' && md.trim() ? md : (n['notes_md'] ?? n['notes_text'] ?? '')) || '').trim()
    if (!text) continue
    const clipped = text.slice(0, left)
    left -= clipped.length
    out.push({
      noteId: String(n['id']),
      title: typeof n['title'] === 'string' && n['title'] ? n['title'] : null,
      date: new Date(Number(n['t']) * 1000).toISOString(),
      text: clipped
    })
  }
  return out
}
