// SPDX-License-Identifier: Apache-2.0
// The `documents` table: notes CRUD, the listable scope and per-event dedupe, and the
// main-only fields.

import { randomUUID } from 'node:crypto'
import type { IsoTime } from '@shared/types/common'
import { MY_NOTES_SECTION_ID } from '@shared/types/folders'
import type {
  AttachedLink,
  CreationSource,
  Note,
  NoteCreateInput,
  NoteListItem,
  NoteListPage,
  NotePatch,
  NotesListQuery
} from '@shared/types/notes'
import type { NoteQuery } from './api'
import { NOTE_COLUMNS, NOTE_LIST_COLUMNS, nowIso, toJson, toNote, toNoteListItem } from './rows'
import { inTransaction, invalid, notFound, type StoreCtx } from './store'

const COLS = NOTE_COLUMNS.join(', ')

const MAX_QUERY_IDS = 1_000

function unixSeconds(iso: unknown, what: string): number | null {
  if (iso === undefined || iso === null) return null
  const ms = typeof iso === 'string' ? Date.parse(iso) : NaN
  if (Number.isNaN(ms)) throw invalid(`${what} is not a valid time`)
  return Math.floor(ms / 1000)
}

/**
 * Reads for chat, templates and search: the user's own, not deleted,
 * not shared notes, by display time. `from` and `to` are inclusive bounds on the
 * display time; `ids` keeps only those notes; no dedupe and no listable-scope filter.
 */
export function queryNotes(s: StoreCtx, q: NoteQuery): NoteListItem[] {
  if (typeof q !== 'object' || q === null) throw invalid('query must be an object')
  let ids: string[] | null = null
  if (q.ids !== undefined) {
    if (!Array.isArray(q.ids) || q.ids.some((i) => typeof i !== 'string')) throw invalid('ids must be strings')
    if (q.ids.length > MAX_QUERY_IDS) throw invalid(`at most ${MAX_QUERY_IDS} ids`)
    if (q.ids.length === 0) return []
    ids = q.ids
  }
  const limit = q.limit === undefined ? -1 : Math.max(0, Math.floor(Number(q.limit)))
  if (Number.isNaN(limit)) throw invalid('limit must be a number')
  const order = q.order === 'oldest' ? 'ASC' : 'DESC'
  const rows = s.db
    .prepare(
      `SELECT ${NOTE_LIST_COLUMNS.join(', ')} FROM documents
       WHERE deleted_at IS NULL AND owner_id = @owner AND workspace_id = @workspace AND is_shared = 0
         AND (@ids IS NULL OR id IN (SELECT value FROM json_each(@ids)))
         AND (@from IS NULL OR sort_epoch >= @from)
         AND (@to IS NULL OR sort_epoch <= @to)
       ORDER BY sort_epoch ${order}, id ASC
       LIMIT @limit`
    )
    .all({
      owner: s.identity.ownerId,
      workspace: s.identity.workspaceId,
      ids: ids ? JSON.stringify(ids) : null,
      from: unixSeconds(q.from, 'from'),
      to: unixSeconds(q.to, 'to'),
      limit
    }) as Record<string, unknown>[]
  return rows.map(toNoteListItem)
}

/** Creation sources that make a note listable on their own. */
const LISTABLE_SOURCES = ['macOS', 'Windows', 'desktop', 'shared_tab']

/** The listable scope: own, not deleted, a listable source or a live panel. */
const LISTABLE = `
  d.deleted_at IS NULL
  AND d.owner_id = @owner AND d.workspace_id = @workspace
  AND (
    d.created_via IS NULL OR d.created_via = ''
    OR d.created_via IN (${LISTABLE_SOURCES.map((s) => `'${s}'`).join(', ')})
    OR EXISTS (SELECT 1 FROM note_panels p WHERE p.document_id = d.id AND p.deleted_at IS NULL)
  )`

/** Renderer-writable columns and how each is encoded (NotePatch). */
const PATCH_COLUMNS: { [K in keyof Required<NotePatch>]: (v: NotePatch[K]) => unknown } = {
  title: (v) => v ?? null,
  notes: (v) => toJson(v) ?? null,
  notes_text: (v) => v ?? null,
  notes_md: (v) => v ?? null,
  private_notes_visible: (v) => (v ? 1 : 0),
  people: (v) => toJson(v) ?? null,
  linked_event: (v) => toJson(v) ?? null,
  counts_as_meeting: (v) => (v === null || v === undefined ? null : v ? 1 : 0)
}

export function getNote(s: StoreCtx, id: string, opts?: { includeDeleted?: boolean }): Note | null {
  const row = s.db
    .prepare(`SELECT ${COLS} FROM documents WHERE id = ? AND (deleted_at IS NULL OR ?)`)
    .get(id, opts?.includeDeleted ? 1 : 0) as Record<string, unknown> | undefined
  return row ? toNote(row) : null
}

function requireNote(s: StoreCtx, id: string): Note {
  const note = getNote(s, id, { includeDeleted: true })
  if (!note) throw notFound('note', id)
  return note
}

export function listNotes(s: StoreCtx, q: NotesListQuery): NoteListPage {
  const limit = q.limit === undefined ? -1 : Math.max(0, Math.floor(q.limit))
  const exclude = JSON.stringify(q.excludeEventTimes ?? [])
  // The folder, id and own-only filters narrow the listable
  // scope before the dedupe, so a folder or a search page dedupes among its own notes.
  // `my-notes` is the "My notes" section: no folder filter.
  const folderId = q.folderId && q.folderId !== MY_NOTES_SECTION_ID ? q.folderId : null
  const ids = q.ids ? JSON.stringify(q.ids) : null
  // Dedupe one note per (iCalUID or event id, display time): the primary event
  // note first, then the user's own, then the lowest id. Notes without an event
  // are never deduped.
  const rows = s.db
    .prepare(
      `WITH listable AS (
         SELECT d.*,
           CASE WHEN d.event_id IS NULL THEN NULL
                ELSE coalesce(json_extract(d.linked_event, '$.iCalUID'), d.event_id) END AS dedupe_event
         FROM documents d
         WHERE ${LISTABLE}
           AND (@folderId IS NULL OR EXISTS (
             SELECT 1 FROM folder_notes fn WHERE fn.folder_id = @folderId AND fn.note_id = d.id
           ))
           AND (@ids IS NULL OR d.id IN (SELECT value FROM json_each(@ids)))
           AND (@ownOnly = 0 OR (d.owner_id = @owner AND d.is_shared = 0))
           AND (@tags IS NULL OR NOT EXISTS (
             SELECT 1 FROM json_each(@tags) f
             WHERE NOT EXISTS (
               SELECT 1 FROM document_tags t
               WHERE t.document_id = d.id AND t.category = json_extract(f.value, '$.category')
                 AND EXISTS (
                   SELECT 1 FROM json_each(json_extract(f.value, '$.values')) v
                   WHERE (v.type = 'null' AND t.value IS NULL) OR (v.type = 'text' AND t.value = v.value)
                 )
             )
           ))
       ),
       ranked AS (
         SELECT *,
           CASE WHEN dedupe_event IS NULL THEN 1 ELSE row_number() OVER (
             PARTITION BY dedupe_event, sort_epoch
             ORDER BY is_event_main_note DESC, (owner_id = @owner) DESC, id ASC
           ) END AS dedupe_rank
         FROM listable
       )
       SELECT ${NOTE_LIST_COLUMNS.join(', ')} FROM ranked r
       WHERE dedupe_rank = 1
         AND NOT EXISTS (
           SELECT 1 FROM json_each(@exclude) x
           WHERE r.event_id = json_extract(x.value, '$.eventId')
             AND r.sort_epoch = json_extract(x.value, '$.displayTimeUnixSeconds')
         )
       ORDER BY sort_epoch DESC, id ASC
       LIMIT @limit`
    )
    .all({
      owner: s.identity.ownerId,
      workspace: s.identity.workspaceId,
      exclude,
      folderId,
      ids,
      ownOnly: q.ownOnly ? 1 : 0,
      // Every filter must match (validated in notes/validate.ts).
      tags: q.tags && q.tags.length ? JSON.stringify(q.tags.map((t) => ({ category: t.category, values: t.values }))) : null,
      limit: limit < 0 ? -1 : limit + 1
    }) as Record<string, unknown>[]
  const hasMore = limit >= 0 && rows.length > limit
  return { items: (hasMore ? rows.slice(0, limit) : rows).map(toNoteListItem), hasMore }
}

export function createNote(s: StoreCtx, input: NoteCreateInput & { created_via: CreationSource }): Note {
  const id = randomUUID()
  const now = nowIso()
  inTransaction(s.db, () => {
    s.db
      .prepare(
        `INSERT INTO documents (id, workspace_id, owner_id, created_at, updated_at, title, type,
           created_via, transcribe, notes, linked_event, tags, is_shared)
         VALUES (@id, @workspace, @owner, @now, @now, @title, 'meeting',
           @source, @transcribe, @notes, @event, '[]', 0)`
      )
      .run({
        id,
        workspace: s.identity.workspaceId,
        owner: s.identity.ownerId,
        now,
        title: input.title ?? null,
        source: input.created_via,
        transcribe: input.transcribe === false ? 0 : 1,
        notes: toJson(input.notes) ?? null,
        event: toJson(input.calendarEvent) ?? null
      })
  })
  s.touch('documents', id)
  return requireNote(s, id)
}

/** Main-only note fields `updateNote` also takes (never from a renderer patch: notes/validate.ts rebuilds those). */
export interface MainNoteFields {
  /** The note's attached links. */
  saved_links?: AttachedLink[]
}

const MAX_LINKS = 200

function attachedLinks(v: unknown): string {
  if (!Array.isArray(v) || v.length > MAX_LINKS) throw invalid('saved_links is invalid')
  const out: AttachedLink[] = []
  for (const l of v) {
    const link = (typeof l === 'object' && l !== null ? l : {}) as Partial<AttachedLink>
    if (
      typeof link.url !== 'string' ||
      !/^https:\/\//i.test(link.url) ||
      link.url.length > 2_048 ||
      typeof link.label !== 'string' ||
      link.label.length > 500 ||
      (link.status !== 'added' && link.status !== 'dismissed')
    ) {
      throw invalid('saved_links is invalid')
    }
    if (!out.some((x) => x.url === link.url)) out.push({ url: link.url, label: link.label, status: link.status })
  }
  return JSON.stringify(out)
}

export function updateNote(s: StoreCtx, id: string, patch: NotePatch & MainNoteFields): Note {
  const sets: string[] = []
  const params: Record<string, unknown> = { id, now: nowIso() }
  for (const key of Object.keys(PATCH_COLUMNS) as (keyof NotePatch)[]) {
    if (!Object.hasOwn(patch, key) || patch[key] === undefined) continue
    const encode = PATCH_COLUMNS[key] as (v: unknown) => unknown
    sets.push(`${key} = @${key}`)
    params[key] = encode(patch[key])
  }
  if (Object.hasOwn(patch, 'saved_links') && patch.saved_links !== undefined) {
    sets.push('saved_links = @saved_links')
    params['saved_links'] = attachedLinks(patch.saved_links)
  }
  if (sets.length === 0) return requireNote(s, id)
  const changes = inTransaction(
    s.db,
    () => s.db.prepare(`UPDATE documents SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params).changes
  )
  if (changes === 0) throw notFound('note', id)
  s.touch('documents', id)
  return requireNote(s, id)
}

export function trashNote(s: StoreCtx, id: string): void {
  requireNote(s, id)
  const now = nowIso()
  const changes = inTransaction(
    s.db,
    () =>
      s.db
        .prepare(
          `UPDATE documents SET deleted_at = ?, updated_at = ?, once_trashed = 1 WHERE id = ? AND deleted_at IS NULL`
        )
        .run(now, now, id).changes
  )
  if (changes > 0) s.touch('documents', id)
}

export function restoreNote(s: StoreCtx, id: string): void {
  requireNote(s, id)
  const changes = inTransaction(
    s.db,
    () =>
      s.db
        .prepare(
          `UPDATE documents SET deleted_at = NULL, updated_at = ?, once_trashed = 0 WHERE id = ? AND deleted_at IS NOT NULL`
        )
        .run(nowIso(), id).changes
  )
  if (changes > 0) s.touch('documents', id)
}

/**
 * The user's existing note for a calendar event (the narrower rule): listable, own, not
 * shared, type meeting, not the
 * primary event note, same event id and (when given) the same display time as the
 * event start; the oldest wins.
 */
export function findNoteByEvent(s: StoreCtx, eventId: string, startTime?: IsoTime): Note | null {
  let start: number | null = null
  if (startTime !== undefined) {
    const ms = Date.parse(startTime)
    if (Number.isNaN(ms)) throw invalid('startTime is not a valid time')
    start = Math.floor(ms / 1000)
  }
  const row = s.db
    .prepare(
      `SELECT ${NOTE_COLUMNS.map((c) => `d.${c}`).join(', ')} FROM documents d
       WHERE ${LISTABLE}
         AND d.event_id = @eventId
         AND (@start IS NULL OR d.sort_epoch = @start)
         AND d.is_shared = 0 AND d.type = 'meeting' AND d.is_event_main_note = 0
       ORDER BY d.created_at ASC, d.id ASC
       LIMIT 1`
    )
    .get({ owner: s.identity.ownerId, workspace: s.identity.workspaceId, eventId, start }) as
    | Record<string, unknown>
    | undefined
  return row ? toNote(row) : null
}

export function setTranscribe(s: StoreCtx, id: string, value: boolean): void {
  const changes = inTransaction(
    s.db,
    () =>
      s.db
        .prepare(`UPDATE documents SET transcribe = ?, updated_at = ? WHERE id = ? AND transcribe != ?`)
        .run(value ? 1 : 0, nowIso(), id, value ? 1 : 0).changes
  )
  if (changes > 0) s.touch('documents', id)
  else requireNote(s, id)
}

export function incrementMeetingEndCount(s: StoreCtx, id: string): number {
  const row = inTransaction(
    s.db,
    () =>
      s.db
        .prepare(
          `UPDATE documents SET ended_count = ended_count + 1, updated_at = ? WHERE id = ?
           RETURNING ended_count`
        )
        .get(nowIso(), id) as { ended_count: number } | undefined
  )
  if (!row) throw notFound('note', id)
  s.touch('documents', id)
  return row.ended_count
}

/** Startup housekeeping: capture never resumes on its own after a restart. */
export function resetTranscribeFlags(s: StoreCtx): number {
  const ids = inTransaction(s.db, () =>
    (
      s.db
        .prepare(`UPDATE documents SET transcribe = 0, updated_at = ? WHERE transcribe = 1 RETURNING id`)
        .all(nowIso()) as { id: string }[]
    ).map((r) => r.id)
  )
  if (ids.length) s.touch('documents', ...ids)
  return ids.length
}
