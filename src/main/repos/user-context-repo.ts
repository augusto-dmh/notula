// SPDX-License-Identifier: Apache-2.0
// User context: the storage-worker side of its StorageApi group. Worker-safe: no Electron imports.
//
// - Sections: one row per (owner, section id), Markdown, at most 4,000 characters.
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
  type UserContextPerson,
  type UserContextSection,
  type UserContextSectionId
} from '@shared/types/user-context'
import { listPeople } from '../storage/people-repo'
import { nowIso } from '../storage/rows'
import { inTransaction, invalid, type StoreCtx } from '../storage/store'

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

export function userContextDraftInputs(s: StoreCtx, q: { since: IsoTime; notes: number; chars: number }): { noteId: string; title: string | null; date: IsoTime; text: string }[] {
  const notes = s.db
    .prepare(
      `SELECT d.id, d.title, d.sort_epoch AS t, d.notes_md, d.notes_text FROM documents d
       WHERE d.owner_id = ? AND d.deleted_at IS NULL AND d.is_scratchpad = 0 AND d.id NOT LIKE '${DEMO_MEETING_PREFIX}%'
         AND d.sort_epoch >= ?
       ORDER BY d.sort_epoch DESC LIMIT ?`
    )
    .all(s.identity.ownerId, Math.floor(Date.parse(q.since) / 1000), q.notes) as Row[]
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
