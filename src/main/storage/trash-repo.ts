// SPDX-License-Identifier: Apache-2.0
// Trash: the Trash list, permanent delete, the emptiness
// facts behind auto-delete, and (worker-internal) the 30-day purge, the stale-room
// cleanup and the queued file deletions.
//
// The only hard deletes in Notula are the confirmed permanent delete and the 30-day
// purge. Both purge one note per transaction and log the ids; they are
// retention the user was promised, never a wipe of user data.

import { existsSync, rmSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { TRASH_RETENTION_MS, type TrashItem } from '@shared/types/notes'
import { YDOC_ROOM_VERSION } from '@shared/types/ydoc'
import type { NoteEmptiness } from './api'
import { nowIso, parseJson } from './rows'
import { inTransaction, invalid, notFound, type StoreCtx } from './store'

const QUARANTINE_PREFIX = 'quarantine:'
/** A stored room id, with its optional quarantine prefix: `[quarantine:]<type>:<version>:<contentId>`. */
const STORED_ROOM = /^(?:quarantine:)?(notes|summary):\d+:(.+)$/

/** SQL whitespace trim: spaces, tabs and line breaks. */
const TRIM = (expr: string): string => `trim(coalesce(${expr}, ''), ' ' || char(9, 10, 13))`

/** The calendar event's summary, or NULL (a malformed event never fails the read). */
const EVENT_SUMMARY = `CASE WHEN json_valid(d.linked_event)
  THEN json_extract(d.linked_event, '$.summary') END`

/**
 * The note has its own title, non-empty and either without a calendar event
 * or different from the event's summary.
 */
const OWN_TITLE = `(${TRIM('d.title')} != '' AND (d.event_id IS NULL OR d.title IS NOT ${EVENT_SUMMARY}))`

/** The rooms of a note and its panels, with their quarantine copies. */
function noteRooms(noteId: string, panelIds: string[]): string[] {
  const rooms = [`notes:${YDOC_ROOM_VERSION}:${noteId}`, ...panelIds.map((p) => `summary:${YDOC_ROOM_VERSION}:${p}`)]
  return [...rooms, ...rooms.map((r) => QUARANTINE_PREFIX + r)]
}

/** `<tmpDir>/<noteId>`, or null when the id cannot name a folder inside `tmpDir`. */
function noteTmpPath(s: StoreCtx, noteId: string): string | null {
  const path = resolve(s.tmpDir, noteId)
  return insideTmp(s, path) ? path : null
}

function insideTmp(s: StoreCtx, path: string): boolean {
  const rel = relative(resolve(s.tmpDir), resolve(path))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

// ---------- the Trash list ----------

/**
 * Trash membership: the user's own, non-shared, deleted notes that were trashed,
 * have notes, have their own title or have a panel (deleted panels included). So a
 * note auto-deleted while empty never shows. Newest deletion first.
 */
export function listTrash(s: StoreCtx): TrashItem[] {
  const rows = s.db
    .prepare(
      `SELECT d.id, d.title, d.deleted_at, d.linked_event FROM documents d
       WHERE d.deleted_at IS NOT NULL
         AND d.owner_id = @owner AND d.workspace_id = @workspace AND d.is_shared = 0
         AND (
           d.once_trashed = 1
           OR ${TRIM('d.notes_text')} != ''
           OR ${OWN_TITLE}
           OR EXISTS (SELECT 1 FROM note_panels p WHERE p.document_id = d.id)
         )
       ORDER BY d.deleted_at DESC, d.id ASC`
    )
    .all({ owner: s.identity.ownerId, workspace: s.identity.workspaceId }) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: r['id'] as string,
    title: typeof r['title'] === 'string' ? r['title'] : null,
    deleted_at: r['deleted_at'] as string,
    linked_event: parseJson<TrashItem['linked_event']>(r['linked_event'], null)
  }))
}

// ---------- the full purge ----------

interface Purged {
  panelIds: string[]
  roomsDeleted: number
  ydocRows: number
  chunks: number
}

/**
 * Removes one note completely, inside the caller's transaction: its Yjs rows (every
 * room of the note and its panels, quarantine copies included), transcript chunks and
 * sessions, panels and the note row. The FTS rows and queue entries go with the rows
 * (migration 1 triggers). The note's temp audio folder is queued in `file_deletions`.
 * Chat threads are kept.
 */
function purgeRows(s: StoreCtx, noteId: string): Purged {
  const panelIds = (
    s.db.prepare(`SELECT id FROM note_panels WHERE document_id = ?`).all(noteId) as { id: string }[]
  ).map((r) => r.id)
  const rooms = JSON.stringify(noteRooms(noteId, panelIds))
  const roomsDeleted = (
    s.db
      .prepare(`SELECT count(DISTINCT room_id) AS n FROM ydocs WHERE room_id IN (SELECT value FROM json_each(?))`)
      .get(rooms) as { n: number }
  ).n
  const ydocRows = s.db.prepare(`DELETE FROM ydocs WHERE room_id IN (SELECT value FROM json_each(?))`).run(rooms).changes
  const chunks = s.db.prepare(`DELETE FROM transcript_chunks WHERE document_id = ?`).run(noteId).changes
  s.db.prepare(`DELETE FROM transcription_sessions WHERE document_id = ?`).run(noteId)
  s.db.prepare(`DELETE FROM note_panels WHERE document_id = ?`).run(noteId)
  // `audio_imports.note_id` has no foreign key: the import row (file name, source path) goes too.
  s.db.prepare(`DELETE FROM audio_imports WHERE note_id = ?`).run(noteId)
  // Briefs have no foreign key either. A brief on this note, or one that drew on it as a
  // source, goes too: derived text must not outlive the note.
  s.db
    .prepare(
      `DELETE FROM prep_briefs WHERE document_id = @id OR EXISTS (
         SELECT 1 FROM json_each(CASE WHEN json_valid(brief_sources) THEN brief_sources ELSE '[]' END) r
         WHERE json_extract(r.value, '$.source') = 'notula' AND json_extract(r.value, '$.id') = @id)`
    )
    .run({ id: noteId })
  s.db.prepare(`DELETE FROM documents WHERE id = @id`).run({ id: noteId })
  const tmp = noteTmpPath(s, noteId)
  if (tmp) {
    s.db
      .prepare(`INSERT INTO file_deletions (path, reason, queued_at) VALUES (?, 'note-purged', ?) ON CONFLICT (path) DO NOTHING`)
      .run(tmp, nowIso())
  }
  return { panelIds, roomsDeleted, ydocRows, chunks }
}

function touchPurged(s: StoreCtx, noteId: string, p: Purged): void {
  s.touch('documents', noteId)
  if (p.panelIds.length) s.touch('note_panels', noteId, ...p.panelIds)
  if (p.chunks) s.touch('transcript_chunks', noteId)
  if (p.ydocRows) s.touch('ydocs', noteId)
}

/**
 * The confirmed permanent delete: one transaction, only for a note in
 * Trash. Files go after the commit; a failure there is retried at the next purge.
 */
export function deleteNotePermanently(s: StoreCtx, id: string): { roomsDeleted: number } {
  const purged = inTransaction(s.db, () => {
    const row = s.db.prepare(`SELECT deleted_at FROM documents WHERE id = ?`).get(id) as
      | { deleted_at: string | null }
      | undefined
    if (!row) throw notFound('note', id)
    if (row.deleted_at === null) throw invalid('the note is not in Trash')
    return purgeRows(s, id)
  })
  touchPurged(s, id, purged)
  s.log('info', 'note-deleted-permanently', {
    id,
    panels: purged.panelIds.length,
    roomsDeleted: purged.roomsDeleted,
    ydocRows: purged.ydocRows,
    chunks: purged.chunks
  })
  processFileDeletions(s)
  return { roomsDeleted: purged.roomsDeleted }
}

// ---------- auto-delete facts ----------

/** The facts the auto-delete rules are checked against; null when the note does not exist. */
export function noteEmptiness(s: StoreCtx, id: string): NoteEmptiness | null {
  const row = s.db
    .prepare(
      `SELECT d.created_via, d.is_event_main_note, d.event_id, ${EVENT_SUMMARY} AS event_summary, d.title,
         d.notes_text, d.deleted_at,
         (SELECT count(*) FROM transcript_chunks c WHERE c.document_id = d.id) AS chunk_count,
         (SELECT count(*) FROM note_panels p WHERE p.document_id = d.id AND p.deleted_at IS NULL) AS live_panel_count
       FROM documents d WHERE d.id = ?`
    )
    .get(id) as Record<string, unknown> | undefined
  if (!row) return null
  return {
    created_via: typeof row['created_via'] === 'string' ? row['created_via'] : '',
    is_event_main_note: row['is_event_main_note'] === 1,
    event_id: typeof row['event_id'] === 'string' ? row['event_id'] : null,
    event_summary: typeof row['event_summary'] === 'string' ? row['event_summary'] : null,
    title: typeof row['title'] === 'string' ? row['title'] : null,
    chunk_count: Number(row['chunk_count'] ?? 0),
    live_panel_count: Number(row['live_panel_count'] ?? 0),
    notes_text_length: typeof row['notes_text'] === 'string' ? row['notes_text'].length : 0,
    deleted: row['deleted_at'] !== null && row['deleted_at'] !== undefined
  }
}

/** Auto-delete: only `deleted_at` and `updated_at`; `once_trashed` is untouched. */
export function markNoteDeleted(s: StoreCtx, id: string): void {
  const changes = inTransaction(s.db, () => {
    const now = nowIso()
    return s.db
      .prepare(`UPDATE documents SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL`)
      .run(now, now, id).changes
  })
  if (changes > 0) s.touch('documents', id)
  else if (!s.db.prepare(`SELECT 1 FROM documents WHERE id = ?`).get(id)) throw notFound('note', id)
}

// ---------- retention (worker-internal) ----------

const CLOCK_GAP_ACTIVITY_MS = 48 * 3600_000
const CLOCK_GAP_PURGE_MS = 25 * 3600_000

/**
 * The 30-day purge, run locally: every own, non-shared note
 * whose `deleted_at` is a valid time at least 30 × 24 h before `now`. Unparsable and
 * future times are skipped and logged. One transaction per note. The caller runs it
 * only while storage is `ready`.
 *
 * Clock guard: when `now` is more than 48 h past the newest note
 * activity and more than 25 h past the last purge, the clock may have jumped forward
 * (dead RTC battery, VM restore), so the run is skipped and logged. A correct clock
 * passes on a later run once the user has written anything.
 */
export function purgeExpiredTrash(s: StoreCtx, now: number): string[] {
  const newest = s.db.prepare(`SELECT max(updated_at) AS u, max(created_at) AS c FROM documents`).get() as {
    u: string | null
    c: string | null
  }
  const lastPurge = s.db.prepare(`SELECT value FROM meta WHERE key = 'last_trash_purge_at'`).get() as { value: string } | undefined
  const activity = Math.max(Date.parse(newest.u ?? '') || 0, Date.parse(newest.c ?? '') || 0)
  const purgedAt = Date.parse(lastPurge?.value ?? '') || 0
  if (activity > 0 && now - activity > CLOCK_GAP_ACTIVITY_MS && now - purgedAt > CLOCK_GAP_PURGE_MS) {
    s.log('warn', 'trash-purge-clock-gap', { newestActivity: new Date(activity).toISOString(), lastPurge: lastPurge?.value ?? null })
    return []
  }
  const rows = s.db
    .prepare(
      `SELECT id, deleted_at FROM documents
       WHERE deleted_at IS NOT NULL AND owner_id = ? AND workspace_id = ? AND is_shared = 0`
    )
    .all(s.identity.ownerId, s.identity.workspaceId) as { id: string; deleted_at: string }[]
  const due: string[] = []
  const skipped: { id: string; reason: string }[] = []
  for (const r of rows) {
    const at = Date.parse(r.deleted_at)
    if (Number.isNaN(at)) skipped.push({ id: r.id, reason: 'unparsable' })
    else if (at > now) skipped.push({ id: r.id, reason: 'future' })
    else if (now - at >= TRASH_RETENTION_MS) due.push(r.id)
  }
  if (skipped.length) s.log('warn', 'trash-purge-skipped', { skipped })
  const purged: string[] = []
  for (const id of due) {
    try {
      const p = inTransaction(s.db, () => purgeRows(s, id))
      touchPurged(s, id, p)
      purged.push(id)
    } catch (err) {
      s.log('error', 'trash-purge-failed', { id, err })
    }
  }
  setMeta(s, 'last_trash_purge_at', new Date(now).toISOString())
  s.log('info', 'trash-purged', { count: purged.length, ids: purged })
  return purged
}

/**
 * Stale rooms: every `notes:` / `summary:` room (and
 * its quarantine copy) whose content id matches no row at all in `documents` or
 * `note_panels`, trashed rows included. Room ids of any other shape are left alone.
 */
export function cleanupStaleRooms(s: StoreCtx): number {
  const started = Date.now()
  const rooms = (s.db.prepare(`SELECT DISTINCT room_id FROM ydocs`).all() as { room_id: string }[]).map((r) => r.room_id)
  const known = s.db.prepare(
    `SELECT EXISTS (SELECT 1 FROM documents WHERE id = @id) OR EXISTS (SELECT 1 FROM note_panels WHERE id = @id) AS known`
  )
  const stale = rooms.filter((room) => {
    const m = STORED_ROOM.exec(room)
    return m !== null && (known.get({ id: m[2] }) as { known: number }).known === 0
  })
  let rows = 0
  if (stale.length) {
    rows = inTransaction(s.db, () => {
      const del = s.db.prepare(`DELETE FROM ydocs WHERE room_id = ?`)
      let n = 0
      for (const room of stale) n += del.run(room).changes
      return n
    })
    s.touch('ydocs', ...stale)
  }
  setMeta(s, 'last_stale_room_cleanup_at', nowIso())
  s.log('info', 'cleanup-stale-ydocs-completed', { rooms: stale.length, rows, ms: Date.now() - started })
  return stale.length
}

/** The folders under `<userData>` a `rel:` entry may name. */
const REL_ROOTS = ['tmp', 'audio', 'attachments', 'dictation-audio'] as const

/**
 * `rel:<root>/<path>` → an absolute path strictly inside `<userData>/<root>`, or null for
 * an unknown root, an empty path, a NUL byte or anything that resolves outside the root.
 */
export function resolveRelPath(s: StoreCtx, path: string): string | null {
  if (!path.startsWith('rel:') || path.includes(String.fromCharCode(0))) return null
  const rest = path.slice('rel:'.length)
  const slash = rest.indexOf('/')
  if (slash <= 0) return null
  const root = rest.slice(0, slash)
  const sub = rest.slice(slash + 1)
  if (!(REL_ROOTS as readonly string[]).includes(root) || !sub) return null
  const base = resolve(s.userDataDir, root)
  const full = resolve(base, sub)
  const rel = relative(base, full)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? full : null
}

/**
 * Removes the files and folders queued by purges and by the migration-4 triggers, after
 * their commit. Two kinds of entries:
 * - older absolute paths, which must lie inside `<userData>/tmp`;
 * - `rel:<root>/<path>` entries, resolved under `<userData>/<root>` for the roots
 *   `tmp`, `audio`, `attachments` and `dictation-audio`.
 * Anything else is never touched: its row is dropped and logged. A failure is counted and
 * retried at the next run (the next deleting call or the next purge). A blob whose row is
 * gone is unreadable even if its file survives, because its key went with the row.
 */
export function processFileDeletions(s: StoreCtx): void {
  const rows = s.db.prepare(`SELECT path, attempts FROM file_deletions ORDER BY queued_at`).all() as {
    path: string
    attempts: number
  }[]
  for (const r of rows) {
    const target = r.path.startsWith('rel:') ? resolveRelPath(s, r.path) : insideTmp(s, r.path) ? r.path : null
    if (!target) {
      s.log('error', 'file-deletion-refused', { path: r.path })
      s.db.prepare(`DELETE FROM file_deletions WHERE path = ?`).run(r.path)
      continue
    }
    try {
      if (existsSync(target)) rmSync(target, { recursive: true, force: true, maxRetries: 2 })
      s.db.prepare(`DELETE FROM file_deletions WHERE path = ?`).run(r.path)
    } catch (err) {
      s.db.prepare(`UPDATE file_deletions SET attempts = attempts + 1 WHERE path = ?`).run(r.path)
      s.log('warn', 'file-deletion-failed', { path: r.path, attempts: r.attempts + 1, err })
    }
  }
}

/** Rooms holding quarantined rows (StorageStatus.damagedRooms), counted at open. */
export function countDamagedRooms(s: StoreCtx): number {
  return (
    s.db.prepare(`SELECT count(DISTINCT room_id) AS n FROM ydocs WHERE room_id GLOB 'quarantine:*'`).get() as { n: number }
  ).n
}

function setMeta(s: StoreCtx, key: string, value: string): void {
  s.db
    .prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value`)
    .run(key, value)
}

/** `<userData>/tmp`, from the database folder `<userData>/data`. */
export function tmpDirFor(dataDir: string): string {
  return join(dataDir, '..', 'tmp')
}

/** `<userData>`, from the database folder `<userData>/data`. */
export function userDataDirFor(dataDir: string): string {
  return resolve(dataDir, '..')
}
