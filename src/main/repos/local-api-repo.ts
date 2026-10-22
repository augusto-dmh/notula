// SPDX-License-Identifier: Apache-2.0
// Local API (key hashes never leave main): the storage-worker side of its StorageApi group.
// Worker-safe: no Electron imports.
//
// - `local_api_keys` holds only the SHA-256 hash of each key. Status is computed:
//   revoked, else expired, else active.
// - The read methods cover the local workspace's own notes, never trashed ones. `owner` is
//   left empty here: main fills it from Profile.
// - A note item carries its content source (or null). `notes_md_stamped` is a separate field;
//   `notes_md` is never changed for it.
// - Transcript items carry `position_ms`, the video position: the chunk's own mapped position,
//   else its offset into a video-captions or timed-import session. Sessions a switch to video
//   captions superseded are left out.
// - `notes.list` carries at most the newest `LIST_SPANS` watched spans per note (its percent
//   still counts them all); `notes.get` carries every span.

import type {
  ApiFolder,
  ApiNoteFilters,
  ApiNoteFull,
  ApiNoteItem,
  ApiNoteSource,
  ApiSeriesDetail,
  ApiSeriesItem,
  ApiTranscript
} from '../storage/api'
import { nowIso, parseJson } from '../storage/rows'
import { getSeriesDetail, getSeriesListItem, listSeries, SOURCE_KINDS, spansByNote, toNoteSource, watchedPercent } from '../storage/sources-repo'
import { invalid, notFound, type StoreCtx } from '../storage/store'
import type { AudioSource, IsoTime } from '@shared/types/common'
import type { CalendarEvent } from '@shared/types/notes'
import type { LocalApiKey, LocalApiKeyStatus, LocalApiScope } from '@shared/types/local-api'
import type { SeriesKind, SeriesListItem, SourceKind, SourceSpan } from '@shared/types/sources'

type Row = Record<string, unknown>

/** The spans per note a `notes.list` item carries: the newest, so a page stays small. */
const LIST_SPANS = 200

const KEY_COLS = 'id, description, scopes, created_at, last_used_at, expires_at, revoked_at'
const SCOPES: readonly LocalApiScope[] = ['notes:read', 'transcripts:read', 'folders:write']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/
const OWN = `d.deleted_at IS NULL AND d.owner_id = @owner AND d.workspace_id = @workspace AND d.is_shared = 0 AND d.is_scratchpad = 0`
const NOTE_COLS = 'd.id, d.title, d.created_at, d.updated_at, d.linked_event'

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function cleanScopes(v: unknown): LocalApiScope[] {
  if (!Array.isArray(v) || v.some((s) => !SCOPES.includes(s as LocalApiScope))) throw invalid('scopes must be known scopes')
  // `notes:read` is always on.
  return SCOPES.filter((s) => s === 'notes:read' || v.includes(s))
}

function statusOf(r: Row, now: number): LocalApiKeyStatus {
  if (str(r['revoked_at'])) return 'revoked'
  const exp = str(r['expires_at'])
  if (exp && Date.parse(exp) <= now) return 'expired'
  return 'active'
}

function toKey(r: Row): LocalApiKey {
  const scopes = parseJson<unknown>(r['scopes'], [])
  return {
    id: String(r['id']),
    description: String(r['description'] ?? ''),
    scopes: Array.isArray(scopes) ? SCOPES.filter((s) => scopes.includes(s)) : ['notes:read'],
    status: statusOf(r, Date.now()),
    createdAt: String(r['created_at']),
    lastUsedAt: str(r['last_used_at']),
    expiresAt: str(r['expires_at']),
    revokedAt: str(r['revoked_at'])
  }
}

function getKeyRow(s: StoreCtx, id: string): Row {
  if (typeof id !== 'string' || !UUID.test(id)) throw invalid('id must be a UUID')
  const r = s.db.prepare(`SELECT ${KEY_COLS} FROM local_api_keys WHERE id = ?`).get(id) as Row | undefined
  if (!r) throw notFound('key', id)
  return r
}

export function listLocalApiKeys(s: StoreCtx): LocalApiKey[] {
  const rows = s.db.prepare(`SELECT ${KEY_COLS} FROM local_api_keys ORDER BY created_at DESC, rid DESC`).all() as Row[]
  return rows.map(toKey)
}

export function createLocalApiKey(s: StoreCtx, k: { id: string; description: string; scopes: LocalApiScope[]; key_hash: string; expires_at: IsoTime | null }): LocalApiKey {
  if (!k || typeof k.id !== 'string' || !UUID.test(k.id)) throw invalid('id must be a UUID')
  if (typeof k.key_hash !== 'string' || !HASH.test(k.key_hash)) throw invalid('key_hash must be a SHA-256 hex digest')
  const description = typeof k.description === 'string' ? k.description.trim() : ''
  if (description.length > 500) throw invalid('description is at most 500 characters')
  if (k.expires_at !== null && (typeof k.expires_at !== 'string' || Number.isNaN(Date.parse(k.expires_at)))) throw invalid('expires_at must be a time')
  s.db
    .prepare(
      `INSERT INTO local_api_keys (id, workspace_id, owner_id, description, key_hash, scopes, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(k.id, s.identity.workspaceId, s.identity.ownerId, description, k.key_hash, JSON.stringify(cleanScopes(k.scopes)), nowIso(), k.expires_at)
  return toKey(getKeyRow(s, k.id))
}

export function findLocalApiKey(s: StoreCtx, keyHash: string): (LocalApiKey & { key_hash: string }) | null {
  if (typeof keyHash !== 'string' || !HASH.test(keyHash)) return null
  const r = s.db.prepare(`SELECT ${KEY_COLS}, key_hash FROM local_api_keys WHERE key_hash = ?`).get(keyHash) as Row | undefined
  return r ? { ...toKey(r), key_hash: String(r['key_hash']) } : null
}

export function updateLocalApiKey(s: StoreCtx, id: string, patch: { description?: string; scopes?: LocalApiScope[]; revoked_at?: IsoTime }): LocalApiKey {
  const row = getKeyRow(s, id)
  const sets: string[] = []
  const params: unknown[] = []
  if (patch?.description !== undefined) {
    if (typeof patch.description !== 'string' || patch.description.trim().length > 500) throw invalid('description is at most 500 characters')
    sets.push('description = ?')
    params.push(patch.description.trim())
  }
  if (patch?.scopes !== undefined) {
    sets.push('scopes = ?')
    params.push(JSON.stringify(cleanScopes(patch.scopes)))
  }
  if (patch?.revoked_at !== undefined) {
    if (typeof patch.revoked_at !== 'string' || Number.isNaN(Date.parse(patch.revoked_at))) throw invalid('revoked_at must be a time')
    // Revoking is final; the first time stays.
    if (!str(row['revoked_at'])) {
      sets.push('revoked_at = ?')
      params.push(patch.revoked_at)
    }
  }
  if (sets.length) s.db.prepare(`UPDATE local_api_keys SET ${sets.join(', ')} WHERE id = ?`).run(...params, id)
  return toKey(getKeyRow(s, id))
}

export function touchLocalApiKey(s: StoreCtx, id: string, at: IsoTime): void {
  if (typeof id !== 'string' || typeof at !== 'string') throw invalid('id and at are required')
  s.db.prepare(`UPDATE local_api_keys SET last_used_at = ? WHERE id = ?`).run(at, id)
}

/** Only a revoked or expired key's row can be removed. */
export function deleteLocalApiKey(s: StoreCtx, id: string): void {
  const row = getKeyRow(s, id)
  if (statusOf(row, Date.now()) === 'active') throw invalid('Revoke the key before removing it')
  s.db.prepare(`DELETE FROM local_api_keys WHERE id = ?`).run(id)
}

// ---------- the API's read side ----------

function eventTime(t: unknown): IsoTime | null {
  if (!t || typeof t !== 'object') return null
  const o = t as { dateTime?: unknown; date?: unknown }
  return str(o.dateTime) ?? str(o.date)
}

function calendarEvent(raw: unknown): ApiNoteItem['calendar_event'] {
  const ev = parseJson<CalendarEvent | null>(raw, null)
  if (!ev || typeof ev !== 'object') return null
  const attendees = Array.isArray(ev.attendees) ? ev.attendees.filter((a) => a && typeof a.email === 'string' && !a.resource) : []
  const organizer = (ev as { organizer?: { email?: unknown } }).organizer
  return {
    event_title: str(ev.summary),
    invitees: attendees.map((a) => ({ email: a.email })),
    organiser: attendees.find((a) => a.organizer)?.email ?? str(organizer?.email) ?? null,
    calendar_event_id: str(ev.id),
    scheduled_start_time: eventTime(ev.start),
    scheduled_end_time: eventTime(ev.end)
  }
}

function toItem(r: Row, source: ApiNoteSource | null): ApiNoteItem {
  return {
    id: String(r['id']),
    title: str(r['title']),
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at']),
    type: 'meeting',
    status: null,
    owner: { name: null, email: null },
    calendar_event: calendarEvent(r['linked_event']),
    source
  }
}

type SpanPositions = Pick<SourceSpan, 'pos_start_ms' | 'pos_end_ms'>

/** Per note, the positions of every span (for the watched percent) and the newest `limit` spans in wall order. */
function listedSpans(s: StoreCtx, noteIds: string[], limit: number): { positions: Map<string, SpanPositions[]>; spans: Map<string, SourceSpan[]> } {
  const ids = JSON.stringify(noteIds)
  const positions = new Map<string, SpanPositions[]>()
  for (const r of s.db.prepare(`SELECT note_id, pos_start_ms, pos_end_ms FROM source_spans WHERE note_id IN (SELECT value FROM json_each(?))`).all(ids) as Row[]) {
    const p = { pos_start_ms: Number(r['pos_start_ms']), pos_end_ms: Number(r['pos_end_ms']) }
    const list = positions.get(String(r['note_id']))
    if (list) list.push(p)
    else positions.set(String(r['note_id']), [p])
  }
  const spans = new Map<string, SourceSpan[]>()
  const rows = s.db
    .prepare(
      `SELECT * FROM (
         SELECT id, workspace_id, owner_id, note_id, wall_start, wall_end, pos_start_ms, pos_end_ms, rate, rid,
           row_number() OVER (PARTITION BY note_id ORDER BY wall_start DESC, rid DESC) AS n
         FROM source_spans WHERE note_id IN (SELECT value FROM json_each(?)))
       WHERE n <= ? ORDER BY note_id, wall_start, rid`
    )
    .all(ids, limit) as Row[]
  for (const r of rows) {
    const sp: SourceSpan = {
      id: String(r['id']),
      workspace_id: String(r['workspace_id']),
      owner_id: String(r['owner_id']),
      note_id: String(r['note_id']),
      wall_start: Number(r['wall_start']),
      wall_end: Number(r['wall_end']),
      pos_start_ms: Number(r['pos_start_ms']),
      pos_end_ms: Number(r['pos_end_ms']),
      rate: Number(r['rate'])
    }
    const list = spans.get(sp.note_id)
    if (list) list.push(sp)
    else spans.set(sp.note_id, [sp])
  }
  return { positions, spans }
}

/**
 * Each listed note's `source` (with its series and watched spans) and stamped Markdown, when it
 * has one. `spanLimit` caps the spans per note (the newest); null carries them all.
 */
function apiSources(s: StoreCtx, noteIds: string[], spanLimit: number | null): Map<string, { source: ApiNoteSource; stamped: string | null }> {
  const out = new Map<string, { source: ApiNoteSource; stamped: string | null }>()
  if (!noteIds.length) return out
  const rows = s.db
    .prepare(
      `SELECT ns.*, ss.id AS s_id, ss.kind AS s_kind, ss.title AS s_title
       FROM note_sources ns LEFT JOIN source_series ss ON ss.id = ns.series_id
       WHERE ns.note_id IN (SELECT value FROM json_each(?))`
    )
    .all(JSON.stringify(noteIds)) as Row[]
  const sourceNotes = rows.map((r) => String(r['note_id']))
  const listed = spanLimit === null ? null : listedSpans(s, sourceNotes, spanLimit)
  const spans = listed?.spans ?? spansByNote(s, sourceNotes)
  for (const r of rows) {
    const src = toNoteSource(r)
    const sp = spans.get(src.note_id) ?? []
    const covered = listed ? (listed.positions.get(src.note_id) ?? []) : sp
    out.set(src.note_id, {
      stamped: src.notes_md_stamped,
      source: {
        kind: src.kind,
        provider: src.provider,
        url: src.url,
        title: src.title,
        channel: src.channel,
        duration_ms: src.duration_ms,
        live: src.live,
        series: typeof r['s_id'] === 'string' ? { id: r['s_id'], kind: String(r['s_kind']) as SeriesKind, title: String(r['s_title'] ?? '') } : null,
        // A lesson only once something about it is known.
        lesson:
          src.lesson_number === null && src.lesson_label === null && src.lesson_state === 'pending' && !src.series_id
            ? null
            : { number: src.lesson_number, label: src.lesson_label, state: src.lesson_state },
        confidence: src.confidence,
        watched: {
          spans: sp.map((x) => ({ wall_start: x.wall_start, wall_end: x.wall_end, pos_start_ms: x.pos_start_ms, pos_end_ms: x.pos_end_ms, rate: x.rate })),
          percent: watchedPercent(covered, src.duration_ms, src.live)
        }
      }
    })
  }
  return out
}

function filterFlag(v: unknown, name: string): number | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'boolean') throw invalid(`${name} must be true or false`)
  return v ? 1 : 0
}

/** Markdown to readable text: drops the markup, keeps the words and the line breaks. */
function markdownText(md: string): string {
  return md
    .replace(/```[^\n]*\n?/g, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^(\s*)[-*+]\s+\[[ xX]\]\s+/gm, '$1- ')
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(\S.*?)\1/g, '$2')
    .replace(/`([^`]+)`/g, '$1')
    .trim()
}

const scope = (s: StoreCtx): { owner: string; workspace: string } => ({ owner: s.identity.ownerId, workspace: s.identity.workspaceId })

export function apiListNotes(
  s: StoreCtx,
  q: { limit: number; offset: number; createdAfter?: IsoTime; createdBefore?: IsoTime } & ApiNoteFilters
): { notes: ApiNoteItem[]; hasMore: boolean } {
  const limit = Math.floor(Number(q?.limit))
  const offset = Math.floor(Number(q?.offset))
  if (!(limit >= 1 && limit <= 100)) throw invalid('limit must be 1–100')
  if (!(offset >= 0)) throw invalid('offset must be 0 or more')
  const iso = (v: unknown, name: string): string | null => {
    if (v === undefined || v === null) return null
    if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw invalid(`${name} must be a time`)
    return new Date(v).toISOString()
  }
  let kind: SourceKind | null = null
  if (q.sourceKind !== undefined && q.sourceKind !== null) {
    if (!SOURCE_KINDS.includes(q.sourceKind)) throw invalid('source_kind must be a known kind')
    kind = q.sourceKind
  }
  let seriesId: string | null = null
  if (q.seriesId !== undefined && q.seriesId !== null) {
    if (typeof q.seriesId !== 'string' || !q.seriesId || q.seriesId.length > 200) throw invalid('series_id must be an id')
    seriesId = q.seriesId
  }
  // One-item look-ahead pages the list.
  const rows = s.db
    .prepare(
      `SELECT ${NOTE_COLS} FROM documents d
       WHERE ${OWN}
         AND (@after IS NULL OR d.created_at > @after)
         AND (@before IS NULL OR d.created_at < @before)
         AND (@kind IS NULL OR EXISTS (SELECT 1 FROM note_sources ns WHERE ns.note_id = d.id AND ns.kind = @kind))
         AND (@series IS NULL OR EXISTS (SELECT 1 FROM note_sources ns WHERE ns.note_id = d.id AND ns.series_id = @series))
         AND (@hasSource IS NULL OR EXISTS (SELECT 1 FROM note_sources ns WHERE ns.note_id = d.id) = @hasSource)
         AND (@hasSeries IS NULL OR EXISTS (
           SELECT 1 FROM note_sources ns WHERE ns.note_id = d.id AND (ns.series_id IS NOT NULL) = @hasSeries))
       ORDER BY d.created_at DESC, d.id ASC
       LIMIT @take OFFSET @offset`
    )
    .all({
      ...scope(s),
      after: iso(q.createdAfter, 'created_after'),
      before: iso(q.createdBefore, 'created_before'),
      kind,
      series: seriesId,
      hasSource: filterFlag(q.hasSource, 'has_source'),
      hasSeries: filterFlag(q.hasSeries, 'has_series'),
      take: limit + 1,
      offset
    }) as Row[]
  const page = rows.slice(0, limit)
  const sources = apiSources(s, page.map((r) => String(r['id'])), LIST_SPANS)
  return { notes: page.map((r) => toItem(r, sources.get(String(r['id']))?.source ?? null)), hasMore: rows.length > limit }
}

export function apiGetNotes(s: StoreCtx, ids: string[]): { notes: ApiNoteFull[]; notFound: string[] } {
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 100 || ids.some((i) => typeof i !== 'string' || !i)) throw invalid('ids must be 1–100 ids')
  const unique = [...new Set(ids)]
  const get = s.db.prepare(`SELECT ${NOTE_COLS}, d.notes_text, d.notes_md FROM documents d WHERE d.id = @id AND ${OWN}`)
  // The newest live summary panel.
  const panel = s.db.prepare(
    `SELECT content_markdown FROM note_panels WHERE document_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, rid DESC LIMIT 1`
  )
  const notes: ApiNoteFull[] = []
  const missing: string[] = []
  const sources = apiSources(s, unique, null)
  for (const id of unique) {
    const r = get.get({ ...scope(s), id }) as Row | undefined
    if (!r) {
      missing.push(id)
      continue
    }
    const md = str((panel.get(id) as Row | undefined)?.['content_markdown'])
    const src = sources.get(id)
    notes.push({
      ...toItem(r, src?.source ?? null),
      notes_text: str(r['notes_text']) ?? '',
      notes_md: str(r['notes_md']) ?? '',
      summary_markdown: md,
      summary_text: md === null ? null : markdownText(md),
      notes_md_stamped: src?.stamped ?? null
    })
  }
  return { notes, notFound: missing }
}

export function apiTranscript(s: StoreCtx, id: string): ApiTranscript | null {
  if (typeof id !== 'string' || !id) throw invalid('id is required')
  const doc = s.db.prepare(`SELECT d.id, d.title, d.transcript_purged_at FROM documents d WHERE d.id = @id AND ${OWN}`).get({ ...scope(s), id }) as Row | undefined
  if (!doc) return null
  const deletedAt = str(doc['transcript_purged_at'])
  const source = s.db.prepare(`SELECT superseded_session_ids FROM note_sources WHERE note_id = ?`).get(id) as Row | undefined
  const superseded = parseJson<unknown>(source?.['superseded_session_ids'], [])
  // Sessions whose chunk times are offsets into the video (captions) or an imported timed transcript.
  const offsetFrom = new Map<string, number>()
  for (const r of s.db.prepare(`SELECT id, provider, model, started_at FROM transcription_sessions WHERE document_id = ?`).all(id) as Row[]) {
    const started = Date.parse(String(r['started_at']))
    const timed = r['provider'] === 'captions' || (r['provider'] === 'import' && r['model'] === 'timed')
    if (timed && !Number.isNaN(started)) offsetFrom.set(String(r['id']), started)
  }
  // A purged transcript is an empty list plus its deletion time.
  const rows = deletedAt
    ? []
    : (s.db
        .prepare(
          `SELECT id, text, source, is_final, start_timestamp, end_timestamp, transcription_session_id,
             CASE WHEN json_valid(provider_details) THEN json_extract(provider_details, '$.sourcePositionMs') END AS pos
           FROM transcript_chunks
           WHERE document_id = ? AND transcription_session_id NOT IN (SELECT value FROM json_each(?))
           ORDER BY start_timestamp, end_timestamp, id`
        )
        .all(id, JSON.stringify(Array.isArray(superseded) ? superseded : [])) as Row[])
  const positionOf = (r: Row): number | null => {
    const pos = r['pos']
    if (typeof pos === 'number' && Number.isFinite(pos)) return Math.max(0, Math.round(pos))
    const started = offsetFrom.get(String(r['transcription_session_id']))
    const at = Date.parse(String(r['start_timestamp']))
    return started === undefined || Number.isNaN(at) ? null : Math.max(0, at - started)
  }
  return {
    id: String(doc['id']),
    title: str(doc['title']),
    transcript_purged_at: deletedAt,
    transcript: rows.map((r) => {
      const position = positionOf(r)
      return {
        id: String(r['id']),
        text: String(r['text']),
        source: (r['source'] === 'system' ? 'system' : 'microphone') as AudioSource,
        is_final: Number(r['is_final']) === 1,
        start_timestamp: String(r['start_timestamp']),
        end_timestamp: String(r['end_timestamp']),
        // A source note always carries the field; another note only when a position is known.
        ...(source || position !== null ? { position_ms: position } : {})
      }
    })
  }
}

export function apiListFolders(s: StoreCtx, q: { search?: string }): ApiFolder[] {
  let search: string | null = null
  if (q?.search !== undefined) {
    if (typeof q.search !== 'string') throw invalid('search must be text')
    search = q.search.trim()
    if (search.length < 1 || search.length > 200) throw invalid('search must be 1–200 characters')
  }
  const rows = s.db
    .prepare(
      `SELECT f.id, f.title, f.parent_id,
         (SELECT COUNT(*) FROM folder_notes fn JOIN documents d ON d.id = fn.note_id WHERE fn.folder_id = f.id AND ${OWN}) AS n
       FROM folders f
       WHERE f.owner_id = @owner AND f.workspace_id = @workspace
         AND (@search IS NULL OR instr(lower(f.title), lower(@search)) > 0)
       ORDER BY f.sort_order, f.title, f.id`
    )
    .all({ ...scope(s), search }) as Row[]
  return rows.map((r) => ({
    id: String(r['id']),
    name: String(r['title'] ?? ''),
    parent_folder_id: str(r['parent_id']),
    // Notula has no shared folders.
    visibility: 'private',
    document_count: Number(r['n'] ?? 0)
  }))
}

// ---------- series (content sources) ----------

function apiSeriesItem(x: SeriesListItem): ApiSeriesItem {
  return {
    id: x.id,
    kind: x.kind,
    provider: x.provider,
    title: x.title,
    folder_id: x.folder_id,
    state: x.state,
    note_count: x.noteCount,
    catalog_count: x.catalogCount,
    pending_count: x.pendingCount,
    last_watched_at: x.lastWatchedAt
  }
}

export function apiListSeries(s: StoreCtx): ApiSeriesItem[] {
  return listSeries(s).map(apiSeriesItem)
}

export function apiGetSeries(s: StoreCtx, id: string): ApiSeriesDetail | null {
  if (typeof id !== 'string' || !id || id.length > 200) throw invalid('id is required')
  // Only the local owner's series.
  const item = getSeriesListItem(s, id)
  const detail = item ? getSeriesDetail(s, id) : null
  if (!item || !detail) return null
  const pending = s.db
    .prepare(
      `SELECT d.id FROM note_sources ns JOIN documents d ON d.id = ns.note_id
       WHERE ns.series_id = @series AND ns.lesson_state = 'pending' AND ${OWN}
       ORDER BY d.created_at ASC, d.id ASC`
    )
    .all({ ...scope(s), series: id }) as Row[]
  return {
    ...apiSeriesItem(item),
    lessons: detail.lessons.map((l) => ({
      number: l.number,
      label: l.label,
      section: l.section,
      title: l.title,
      url: l.url,
      duration_ms: l.durationMs,
      note_id: l.noteId,
      state: l.lessonState,
      watched_percent: l.watchedPercent
    })),
    pending_note_ids: pending.map((r) => String(r['id'])),
    duplicates: detail.duplicates.map((d) => ({ canonical_key: d.canonicalKey, note_ids: d.noteIds }))
  }
}

