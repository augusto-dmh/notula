// SPDX-License-Identifier: Apache-2.0
// The calendar tables: `calendar_sources`, `calendars` and the
// `calendar_events` cache, the display dedupe, Coming up, the note follow-up and the
// known participants. Feed URLs and tokens are secrets, never rows.
//
// The cache is remote data that can be fetched again, so a hidden calendar's or a
// removed source's events and calendars are deleted outright; the source row itself
// is soft-deleted.

import { mentionsConferenceDomain } from '@shared/lib/conference'
import { isResourceEmail } from '@shared/lib/people'
import type {
  CalendarErrorType,
  CalendarGrant,
  CalendarInfo,
  CalendarSourceKind,
  Participant,
  UpcomingEvent,
  UpcomingPage
} from '@shared/types/calendar'
import { CALENDAR_COLOR_DEFAULT, UPCOMING_PAGE } from '@shared/types/calendar'
import type { IsoTime } from '@shared/types/common'
import type { CalendarAttendee, CalendarEvent, NotePeople } from '@shared/types/notes'
import type { CalendarSourceRow } from './api'
import { nowIso, parseJson } from './rows'
import { inTransaction, invalid, notFound, StoreError, type StoreCtx } from './store'

type Row = Record<string, unknown>

const KINDS: readonly CalendarSourceKind[] = ['ics', 'google', 'microsoft']
const STATUSES: readonly CalendarSourceRow['status'][] = ['ok', 'syncing', 'error']
/** Source errors that put Coming up and Settings into the "link your calendar" state. */
const CALENDAR_ERROR_TYPES: readonly CalendarErrorType[] = ['missing_token', 'missing_scopes', 'calendar_list_failed', 'invalid_feed']
const MAX_EVENTS_PER_WRITE = 50_000
const MAX_PARTICIPANT_QUERY = 200

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/** The incremental grants a source holds. */
const GRANTS: readonly CalendarGrant[] = ['calendar-write', 'mail-read', 'mail-send', 'files-read']
const grantsOf = (v: unknown): CalendarGrant[] =>
  (Array.isArray(parseJson<unknown>(v, [])) ? (parseJson<unknown>(v, []) as unknown[]) : []).filter((g): g is CalendarGrant => GRANTS.includes(g as CalendarGrant))

// ---------- sources ----------

function toSource(r: Row): CalendarSourceRow {
  return {
    id: r['id'] as string,
    kind: r['kind'] as CalendarSourceKind,
    label: r['label'] as string,
    accountEmail: strOrNull(r['account_email']),
    myEmail: strOrNull(r['my_email']),
    urlHost: strOrNull(r['url_host']),
    insecure: r['insecure'] === 1,
    status: (STATUSES as readonly unknown[]).includes(r['status']) ? (r['status'] as CalendarSourceRow['status']) : 'ok',
    errorType: strOrNull(r['error_type']) as CalendarErrorType | null,
    lastSyncedAt: strOrNull(r['last_synced_at']),
    lastError: strOrNull(r['last_error']),
    createdAt: r['created_at'] as string,
    httpEtag: strOrNull(r['http_etag']),
    httpLastModified: strOrNull(r['http_last_modified']),
    grants: grantsOf(r['grants'])
  }
}

function sourceRow(s: StoreCtx, id: string): (CalendarSourceRow & { deleted: boolean }) | null {
  const r = s.db
    .prepare(`SELECT * FROM calendar_sources WHERE id = ? AND owner_id = ? AND workspace_id = ?`)
    .get(id, s.identity.ownerId, s.identity.workspaceId) as Row | undefined
  return r ? { ...toSource(r), deleted: r['deleted_at'] !== null } : null
}

/** The held grants, read from the token response's granted scopes. */
export function setCalendarSourceGrants(s: StoreCtx, sourceId: string, grants: CalendarGrant[]): void {
  const clean = GRANTS.filter((g) => grants.includes(g))
  const changes = s.db
    .prepare(`UPDATE calendar_sources SET grants = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND workspace_id = ? AND deleted_at IS NULL`)
    .run(JSON.stringify(clean), nowIso(), sourceId, s.identity.ownerId, s.identity.workspaceId).changes
  if (changes === 0) throw notFound('calendar source', sourceId)
  s.touch('calendar_sources', sourceId)
}

/** Not deleted, oldest first. */
export function listCalendarSources(s: StoreCtx): CalendarSourceRow[] {
  const rows = s.db
    .prepare(
      `SELECT * FROM calendar_sources WHERE owner_id = ? AND workspace_id = ? AND deleted_at IS NULL
       ORDER BY created_at ASC, id ASC`
    )
    .all(s.identity.ownerId, s.identity.workspaceId) as Row[]
  return rows.map(toSource)
}

/** Inserts or updates by id. A soft-deleted source is never brought back: it is returned as stored. */
export function upsertCalendarSource(s: StoreCtx, src: CalendarSourceRow): CalendarSourceRow {
  if (!src || typeof src.id !== 'string' || !src.id) throw invalid('source id is required')
  if (!KINDS.includes(src.kind)) throw invalid('unknown source kind')
  if (!STATUSES.includes(src.status)) throw invalid('unknown source status')
  if (typeof src.label !== 'string') throw invalid('label must be a string')
  const now = nowIso()
  const changes = inTransaction(
    s.db,
    () =>
      s.db
        .prepare(
          `INSERT INTO calendar_sources (id, workspace_id, owner_id, kind, label, account_email, my_email, url_host,
             insecure, status, error_type, last_synced_at, last_error, http_etag, http_last_modified, created_at, updated_at)
           VALUES (@id, @workspace, @owner, @kind, @label, @accountEmail, @myEmail, @urlHost,
             @insecure, @status, @errorType, @lastSyncedAt, @lastError, @httpEtag, @httpLastModified, @createdAt, @now)
           ON CONFLICT (id) DO UPDATE SET
             label = excluded.label, account_email = excluded.account_email, my_email = excluded.my_email,
             url_host = excluded.url_host, insecure = excluded.insecure, status = excluded.status,
             error_type = excluded.error_type, last_synced_at = excluded.last_synced_at, last_error = excluded.last_error,
             http_etag = excluded.http_etag, http_last_modified = excluded.http_last_modified, updated_at = excluded.updated_at
           WHERE calendar_sources.deleted_at IS NULL AND calendar_sources.kind = excluded.kind`
        )
        .run({
          id: src.id,
          workspace: s.identity.workspaceId,
          owner: s.identity.ownerId,
          kind: src.kind,
          label: src.label.slice(0, 500),
          accountEmail: src.accountEmail ?? null,
          myEmail: src.myEmail ?? null,
          urlHost: src.urlHost ?? null,
          insecure: src.insecure ? 1 : 0,
          status: src.status,
          errorType: src.errorType ?? null,
          lastSyncedAt: src.lastSyncedAt ?? null,
          lastError: src.lastError ? src.lastError.slice(0, 1_000) : null,
          httpEtag: src.httpEtag ?? null,
          httpLastModified: src.httpLastModified ?? null,
          createdAt: src.createdAt || now,
          now
        }).changes
  )
  if (changes > 0) s.touch('calendar_sources', src.id)
  const row = sourceRow(s, src.id)
  if (!row) throw new StoreError('internal', 'calendar source vanished')
  const { deleted: _deleted, ...out } = row
  return out
}

/** Soft-deletes the source; hard-deletes its calendars and events. */
export function removeCalendarSource(s: StoreCtx, id: string): { eventsDeleted: number } {
  const src = sourceRow(s, id)
  if (!src || src.deleted) throw notFound('calendar source', id)
  const now = nowIso()
  const { events, calendarIds } = inTransaction(s.db, () => {
    s.db.prepare(`UPDATE calendar_sources SET deleted_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id)
    const calendarIds = (s.db.prepare(`SELECT id FROM calendars WHERE source_id = ?`).all(id) as { id: string }[]).map((r) => r.id)
    s.db.prepare(`DELETE FROM calendars WHERE source_id = ?`).run(id)
    const events = (s.db.prepare(`DELETE FROM calendar_events WHERE source_id = ? RETURNING id`).all(id) as { id: string }[]).map(
      (r) => r.id
    )
    return { events, calendarIds }
  })
  s.touch('calendar_sources', id)
  if (calendarIds.length) s.touch('calendars', ...calendarIds)
  if (events.length) s.touch('calendar_events', ...events)
  s.log('info', 'calendar:source-removed', { kind: src.kind, eventsDeleted: events.length })
  return { eventsDeleted: events.length }
}

// ---------- calendars ----------

function toCalendar(r: Row): CalendarInfo {
  return {
    id: r['id'] as string,
    sourceId: r['source_id'] as string,
    name: r['name'] as string,
    color: strOrNull(r['color']),
    primary: r['is_primary'] === 1,
    accessRole: strOrNull(r['access_role']),
    visible: r['visible'] === 1
  }
}

/** The calendars of live sources (or of one), by source then primary first, then name. */
export function listCalendars(s: StoreCtx, sourceId?: string): CalendarInfo[] {
  const rows = s.db
    .prepare(
      `SELECT c.* FROM calendars c
       JOIN calendar_sources src ON src.id = c.source_id AND src.deleted_at IS NULL
       WHERE c.owner_id = @owner AND c.workspace_id = @workspace AND (@source IS NULL OR c.source_id = @source)
       ORDER BY src.created_at ASC, c.source_id ASC, c.is_primary DESC, c.name COLLATE NOCASE ASC, c.id ASC`
    )
    .all({ owner: s.identity.ownerId, workspace: s.identity.workspaceId, source: sourceId ?? null }) as Row[]
  return rows.map(toCalendar)
}

/**
 * Replaces a source's calendar list: existing calendars keep their visibility, new ones
 * are visible when listed in `defaults.visibleIds`, and calendars that disappeared are
 * deleted with their events.
 */
export function replaceCalendars(
  s: StoreCtx,
  sourceId: string,
  calendars: Omit<CalendarInfo, 'visible'>[],
  defaults: { visibleIds: string[] }
): CalendarInfo[] {
  const src = sourceRow(s, sourceId)
  if (!src || src.deleted) throw notFound('calendar source', sourceId)
  if (!Array.isArray(calendars)) throw invalid('calendars must be an array')
  const prefix = `${src.kind}:${sourceId}:`
  const visibleIds = new Set(Array.isArray(defaults?.visibleIds) ? defaults.visibleIds : [])
  const now = nowIso()
  const touched: string[] = []
  const deletedEvents = inTransaction(s.db, () => {
    const keep: string[] = []
    const upsert = s.db.prepare(
      `INSERT INTO calendars (id, source_id, workspace_id, owner_id, native_id, name, color, is_primary, access_role,
         visible, created_at, updated_at)
       VALUES (@id, @source, @workspace, @owner, @native, @name, @color, @primary, @role, @visible, @now, @now)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, color = excluded.color, is_primary = excluded.is_primary,
         access_role = excluded.access_role, updated_at = excluded.updated_at
       WHERE calendars.name IS NOT excluded.name OR calendars.color IS NOT excluded.color
         OR calendars.is_primary IS NOT excluded.is_primary OR calendars.access_role IS NOT excluded.access_role`
    )
    for (const c of calendars) {
      if (!c || typeof c.id !== 'string' || !c.id.startsWith(prefix)) throw invalid('calendar id must carry its source prefix')
      keep.push(c.id)
      const changes = upsert.run({
        id: c.id,
        source: sourceId,
        workspace: s.identity.workspaceId,
        owner: s.identity.ownerId,
        native: c.id.slice(prefix.length),
        name: typeof c.name === 'string' && c.name ? c.name.slice(0, 500) : '',
        color: typeof c.color === 'string' && c.color ? c.color.slice(0, 32) : null,
        primary: c.primary ? 1 : 0,
        role: typeof c.accessRole === 'string' ? c.accessRole.slice(0, 64) : null,
        visible: visibleIds.has(c.id) ? 1 : 0,
        now
      }).changes
      if (changes > 0) touched.push(c.id)
    }
    const gone = (
      s.db
        .prepare(`DELETE FROM calendars WHERE source_id = ? AND id NOT IN (SELECT value FROM json_each(?)) RETURNING id`)
        .all(sourceId, JSON.stringify(keep)) as { id: string }[]
    ).map((r) => r.id)
    touched.push(...gone)
    if (!gone.length) return [] as string[]
    return (
      s.db
        .prepare(
          `DELETE FROM calendar_events WHERE source_id = ? AND calendar_id IN (SELECT value FROM json_each(?)) RETURNING id`
        )
        .all(sourceId, JSON.stringify(gone)) as { id: string }[]
    ).map((r) => r.id)
  })
  if (touched.length) s.touch('calendars', ...touched)
  if (deletedEvents.length) s.touch('calendar_events', ...deletedEvents)
  return listCalendars(s, sourceId)
}

/** Hiding a calendar deletes its events (they are fetched again when it is shown). */
export function setCalendarVisible(s: StoreCtx, calendarId: string, visible: boolean): { eventsDeleted: number } {
  if (typeof calendarId !== 'string' || !calendarId) throw invalid('calendarId is required')
  const row = s.db
    .prepare(
      `SELECT c.id, c.visible FROM calendars c JOIN calendar_sources src ON src.id = c.source_id AND src.deleted_at IS NULL
       WHERE c.id = ? AND c.owner_id = ? AND c.workspace_id = ?`
    )
    .get(calendarId, s.identity.ownerId, s.identity.workspaceId) as Row | undefined
  if (!row) throw notFound('calendar', calendarId)
  const deleted = inTransaction(s.db, () => {
    s.db.prepare(`UPDATE calendars SET visible = ?, updated_at = ? WHERE id = ?`).run(visible ? 1 : 0, nowIso(), calendarId)
    if (visible) return [] as string[]
    return (
      s.db.prepare(`DELETE FROM calendar_events WHERE calendar_id = ? RETURNING id`).all(calendarId) as { id: string }[]
    ).map((r) => r.id)
  })
  s.touch('calendars', calendarId)
  if (deleted.length) s.touch('calendar_events', ...deleted)
  return { eventsDeleted: deleted.length }
}

// ---------- events ----------

function instantIso(t: unknown): string | null {
  if (!t || typeof t !== 'object') return null
  const dt = (t as { dateTime?: unknown }).dateTime
  if (typeof dt !== 'string' || !dt) return null
  const ms = Date.parse(dt)
  return Number.isNaN(ms) ? null : new Date(ms).toISOString()
}

/**
 * One transaction: upserts `events` (only into this source's visible calendars), then
 * deletes this source's rows in `scope.calendarIds` that are missing from them. A
 * removed source writes nothing.
 */
export function replaceSourceEvents(
  s: StoreCtx,
  sourceId: string,
  events: CalendarEvent[],
  scope: { calendarIds: string[] }
): { upserted: number; deleted: number } {
  if (!Array.isArray(events)) throw invalid('events must be an array')
  if (events.length > MAX_EVENTS_PER_WRITE) throw invalid(`at most ${MAX_EVENTS_PER_WRITE} events per write`)
  const src = sourceRow(s, sourceId)
  if (!src || src.deleted) return { upserted: 0, deleted: 0 }
  const prefix = `${src.kind}:${sourceId}:`
  const now = nowIso()
  const changed: string[] = []
  const deleted = inTransaction(s.db, () => {
    const visible = new Set(
      (s.db.prepare(`SELECT id FROM calendars WHERE source_id = ? AND visible = 1`).all(sourceId) as { id: string }[]).map(
        (r) => r.id
      )
    )
    const scopeIds = (Array.isArray(scope?.calendarIds) ? scope.calendarIds : []).filter((id) => typeof id === 'string')
    const keep: string[] = []
    const upsert = s.db.prepare(
      `INSERT INTO calendar_events (id, workspace_id, owner_id, start_time, end_time, data, updated_at, source_id, calendar_id, ical_uid)
       VALUES (@id, @workspace, @owner, @start, @end, @data, @now, @source, @calendar, @uid)
       ON CONFLICT (id) DO UPDATE SET start_time = excluded.start_time, end_time = excluded.end_time, data = excluded.data,
         updated_at = excluded.updated_at, source_id = excluded.source_id, calendar_id = excluded.calendar_id,
         ical_uid = excluded.ical_uid
       WHERE calendar_events.data IS NOT excluded.data OR calendar_events.start_time IS NOT excluded.start_time
         OR calendar_events.end_time IS NOT excluded.end_time OR calendar_events.calendar_id IS NOT excluded.calendar_id`
    )
    for (const ev of events) {
      if (!ev || typeof ev.id !== 'string' || !ev.id.startsWith(prefix)) continue
      const calendarId = typeof ev['calendarId'] === 'string' ? (ev['calendarId'] as string) : null
      if (!calendarId || !visible.has(calendarId)) continue
      const start = instantIso(ev.start)
      const end = instantIso(ev.end)
      if (!start || !end) continue
      keep.push(ev.id)
      const changes = upsert.run({
        id: ev.id,
        workspace: s.identity.workspaceId,
        owner: s.identity.ownerId,
        start,
        end,
        data: JSON.stringify(ev),
        now,
        source: sourceId,
        calendar: calendarId,
        uid: typeof ev.iCalUID === 'string' && ev.iCalUID ? ev.iCalUID : null
      }).changes
      if (changes > 0) changed.push(ev.id)
    }
    if (!scopeIds.length) return [] as string[]
    return (
      s.db
        .prepare(
          `DELETE FROM calendar_events WHERE source_id = @source
             AND calendar_id IN (SELECT value FROM json_each(@scope))
             AND id NOT IN (SELECT value FROM json_each(@keep))
           RETURNING id`
        )
        .all({ source: sourceId, scope: JSON.stringify(scopeIds), keep: JSON.stringify(keep) }) as { id: string }[]
    ).map((r) => r.id)
  })
  if (changed.length || deleted.length) s.touch('calendar_events', ...changed, ...deleted)
  return { upserted: changed.length, deleted: deleted.length }
}

/**
 * Display dedupe: one row per `iCalUID-start_time` (else per id), an OAuth row
 * before an ICS row, then the lowest id. Rows without times never appear.
 */
const DEDUPED = `
  WITH ranked AS (
    SELECT e.id, e.data, e.start_time, e.end_time, e.calendar_id,
      row_number() OVER (
        PARTITION BY CASE WHEN e.ical_uid IS NOT NULL AND e.ical_uid != '' THEN e.ical_uid || '-' || e.start_time ELSE e.id END
        ORDER BY CASE WHEN e.id LIKE 'ics:%' THEN 1 ELSE 0 END, e.id
      ) AS rn
    FROM calendar_events e
    WHERE e.owner_id = @owner AND e.workspace_id = @workspace
      AND e.start_time IS NOT NULL AND e.end_time IS NOT NULL
      AND e.end_time >= @from AND e.start_time < @to
  )`

interface DedupedRow {
  id: string
  data: string
  start_time: string
  end_time: string
  calendar_id: string | null
}

function isoArg(v: unknown, what: string): string {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN
  if (Number.isNaN(ms)) throw invalid(`${what} is not a valid time`)
  return new Date(ms).toISOString()
}

function dedupedRows(s: StoreCtx, from: string, to: string): DedupedRow[] {
  return s.db
    .prepare(`${DEDUPED} SELECT id, data, start_time, end_time, calendar_id FROM ranked WHERE rn = 1 ORDER BY start_time, id`)
    .all({ owner: s.identity.ownerId, workspace: s.identity.workspaceId, from, to }) as DedupedRow[]
}

/** Deduped, timed events overlapping [from, to), by start. */
export function listEventsInRange(s: StoreCtx, q: { from: IsoTime; to: IsoTime }): CalendarEvent[] {
  const from = isoArg(q?.from, 'from')
  const to = isoArg(q?.to, 'to')
  return dedupedRows(s, from, to)
    .map((r) => parseJson<CalendarEvent | null>(r.data, null))
    .filter((e): e is CalendarEvent => e !== null)
}

export function getCalendarEvent(s: StoreCtx, id: string): CalendarEvent | null {
  if (typeof id !== 'string' || !id) return null
  const r = s.db
    .prepare(`SELECT data FROM calendar_events WHERE id = ? AND owner_id = ? AND workspace_id = ?`)
    .get(id, s.identity.ownerId, s.identity.workspaceId) as { data: string } | undefined
  return r ? parseJson<CalendarEvent | null>(r.data, null) : null
}

// ---------- Coming up ----------

/** The listable note scope (as notes-repo applies it). */
const LISTABLE = `
  d.deleted_at IS NULL
  AND d.owner_id = @owner AND d.workspace_id = @workspace
  AND (
    d.created_via IS NULL OR d.created_via = ''
    OR d.created_via IN ('macOS', 'Windows', 'desktop', 'shared_tab')
    OR EXISTS (SELECT 1 FROM note_panels p WHERE p.document_id = d.id AND p.deleted_at IS NULL)
  )`

function localDate(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function isSelfAttendee(a: CalendarAttendee, mine: ReadonlySet<string>): boolean {
  return a.self === true || (typeof a.email === 'string' && mine.has(a.email.trim().toLowerCase()))
}

/** With the filter on, an event needs another attendee, `conferenceData`, or a provider domain. */
function isPersonal(ev: CalendarEvent, mine: ReadonlySet<string>): boolean {
  const attendees = Array.isArray(ev.attendees) ? ev.attendees : []
  if (attendees.some((a) => a && !isSelfAttendee(a, mine))) return false
  if (ev['conferenceData']) return false
  const text = (v: unknown): string | null => (typeof v === 'string' ? v : null)
  return !mentionsConferenceDomain(text(ev['description'])) && !mentionsConferenceDomain(text(ev['location']))
}

interface Candidate {
  event: CalendarEvent
  startMs: number
  endMs: number
  calendarId: string | null
}

export function upcomingEvents(
  s: StoreCtx,
  q: { page: number; now: IsoTime; filterPersonal: boolean; myEmails: string[] }
): UpcomingPage {
  const page = Math.max(0, Math.floor(Number(q?.page ?? 0)))
  if (!Number.isFinite(page)) throw invalid('page must be a number')
  const nowMs = Date.parse(isoArg(q.now, 'now'))
  const minuteMs = Math.floor(nowMs / 60_000) * 60_000
  const today = localDate(nowMs)
  const startOfToday = new Date(nowMs)
  startOfToday.setHours(0, 0, 0, 0)
  const mine = new Set((q.myEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))
  const params = { owner: s.identity.ownerId, workspace: s.identity.workspaceId }

  // Every deduped event from the start of today on: the visible ones end at or
  // after the current minute; the rest only feed "an event already ended today".
  const rows = dedupedRows(s, startOfToday.toISOString(), '9999-12-31T23:59:59.999Z')
  const keep = (ev: CalendarEvent): boolean => !q.filterPersonal || !isPersonal(ev, mine)
  const all: Candidate[] = []
  for (const r of rows) {
    const event = parseJson<CalendarEvent | null>(r.data, null)
    if (!event || !keep(event)) continue
    all.push({ event, startMs: Date.parse(r.start_time), endMs: Date.parse(r.end_time), calendarId: r.calendar_id })
  }

  // An event the user already summarised (a live panel on a note at its start) leaves.
  const summarised = new Set(
    (
      s.db
        .prepare(
          `SELECT d.event_id AS event_id, d.sort_epoch AS t FROM documents d
           WHERE d.deleted_at IS NULL AND d.owner_id = @owner AND d.workspace_id = @workspace AND d.event_id IS NOT NULL
             AND EXISTS (SELECT 1 FROM note_panels p WHERE p.document_id = d.id AND p.deleted_at IS NULL)`
        )
        .all(params) as { event_id: string; t: number }[]
    ).map((r) => `${r.event_id}\n${r.t}`)
  )
  const key = (c: Candidate): string => `${c.event.id}\n${Math.floor(c.startMs / 1000)}`
  const visible = all.filter((c) => c.endMs >= minuteMs && !summarised.has(key(c)))
  const anyEarlierToday = all.some((c) => c.endMs < nowMs && localDate(c.startMs) === today)

  const startsToday = visible.some((c) => localDate(c.startMs) === today)
  const first = startsToday ? UPCOMING_PAGE.firstWithToday : UPCOMING_PAGE.firstWithoutToday
  const offset = page === 0 ? 0 : first + (page - 1) * UPCOMING_PAGE.later
  const size = page === 0 ? first : UPCOMING_PAGE.later
  const slice = visible.slice(offset, offset + size)

  // The user's newest non-shared note for each listed event, at its start.
  const noteIds = new Map<string, string>()
  if (slice.length) {
    const wanted = slice.map((c) => ({ e: c.event.id, t: Math.floor(c.startMs / 1000) }))
    const found = s.db
      .prepare(
        `SELECT d.id AS id, d.event_id AS event_id, d.sort_epoch AS t FROM documents d
         WHERE ${LISTABLE} AND d.is_shared = 0
           AND EXISTS (SELECT 1 FROM json_each(@wanted) w
                       WHERE json_extract(w.value, '$.e') = d.event_id AND json_extract(w.value, '$.t') = d.sort_epoch)
         ORDER BY d.created_at DESC, d.id DESC`
      )
      .all({ ...params, wanted: JSON.stringify(wanted) }) as { id: string; event_id: string; t: number }[]
    for (const r of found) {
      const k = `${r.event_id}\n${r.t}`
      if (!noteIds.has(k)) noteIds.set(k, r.id)
    }
  }

  const colors = new Map(
    (
      s.db.prepare(`SELECT id, color FROM calendars WHERE owner_id = @owner AND workspace_id = @workspace`).all(params) as {
        id: string
        color: string | null
      }[]
    ).map((r) => [r.id, r.color])
  )
  const groups = new Map<string, UpcomingEvent[]>()
  if (page === 0) groups.set(today, [])
  for (const c of slice) {
    const date = localDate(c.startMs)
    const list = groups.get(date) ?? []
    list.push({
      event: c.event,
      color: (c.calendarId && colors.get(c.calendarId)) || CALENDAR_COLOR_DEFAULT,
      noteId: noteIds.get(key(c)) ?? null
    })
    groups.set(date, list)
  }

  const sources = listCalendarSources(s)
  return {
    page,
    dayGroups: [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, events]) => ({ date, events })),
    hasNextPage: visible.length > offset + size,
    anyEarlierToday,
    hasAnyEvents: visible.length > 0,
    calendarError: sources.some((src) => src.status === 'error' && !!src.errorType && CALENDAR_ERROR_TYPES.includes(src.errorType)),
    hasSources: sources.length > 0
  }
}

// ---------- notes follow their event ----------

/**
 * For each refreshed event, the user's live notes linked to it that have no generated
 * summary follow it: the stored event JSON is replaced when it differs, and the title
 * becomes the new event title only while it still equals the old one.
 */
export function followEventUpdates(s: StoreCtx, events: CalendarEvent[]): string[] {
  if (!Array.isArray(events) || events.length === 0) return []
  const byId = new Map<string, CalendarEvent>()
  for (const ev of events) if (ev && typeof ev.id === 'string' && ev.id) byId.set(ev.id, ev)
  if (!byId.size) return []
  const changed = inTransaction(s.db, () => {
    const rows = s.db
      .prepare(
        `SELECT d.id AS id, d.title AS title, d.event_id AS event_id, d.linked_event AS event FROM documents d
         WHERE d.deleted_at IS NULL AND d.owner_id = @owner AND d.workspace_id = @workspace AND d.is_shared = 0
           AND d.event_id IN (SELECT value FROM json_each(@ids))
           AND NOT EXISTS (
             SELECT 1 FROM note_panels p WHERE p.document_id = d.id AND p.deleted_at IS NULL
               AND (coalesce(p.content_markdown, '') != '' OR coalesce(p.content, '') NOT IN ('', 'null'))
           )`
      )
      .all({ owner: s.identity.ownerId, workspace: s.identity.workspaceId, ids: JSON.stringify([...byId.keys()]) }) as {
      id: string
      title: string | null
      event_id: string
      event: string | null
    }[]
    const update = s.db.prepare(
      `UPDATE documents SET linked_event = @event, title = @title, updated_at = @now WHERE id = @id`
    )
    const out: string[] = []
    const now = nowIso()
    for (const r of rows) {
      const next = byId.get(r.event_id)
      if (!next) continue
      const json = JSON.stringify(next)
      if (json === r.event) continue
      const old = parseJson<CalendarEvent | null>(r.event, null)
      const oldTitle = typeof old?.summary === 'string' ? old.summary : ''
      const title = (r.title ?? '') === oldTitle && typeof next.summary === 'string' ? next.summary : r.title
      update.run({ id: r.id, event: json, title, now })
      out.push(r.id)
    }
    return out
  })
  if (changed.length) {
    s.touch('documents', ...changed)
    s.log('info', 'calendar:notes-followed-events', { count: changed.length })
  }
  return changed
}

// ---------- known participants ----------

interface Seen {
  email: string
  name: string
  nameAt: number
  lastSeen: number
}

/**
 * Everyone in the user's notes (`people` creator and attendees) and in the stored
 * events' attendees: unique by lower-cased email, without resources and the user.
 * Matching: every word of the query occurs in the name or the email. Order: people not
 * yet attendees of `noteId` first, then the most recently seen.
 */
export function participants(
  s: StoreCtx,
  q: { query: string; noteId?: string; myEmails: string[]; limit: number }
): Participant[] {
  const query = typeof q?.query === 'string' ? q.query.trim().toLowerCase().slice(0, MAX_PARTICIPANT_QUERY) : ''
  const limit = Math.max(0, Math.min(50, Math.floor(Number(q?.limit ?? 5))))
  const mine = new Set((q.myEmails ?? []).map((e) => e.trim().toLowerCase()).filter(Boolean))
  const params = { owner: s.identity.ownerId, workspace: s.identity.workspaceId }
  const rows = s.db
    .prepare(
      `SELECT json_extract(p.value, '$.email') AS email, json_extract(p.value, '$.name') AS name,
              d.sort_epoch * 1000 AS t
       FROM documents d, json_each(CASE WHEN json_valid(d.people) THEN d.people ELSE '{}' END, '$.attendees') p
       WHERE d.deleted_at IS NULL AND d.owner_id = @owner AND d.workspace_id = @workspace
       UNION ALL
       SELECT json_extract(d.people, '$.creator.email'), json_extract(d.people, '$.creator.name'),
              d.sort_epoch * 1000
       FROM documents d
       WHERE d.deleted_at IS NULL AND d.owner_id = @owner AND d.workspace_id = @workspace
         AND d.people IS NOT NULL AND json_valid(d.people)
       UNION ALL
       SELECT json_extract(a.value, '$.email'), json_extract(a.value, '$.displayName'), unixepoch(e.start_time) * 1000
       FROM calendar_events e, json_each(CASE WHEN json_valid(e.data) THEN e.data ELSE '{}' END, '$.attendees') a
       WHERE e.owner_id = @owner AND e.workspace_id = @workspace
         AND coalesce(json_extract(a.value, '$.resource'), 0) = 0`
    )
    .all(params) as { email: unknown; name: unknown; t: number | null }[]

  const people = new Map<string, Seen>()
  for (const r of rows) {
    if (typeof r.email !== 'string') continue
    const email = r.email.trim()
    const key = email.toLowerCase()
    if (!key || !key.includes('@') || mine.has(key) || isResourceEmail(key)) continue
    const t = typeof r.t === 'number' && Number.isFinite(r.t) ? r.t : 0
    const name = typeof r.name === 'string' ? r.name.trim() : ''
    const p = people.get(key) ?? { email, name: '', nameAt: -Infinity, lastSeen: 0 }
    if (t > p.lastSeen) p.lastSeen = t
    if (name && t >= p.nameAt) {
      p.name = name
      p.nameAt = t
    }
    people.set(key, p)
  }

  const attendees = new Set<string>()
  if (typeof q.noteId === 'string' && q.noteId) {
    const note = s.db
      .prepare(`SELECT people, linked_event FROM documents WHERE id = ? AND owner_id = ?`)
      .get(q.noteId, s.identity.ownerId) as { people: string | null; linked_event: string | null } | undefined
    const np = parseJson<NotePeople | null>(note?.people ?? null, null)
    if (np) {
      for (const a of np.attendees ?? []) if (typeof a?.email === 'string') attendees.add(a.email.trim().toLowerCase())
      if (typeof np.creator?.email === 'string') attendees.add(np.creator.email.trim().toLowerCase())
    } else {
      const ev = parseJson<CalendarEvent | null>(note?.linked_event ?? null, null)
      for (const a of ev?.attendees ?? []) if (typeof a?.email === 'string') attendees.add(a.email.trim().toLowerCase())
    }
  }

  const words = query.split(/\s+/).filter(Boolean)
  const matches = [...people.values()].filter((p) => {
    const hay = `${p.name.toLowerCase()} ${p.email.toLowerCase()}`
    return words.every((w) => hay.includes(w))
  })
  return matches
    .map((p) => ({ p, isAttendee: attendees.has(p.email.toLowerCase()) }))
    .sort((a, b) => Number(a.isAttendee) - Number(b.isAttendee) || b.p.lastSeen - a.p.lastSeen || a.p.email.localeCompare(b.p.email))
    .slice(0, limit)
    .map(({ p, isAttendee }) => ({
      name: p.name,
      email: p.email,
      lastSeenAt: new Date(p.lastSeen || 0).toISOString(),
      isAttendee
    }))
}
