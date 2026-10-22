// SPDX-License-Identifier: Apache-2.0
// Prep briefs: `prep_briefs`
// (no note FK: briefs outlive cited notes) and the brief's context query.
//
// briefContext: notes that are not trashed, not scratchpads and not demo notes, dated before
// the event, in three groups: 1 = the same external people (the note's people or invite) or an
// earlier instance of the same series; 2 = people on the same company domains; 3 = FTS mentions
// of an attendee's name or company in titles, notes and summaries. Newest first per group, at
// most `limit` notes, each with its summary text (else the user's notes) cut to `perNoteChars`.

import type { BriefReference, BriefStatus, BriefStep, PrepBrief } from '@shared/types/briefs'
import { DEMO_MEETING_PREFIX } from '@shared/types/notes'
import type { BriefContextNote, BriefContextQuery, PrepBriefUpsert } from './api'
import { nowIso, parseJson } from './rows'
import { invalid, type StoreCtx } from './store'

type Row = Record<string, unknown>

const STATUSES: readonly BriefStatus[] = ['generating', 'streaming', 'completed', 'error']
const MAX_CONTENT = 100_000
const MAX_TEXT = 4_000
const MAX_STEPS = 500
const MAX_TERMS = 40

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function toBrief(r: Row): PrepBrief {
  const steps = parseJson<unknown>(r['steps'], [])
  const refs = parseJson<unknown>(r['brief_sources'], [])
  const signal = r['worth_showing']
  return {
    id: r['id'] as string,
    event_id: r['event_id'] as string,
    document_id: str(r['document_id']),
    status: r['status'] as BriefStatus,
    headline: str(r['headline']),
    content: str(r['content']),
    brief_sources: Array.isArray(refs) ? (refs as BriefReference[]) : [],
    worth_showing: signal === null || signal === undefined ? null : Number(signal) === 1,
    steps: Array.isArray(steps) ? (steps as BriefStep[]) : [],
    error_message: str(r['error_message']),
    auto_opened: Number(r['auto_opened']) === 1,
    dismissed_at: str(r['dismissed_at']),
    created_at: r['created_at'] as string,
    updated_at: r['updated_at'] as string
  }
}

export function getBrief(s: StoreCtx, eventId: string): PrepBrief | null {
  if (typeof eventId !== 'string' || !eventId || eventId.length > 1_000) throw invalid('eventId is invalid')
  const row = s.db
    .prepare(`SELECT * FROM prep_briefs WHERE event_id = ?`)
    .get(eventId) as Row | undefined
  return row ? toBrief(row) : null
}

function textOrNull(v: unknown, what: string, max: number): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') throw invalid(`${what} is invalid`)
  return v.slice(0, max)
}

export function upsertBrief(s: StoreCtx, b: PrepBriefUpsert): PrepBrief {
  if (typeof b !== 'object' || b === null) throw invalid('brief must be an object')
  if (typeof b.id !== 'string' || !b.id || b.id.length > 64) throw invalid('id is invalid')
  if (typeof b.event_id !== 'string' || !b.event_id || b.event_id.length > 1_000) throw invalid('event_id is invalid')
  if (!STATUSES.includes(b.status)) throw invalid('status is invalid')
  if (!Array.isArray(b.steps) || !Array.isArray(b.brief_sources)) throw invalid('steps and references must be lists')
  const now = nowIso()
  const params = {
    id: b.id,
    workspace: s.identity.workspaceId,
    owner: s.identity.ownerId,
    eventId: b.event_id,
    documentId: textOrNull(b.document_id, 'document_id', 200),
    status: b.status,
    headline: textOrNull(b.headline, 'headline', MAX_TEXT),
    content: textOrNull(b.content, 'content', MAX_CONTENT),
    refs: JSON.stringify(b.brief_sources.slice(0, 50)),
    signal: b.worth_showing === null ? null : b.worth_showing ? 1 : 0,
    steps: JSON.stringify(b.steps.slice(-MAX_STEPS)),
    errorMessage: textOrNull(b.error_message, 'error_message', MAX_TEXT),
    autoOpened: b.auto_opened ? 1 : 0,
    dismissedAt: textOrNull(b.dismissed_at, 'dismissed_at', 64),
    now
  }
  s.db
    .prepare(
      `INSERT INTO prep_briefs (id, workspace_id, owner_id, event_id, document_id, status, headline, content,
         brief_sources, worth_showing, steps, error_message, auto_opened, dismissed_at, created_at, updated_at)
       VALUES (@id, @workspace, @owner, @eventId, @documentId, @status, @headline, @content,
         @refs, @signal, @steps, @errorMessage, @autoOpened, @dismissedAt, @now, @now)
       ON CONFLICT (event_id) DO UPDATE SET
         document_id = excluded.document_id, status = excluded.status, headline = excluded.headline,
         content = excluded.content, brief_sources = excluded.brief_sources, worth_showing = excluded.worth_showing,
         steps = excluded.steps, error_message = excluded.error_message,
         auto_opened = excluded.auto_opened, dismissed_at = excluded.dismissed_at, updated_at = excluded.updated_at`
    )
    .run(params)
  return getBrief(s, b.event_id) as PrepBrief
}

// ---------- context ----------

const NOT_DEMO = `d.id NOT LIKE '${DEMO_MEETING_PREFIX}%' AND coalesce(d.event_id, '') NOT LIKE '${DEMO_MEETING_PREFIX}%'`
const LISTABLE = `d.deleted_at IS NULL AND d.is_scratchpad = 0 AND ${NOT_DEMO} AND d.sort_epoch < ?`

/**
 * A predicate over every email on the note: its people (creator and attendees) and its invite's
 * attendees and organizer. `test(expr)` is the SQL test for one lower-cased email expression;
 */
function anyNoteEmail(test: (expr: string) => string): string {
  const e = (json: string): string => `lower(trim(${json}))`
  return `(
    EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(d.people) THEN json_extract(d.people, '$.attendees') END) a WHERE ${test(e(`json_extract(a.value, '$.email')`))})
    OR (json_valid(d.people) AND ${test(e(`json_extract(d.people, '$.creator.email')`))})
    OR EXISTS (SELECT 1 FROM json_each(CASE WHEN json_valid(d.linked_event) THEN json_extract(d.linked_event, '$.attendees') END) v WHERE ${test(e(`json_extract(v.value, '$.email')`))})
    OR (json_valid(d.linked_event) AND ${test(e(`json_extract(d.linked_event, '$.organizer.email')`))})
  )`
}

/** The parameters of `anyNoteEmail`, repeated for its four sources. */
function times4<T>(list: T[]): T[] {
  return [...list, ...list, ...list, ...list]
}

function terms(list: readonly string[]): string[] {
  const out = new Set<string>()
  for (const t of list) {
    const v = typeof t === 'string' ? t.trim().toLowerCase() : ''
    if (v && v.length <= 320) out.add(v)
    if (out.size >= MAX_TERMS) break
  }
  return [...out]
}

/** An FTS5 phrase for the trigram index (≥ 3 characters), quotes doubled. */
function phrase(t: string): string | null {
  const v = t.trim()
  return v.length >= 3 ? `"${v.replace(/"/g, '""')}"` : null
}

function noteText(s: StoreCtx, d: Row, max: number): string {
  const panel = s.db
    .prepare(
      `SELECT content_markdown FROM note_panels WHERE document_id = ? AND deleted_at IS NULL
         AND content_markdown IS NOT NULL AND trim(content_markdown) <> ''
       ORDER BY coalesce(content_edited_at, updated_at) DESC LIMIT 1`
    )
    .get(d['id']) as { content_markdown: string } | undefined
  const text = panel?.content_markdown ?? str(d['notes_md']) ?? str(d['notes_text']) ?? ''
  return text.trim().slice(0, max)
}

function attendeesOf(d: Row): string[] {
  const people = parseJson<{ attendees?: { name?: unknown; email?: unknown }[] } | null>(d['people'], null)
  const out: string[] = []
  for (const a of Array.isArray(people?.attendees) ? people.attendees : []) {
    const name = typeof a?.name === 'string' ? a.name.trim() : ''
    const email = typeof a?.email === 'string' ? a.email.trim() : ''
    if (name || email) out.push(name && email ? `${name} <${email}>` : name || email)
  }
  return out.slice(0, 30)
}

export function briefContext(s: StoreCtx, q: BriefContextQuery): BriefContextNote[] {
  if (typeof q !== 'object' || q === null) throw invalid('query must be an object')
  const startMs = Date.parse(q.eventStart)
  if (Number.isNaN(startMs)) throw invalid('eventStart must be an ISO time')
  const before = Math.floor(startMs / 1000)
  const limit = Math.max(1, Math.min(50, Math.floor(q.limit) || 8))
  const perNote = Math.max(100, Math.min(20_000, Math.floor(q.perNoteChars) || 2_000))
  const emails = terms(q.externalEmails)
  const domains = terms(q.domains).filter((d) => /^[a-z0-9.-]+$/.test(d))
  const seriesId = typeof q.seriesId === 'string' && q.seriesId ? q.seriesId : null

  const picked = new Map<string, { row: Row; group: 1 | 2 | 3 }>()
  const take = (rows: Row[], group: 1 | 2 | 3): void => {
    for (const r of rows) {
      const id = r['id'] as string
      if (!picked.has(id)) picked.set(id, { row: r, group })
    }
  }
  const order = `ORDER BY d.sort_epoch DESC LIMIT ${limit}`

  // 1. Same people, or earlier instances of the same series.
  const g1: string[] = []
  const g1Params: unknown[] = [before]
  if (emails.length > 0) {
    g1.push(anyNoteEmail((x) => `${x} IN (${emails.map(() => '?').join(', ')})`))
    g1Params.push(...times4(emails))
  }
  if (seriesId) {
    g1.push(`(json_valid(d.linked_event) AND json_extract(d.linked_event, '$.recurringEventId') = ?)`)
    g1Params.push(seriesId)
  }
  if (g1.length > 0) take(s.db.prepare(`SELECT d.* FROM documents d WHERE ${LISTABLE} AND (${g1.join(' OR ')}) ${order}`).all(...g1Params) as Row[], 1)

  // 2. Same companies.
  if (picked.size < limit && domains.length > 0) {
    const clause = anyNoteEmail((x) => `(${domains.map(() => `${x} LIKE ?`).join(' OR ')})`)
    take(
      s.db
        .prepare(`SELECT d.* FROM documents d WHERE ${LISTABLE} AND ${clause} ${order}`)
        .all(before, ...times4(domains.map((dom) => `%@${dom}`))) as Row[],
      2
    )
  }

  // 3. Mentions of names and companies (trigram FTS in titles, notes and summaries).
  if (picked.size < limit) {
    const phrases = [...terms(q.names), ...terms(q.companyNames)].map(phrase).filter((p): p is string => p !== null)
    if (phrases.length > 0) {
      const match = phrases.join(' OR ')
      try {
        take(
          s.db
            .prepare(
              `SELECT d.* FROM documents d WHERE ${LISTABLE} AND d.id IN (
                 SELECT document_id FROM documents_fts WHERE documents_fts MATCH ?
                 UNION SELECT document_id FROM note_panels_fts WHERE note_panels_fts MATCH ?
               ) ${order}`
            )
            .all(before, match, match) as Row[],
          3
        )
      } catch {
        // A query the FTS parser refuses only drops group 3.
      }
    }
  }

  const byGroup = [...picked.values()].sort(
    (a, b) => a.group - b.group || Number(b.row['sort_epoch']) - Number(a.row['sort_epoch'])
  )
  return byGroup.slice(0, limit).map(({ row, group }) => ({
    id: row['id'] as string,
    title: str(row['title']),
    date: new Date(Number(row['sort_epoch']) * 1000).toISOString(),
    attendees: attendeesOf(row),
    text: noteText(s, row, perNote),
    group
  }))
}
