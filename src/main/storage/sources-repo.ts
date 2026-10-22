// SPDX-License-Identifier: Apache-2.0
// Content sources: `note_sources` (one per note), `source_series`, `series_catalog_items`,
// `source_spans` and `source_merges`. A source belongs to its note: it goes with a permanent
// delete (cascade), and a note in Trash never matches a lookup.
//
// - Kinds, providers, confidences, states and plans are checked here, not by the tables, so a
//   new value needs only a code change.
// - A lesson number set by hand (`lesson_origin = 'manual'`) is never overwritten by a bulk
//   numbering.
// - Change events: note-keyed writes publish note ids under `note_sources` / `source_spans`,
//   series writes publish series ids under `source_series` / `series_catalog_items`.
// - Logs carry ids and counts only, never titles or URLs.

import { randomUUID } from 'node:crypto'
import type { IsoTime } from '@shared/types/common'
import type { DocumentTag, NotePeople, NotePerson } from '@shared/types/notes'
import {
  SOURCES_LIMITS,
  type CanonicalKey,
  type CatalogItem,
  type LessonOrigin,
  type LessonState,
  type NoteSource,
  type NoteSourceView,
  type SeriesDetail,
  type SeriesKind,
  type SeriesLesson,
  type SeriesListItem,
  type SeriesState,
  type SourceConfidence,
  type SourceDetectedVia,
  type SourceEnrichment,
  type SourceKind,
  type SourceProvider,
  type SourceSeries,
  type SourceSpan,
  type SourceTrackState,
  type TranscriptPlan
} from '@shared/types/sources'
import type {
  LessonNumberUpdate,
  NewCatalogItem,
  NewNoteSource,
  NewSourceSeries,
  NewSourceSpan,
  NoteSourceUpdate,
  SourceMergeMoved,
  SourceMergeRecord,
  SourceNoteMatch,
  SourceSeriesPatch
} from './api'
import { nowIso, parseJson } from './rows'
import { inTransaction, invalid, notFound, type StoreCtx } from './store'

type Row = Record<string, unknown>

export const SOURCE_KINDS: readonly SourceKind[] = ['video', 'live', 'lesson', 'other']
export const SOURCE_PROVIDERS: readonly SourceProvider[] = [
  'youtube',
  'circle',
  'udemy',
  'coursera',
  'hotmart',
  'kiwify',
  'memberkit',
  'vimeo',
  'web'
]
const CONFIDENCES: readonly SourceConfidence[] = ['exact', 'high', 'guess']
const DETECTED_VIA: readonly SourceDetectedVia[] = ['media-session', 'history', 'search', 'extension', 'manual', 'backfill', 'import']
const LESSON_STATES: readonly LessonState[] = ['numbered', 'guessed', 'pending']
const LESSON_ORIGINS: readonly LessonOrigin[] = ['catalog', 'playlist', 'extension', 'manual']
const TRACK_STATES: readonly SourceTrackState[] = ['none', 'queued', 'fetching', 'ready', 'unavailable', 'failed']
const PLANS: readonly TranscriptPlan[] = ['pending', 'captions', 'system-audio', 'none']
const SERIES_KINDS: readonly SeriesKind[] = ['course', 'playlist', 'channel', 'custom']
const SERIES_STATES: readonly SeriesState[] = ['active', 'paused']

const MAX_KEY = 2_100
const MAX_URL = 4_096
const MAX_TITLE = 1_000
const MAX_CHANNEL = 500
const MAX_LABEL = 200
const MAX_SECTION = 500
const MAX_LANG = 35
/** The stamped projection has the cap of the note's own Markdown. */
const MAX_STAMPED = 4 * 1024 * 1024
const MAX_ENRICHMENT_BYTES = 256 * 1024
const MAX_SUPERSEDED = 200
const MAX_SPANS_PER_CALL = 1_000
const MAX_QUERY_IDS = 1_000
const MAX_EXTRA_BYTES = 1024 * 1024
const DEFAULT_MATCHES = 20

const SOURCE_COLS = [
  'id',
  'workspace_id',
  'owner_id',
  'note_id',
  'kind',
  'provider',
  'canonical_key',
  'url',
  'title',
  'channel',
  'duration_ms',
  'live',
  'series_id',
  'lesson_number',
  'lesson_label',
  'lesson_state',
  'lesson_origin',
  'confidence',
  'detected_via',
  'enrichment',
  'track_state',
  'track_language',
  'transcript_plan',
  'superseded_session_ids',
  'generated_title',
  'notes_md_stamped',
  'created_at',
  'updated_at'
] as const
const SOURCE_SELECT = SOURCE_COLS.map((c) => `ns.${c}`).join(', ')
const SERIES_COLS = 'id, workspace_id, owner_id, kind, provider, canonical_key, title, folder_id, state, created_at, updated_at'
const CATALOG_COLS = 'id, workspace_id, owner_id, series_id, number, section, title, url, canonical_key, duration_ms, position'
const SPAN_COLS = 'id, workspace_id, owner_id, note_id, wall_start, wall_end, pos_start_ms, pos_end_ms, rate'

/** Own, not trashed, not shared notes (alias `d`). */
/** Own notes as the Local API sees them: scratchpads are never listed. */
const OWN_NOTE = `d.deleted_at IS NULL AND d.owner_id = @owner AND d.workspace_id = @workspace AND d.is_shared = 0 AND d.is_scratchpad = 0`

const scope = (s: StoreCtx): { owner: string; workspace: string } => ({ owner: s.identity.ownerId, workspace: s.identity.workspaceId })
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'bigint' ? Number(v) : null)
const pick = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback)
const isoOfMs = (ms: number | null): IsoTime | null => (ms === null ? null : new Date(ms).toISOString())

// ---------- rows ----------

export function toNoteSource(r: Row): NoteSource {
  const superseded = parseJson<unknown>(r['superseded_session_ids'], [])
  return {
    id: String(r['id']),
    workspace_id: String(r['workspace_id']),
    owner_id: String(r['owner_id']),
    note_id: String(r['note_id']),
    kind: pick(r['kind'], SOURCE_KINDS, 'other'),
    provider: pick(r['provider'], SOURCE_PROVIDERS, 'web'),
    canonical_key: String(r['canonical_key']),
    url: str(r['url']),
    title: String(r['title'] ?? ''),
    channel: str(r['channel']),
    duration_ms: num(r['duration_ms']),
    live: r['live'] === 1,
    series_id: str(r['series_id']),
    lesson_number: num(r['lesson_number']),
    lesson_label: str(r['lesson_label']),
    lesson_state: pick(r['lesson_state'], LESSON_STATES, 'pending'),
    lesson_origin: LESSON_ORIGINS.includes(r['lesson_origin'] as LessonOrigin) ? (r['lesson_origin'] as LessonOrigin) : null,
    confidence: pick(r['confidence'], CONFIDENCES, 'guess'),
    detected_via: pick(r['detected_via'], DETECTED_VIA, 'manual'),
    enrichment: parseJson<SourceEnrichment | null>(r['enrichment'], null),
    track_state: pick(r['track_state'], TRACK_STATES, 'none'),
    track_language: str(r['track_language']),
    transcript_plan: pick(r['transcript_plan'], PLANS, 'none'),
    superseded_session_ids: Array.isArray(superseded) ? superseded.filter((x): x is string => typeof x === 'string') : [],
    generated_title: str(r['generated_title']),
    notes_md_stamped: str(r['notes_md_stamped']),
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at'])
  }
}

function toSeries(r: Row): SourceSeries {
  return {
    id: String(r['id']),
    workspace_id: String(r['workspace_id']),
    owner_id: String(r['owner_id']),
    kind: pick(r['kind'], SERIES_KINDS, 'custom'),
    provider: pick(r['provider'], SOURCE_PROVIDERS, 'web'),
    canonical_key: String(r['canonical_key']),
    title: String(r['title'] ?? ''),
    folder_id: str(r['folder_id']),
    state: pick(r['state'], SERIES_STATES, 'paused'),
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at'])
  }
}

function toCatalogItem(r: Row): CatalogItem {
  return {
    id: String(r['id']),
    workspace_id: String(r['workspace_id']),
    owner_id: String(r['owner_id']),
    series_id: String(r['series_id']),
    number: num(r['number']),
    section: str(r['section']),
    title: String(r['title'] ?? ''),
    url: str(r['url']),
    canonical_key: str(r['canonical_key']),
    duration_ms: num(r['duration_ms']),
    position: num(r['position']) ?? 0
  }
}

function toSpan(r: Row): SourceSpan {
  return {
    id: String(r['id']),
    workspace_id: String(r['workspace_id']),
    owner_id: String(r['owner_id']),
    note_id: String(r['note_id']),
    wall_start: num(r['wall_start']) ?? 0,
    wall_end: num(r['wall_end']) ?? 0,
    pos_start_ms: num(r['pos_start_ms']) ?? 0,
    pos_end_ms: num(r['pos_end_ms']) ?? 0,
    rate: num(r['rate']) ?? 1
  }
}

// ---------- validation ----------

function id(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v || v.length > 200) throw invalid(`${what} must be an id`)
  return v
}

function text(v: unknown, what: string, max: number): string {
  if (typeof v !== 'string' || v.length > max) throw invalid(`${what} must be text of at most ${max} characters`)
  return v
}

function textOrNull(v: unknown, what: string, max: number): string | null {
  return v === null || v === undefined ? null : text(v, what, max)
}

function oneOf<T extends string>(v: unknown, list: readonly T[], what: string): T {
  if (!list.includes(v as T)) throw invalid(`unknown ${what}`)
  return v as T
}

function intOrNull(v: unknown, what: string, min = 0): number | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > Number.MAX_SAFE_INTEGER) throw invalid(`${what} must be a number`)
  return Math.round(v)
}

function key(v: unknown, what = 'canonical_key'): string {
  const k = text(v, what, MAX_KEY).trim()
  if (!k) throw invalid(`${what} is required`)
  return k
}

function url(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const u = text(v, 'url', MAX_URL).trim()
  if (!u) return null
  if (!/^https?:\/\//i.test(u)) throw invalid('url must be http or https')
  return u
}

function enrichmentJson(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'object' || Array.isArray(v)) throw invalid('enrichment must be an object')
  const json = JSON.stringify(v)
  if (json.length > MAX_ENRICHMENT_BYTES) throw invalid('enrichment is too large')
  return json
}

function sessionIds(v: unknown): string {
  if (!Array.isArray(v) || v.length > MAX_SUPERSEDED || v.some((x) => typeof x !== 'string' || !x || x.length > 200)) {
    throw invalid('superseded_session_ids must be session ids')
  }
  return JSON.stringify([...new Set(v as string[])])
}

/** The local owner's rows, for id-addressed series and catalog statements (no alias). */
const OWN_ROW = `owner_id = @owner AND workspace_id = @workspace`

function requireSeriesRow(s: StoreCtx, seriesId: string): void {
  if (!s.db.prepare(`SELECT 1 FROM source_series WHERE id = @id AND ${OWN_ROW}`).get({ ...scope(s), id: seriesId })) throw notFound('series', seriesId)
}

function requireFolderRow(s: StoreCtx, folderId: string): void {
  if (!s.db.prepare(`SELECT 1 FROM folders WHERE id = ?`).get(folderId)) throw notFound('folder', folderId)
}

function ownNoteRow(s: StoreCtx, noteId: string): Row {
  const r = s.db.prepare(`SELECT id, owner_id, workspace_id, is_shared, deleted_at, created_at, people FROM documents WHERE id = ?`).get(noteId) as
    | Row
    | undefined
  if (!r) throw notFound('note', noteId)
  if (r['owner_id'] !== s.identity.ownerId || r['workspace_id'] !== s.identity.workspaceId || r['is_shared'] === 1) {
    throw invalid('Only your own notes can have a source')
  }
  return r
}

// ---------- coverage ----------

/** The share of the duration covered by the spans' positions (0–100), or null without a duration. */
export function watchedPercent(spans: Pick<SourceSpan, 'pos_start_ms' | 'pos_end_ms'>[], durationMs: number | null, live = false): number | null {
  if (live || durationMs === null || !(durationMs > 0)) return null
  const ranges = spans
    .map((sp) => [Math.max(0, Math.min(sp.pos_start_ms, sp.pos_end_ms)), Math.min(durationMs, Math.max(sp.pos_start_ms, sp.pos_end_ms))] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0])
  let covered = 0
  let start = -1
  let end = -1
  for (const [a, b] of ranges) {
    if (a > end) {
      if (end > start) covered += end - start
      start = a
      end = b
    } else if (b > end) {
      end = b
    }
  }
  if (end > start) covered += end - start
  return Math.min(100, Math.round((covered / durationMs) * 100))
}

/** Every span of each note, by wall start (one query). */
export function spansByNote(s: StoreCtx, noteIds: string[]): Map<string, SourceSpan[]> {
  const out = new Map<string, SourceSpan[]>()
  if (!noteIds.length) return out
  const rows = s.db
    .prepare(`SELECT ${SPAN_COLS} FROM source_spans WHERE note_id IN (SELECT value FROM json_each(?)) ORDER BY note_id, wall_start, rid`)
    .all(JSON.stringify(noteIds)) as Row[]
  for (const r of rows) {
    const sp = toSpan(r)
    const list = out.get(sp.note_id)
    if (list) list.push(sp)
    else out.set(sp.note_id, [sp])
  }
  return out
}

function lastWall(spans: SourceSpan[] | undefined): number | null {
  if (!spans?.length) return null
  return spans.reduce((m, sp) => Math.max(m, sp.wall_end), 0)
}

// ---------- note sources ----------

function getSourceRow(s: StoreCtx, noteId: string): NoteSource | null {
  const r = s.db.prepare(`SELECT ${SOURCE_SELECT} FROM note_sources ns WHERE ns.note_id = ?`).get(noteId) as Row | undefined
  return r ? toNoteSource(r) : null
}

export function getNoteSource(s: StoreCtx, noteId: string): NoteSource | null {
  return getSourceRow(s, id(noteId, 'noteId'))
}

export function getNoteSourceView(s: StoreCtx, noteId: string): NoteSourceView | null {
  const source = getSourceRow(s, id(noteId, 'noteId'))
  if (!source) return null
  const series = source.series_id ? getSeries(s, source.series_id) : null
  const spans = spansByNote(s, [noteId]).get(noteId) ?? []
  const same = s.db
    .prepare(
      `SELECT d.id FROM note_sources ns JOIN documents d ON d.id = ns.note_id
       WHERE ns.canonical_key = @key AND d.id != @note AND ${OWN_NOTE}
       ORDER BY d.created_at DESC, d.id ASC LIMIT @limit`
    )
    .all({ ...scope(s), key: source.canonical_key, note: noteId, limit: DEFAULT_MATCHES }) as Row[]
  return {
    source,
    series: series ? { id: series.id, kind: series.kind, title: series.title, folder_id: series.folder_id, state: series.state } : null,
    watched: { percent: watchedPercent(spans, source.duration_ms, source.live), spans: spans.length, lastWatchedAt: isoOfMs(lastWall(spans)) },
    sameKeyNoteIds: same.map((r) => String(r['id']))
  }
}

/** The validated column values of a new source (`note_id` excluded). */
function sourceValues(s: StoreCtx, input: Omit<NewNoteSource, 'note_id'>): Record<string, unknown> {
  if (typeof input !== 'object' || input === null) throw invalid('source must be an object')
  const seriesId = input.series_id === undefined || input.series_id === null ? null : id(input.series_id, 'series_id')
  if (seriesId) requireSeriesRow(s, seriesId)
  const title = text(input.title, 'title', MAX_TITLE).trim()
  return {
    kind: oneOf(input.kind, SOURCE_KINDS, 'source kind'),
    provider: oneOf(input.provider, SOURCE_PROVIDERS, 'source provider'),
    canonical_key: key(input.canonical_key),
    url: url(input.url),
    title,
    channel: textOrNull(input.channel, 'channel', MAX_CHANNEL),
    duration_ms: intOrNull(input.duration_ms, 'duration_ms'),
    live: input.live === true ? 1 : 0,
    series_id: seriesId,
    lesson_number: intOrNull(input.lesson_number, 'lesson_number'),
    lesson_label: textOrNull(input.lesson_label, 'lesson_label', MAX_LABEL),
    lesson_state: input.lesson_state === undefined ? 'pending' : oneOf(input.lesson_state, LESSON_STATES, 'lesson state'),
    lesson_origin: input.lesson_origin === undefined || input.lesson_origin === null ? null : oneOf(input.lesson_origin, LESSON_ORIGINS, 'lesson origin'),
    confidence: oneOf(input.confidence, CONFIDENCES, 'confidence'),
    detected_via: oneOf(input.detected_via, DETECTED_VIA, 'detected_via'),
    enrichment: enrichmentJson(input.enrichment),
    track_state: input.track_state === undefined ? 'none' : oneOf(input.track_state, TRACK_STATES, 'track state'),
    track_language: textOrNull(input.track_language, 'track_language', MAX_LANG),
    transcript_plan: input.transcript_plan === undefined ? 'pending' : oneOf(input.transcript_plan, PLANS, 'transcript plan'),
    generated_title: textOrNull(input.generated_title, 'generated_title', MAX_TITLE)
  }
}

/** Inserts (or, with `replace`, overwrites) the note's source inside the caller's transaction. */
export function writeNoteSource(s: StoreCtx, input: NewNoteSource, replace: boolean): void {
  const noteId = id(input?.note_id, 'note_id')
  ownNoteRow(s, noteId)
  const values = sourceValues(s, input)
  const now = nowIso()
  const existing = s.db.prepare(`SELECT id FROM note_sources WHERE note_id = ?`).get(noteId) as Row | undefined
  if (existing) {
    if (!replace) throw invalid('This note already has a source')
    const names = Object.keys(values)
    s.db
      .prepare(`UPDATE note_sources SET ${names.map((n) => `${n} = @${n}`).join(', ')}, updated_at = @now WHERE note_id = @note_id`)
      .run({ ...values, now, note_id: noteId })
  } else {
    const row = { id: randomUUID(), workspace_id: s.identity.workspaceId, owner_id: s.identity.ownerId, note_id: noteId, ...values, created_at: now, updated_at: now }
    const names = Object.keys(row)
    s.db.prepare(`INSERT INTO note_sources (${names.join(', ')}) VALUES (${names.map((n) => `@${n}`).join(', ')})`).run(row)
  }
}

export function createNoteSource(s: StoreCtx, input: NewNoteSource, opts?: { replace?: boolean }): NoteSource {
  inTransaction(s.db, () => writeNoteSource(s, input, opts?.replace === true))
  s.touch('note_sources', input.note_id)
  return getSourceRow(s, input.note_id) as NoteSource
}

/** Column encoders of `updateNoteSource`; each validates its value. */
const UPDATE_COLUMNS: { [K in keyof Required<NoteSourceUpdate>]: (v: unknown, s: StoreCtx) => unknown } = {
  title: (v) => text(v, 'title', MAX_TITLE).trim(),
  channel: (v) => textOrNull(v, 'channel', MAX_CHANNEL),
  url: (v) => url(v),
  series_id: (v, s) => {
    if (v === null) return null
    const sid = id(v, 'series_id')
    requireSeriesRow(s, sid)
    return sid
  },
  lesson_number: (v) => intOrNull(v, 'lesson_number'),
  lesson_label: (v) => textOrNull(v, 'lesson_label', MAX_LABEL),
  notes_md_stamped: (v) => textOrNull(v, 'notes_md_stamped', MAX_STAMPED),
  kind: (v) => oneOf(v, SOURCE_KINDS, 'source kind'),
  provider: (v) => oneOf(v, SOURCE_PROVIDERS, 'source provider'),
  canonical_key: (v) => key(v),
  duration_ms: (v) => intOrNull(v, 'duration_ms'),
  live: (v) => (v === true ? 1 : 0),
  lesson_state: (v) => oneOf(v, LESSON_STATES, 'lesson state'),
  lesson_origin: (v) => (v === null ? null : oneOf(v, LESSON_ORIGINS, 'lesson origin')),
  confidence: (v) => oneOf(v, CONFIDENCES, 'confidence'),
  detected_via: (v) => oneOf(v, DETECTED_VIA, 'detected_via'),
  enrichment: (v) => enrichmentJson(v),
  track_state: (v) => oneOf(v, TRACK_STATES, 'track state'),
  track_language: (v) => textOrNull(v, 'track_language', MAX_LANG),
  transcript_plan: (v) => oneOf(v, PLANS, 'transcript plan'),
  superseded_session_ids: (v) => sessionIds(v),
  generated_title: (v) => textOrNull(v, 'generated_title', MAX_TITLE)
}

export function updateNoteSource(s: StoreCtx, noteId: string, patch: NoteSourceUpdate): NoteSource {
  id(noteId, 'noteId')
  if (typeof patch !== 'object' || patch === null) throw invalid('patch must be an object')
  const changed = inTransaction(s.db, () => {
    if (!getSourceRow(s, noteId)) throw notFound('note source', noteId)
    const sets: string[] = []
    const params: Record<string, unknown> = { note_id: noteId, now: nowIso() }
    for (const k of Object.keys(UPDATE_COLUMNS) as (keyof NoteSourceUpdate)[]) {
      if (!Object.hasOwn(patch, k) || patch[k] === undefined) continue
      sets.push(`${k} = @${k}`)
      params[k] = UPDATE_COLUMNS[k](patch[k], s)
    }
    if (!sets.length) return false
    s.db.prepare(`UPDATE note_sources SET ${sets.join(', ')}, updated_at = @now WHERE note_id = @note_id`).run(params)
    return true
  })
  if (changed) s.touch('note_sources', noteId)
  return getSourceRow(s, noteId) as NoteSource
}

export function deleteNoteSource(s: StoreCtx, noteId: string): boolean {
  id(noteId, 'noteId')
  const removed = inTransaction(s.db, () => {
    const n = s.db.prepare(`DELETE FROM note_sources WHERE note_id = ?`).run(noteId).changes
    const spans = s.db.prepare(`DELETE FROM source_spans WHERE note_id = ?`).run(noteId).changes
    return { n, spans }
  })
  if (removed.n) s.touch('note_sources', noteId)
  if (removed.spans) s.touch('source_spans', noteId)
  return removed.n > 0
}

export function findNotesBySource(s: StoreCtx, canonicalKey: CanonicalKey, opts?: { excludeNoteId?: string; limit?: number }): SourceNoteMatch[] {
  const k = key(canonicalKey, 'canonicalKey')
  const limit = opts?.limit === undefined ? DEFAULT_MATCHES : Math.floor(Number(opts.limit))
  if (!(limit >= 1 && limit <= 200)) throw invalid('limit must be 1–200')
  const exclude = opts?.excludeNoteId === undefined ? null : id(opts.excludeNoteId, 'excludeNoteId')
  const rows = s.db
    .prepare(
      `SELECT d.id, d.title, d.created_at, ns.confidence,
         (SELECT max(sp.wall_end) FROM source_spans sp WHERE sp.note_id = d.id) AS last_wall,
         (SELECT sp.pos_end_ms FROM source_spans sp WHERE sp.note_id = d.id ORDER BY sp.wall_end DESC, sp.rid DESC LIMIT 1) AS last_pos
       FROM note_sources ns JOIN documents d ON d.id = ns.note_id
       WHERE ns.canonical_key = @key AND ${OWN_NOTE} AND (@exclude IS NULL OR d.id != @exclude)
       ORDER BY d.created_at DESC, d.id ASC
       LIMIT @limit`
    )
    .all({ ...scope(s), key: k, exclude, limit }) as Row[]
  return rows.map((r) => ({
    noteId: String(r['id']),
    title: str(r['title']),
    createdAt: String(r['created_at']),
    confidence: pick(r['confidence'], CONFIDENCES, 'guess'),
    lastWatchedAt: isoOfMs(num(r['last_wall'])),
    lastPositionMs: num(r['last_pos'])
  }))
}

export function listNoteSources(s: StoreCtx, q: { seriesId?: string; noteIds?: string[] }): NoteSource[] {
  if (typeof q !== 'object' || q === null) throw invalid('query must be an object')
  const seriesId = q.seriesId === undefined ? null : id(q.seriesId, 'seriesId')
  let ids: string | null = null
  if (q.noteIds !== undefined) {
    if (!Array.isArray(q.noteIds) || q.noteIds.length > MAX_QUERY_IDS || q.noteIds.some((n) => typeof n !== 'string')) {
      throw invalid(`noteIds must be at most ${MAX_QUERY_IDS} ids`)
    }
    if (!q.noteIds.length) return []
    ids = JSON.stringify(q.noteIds)
  }
  if (seriesId === null && ids === null) throw invalid('seriesId or noteIds is required')
  const rows = s.db
    .prepare(
      `SELECT ${SOURCE_SELECT} FROM note_sources ns JOIN documents d ON d.id = ns.note_id
       WHERE ${OWN_NOTE}
         AND (@series IS NULL OR ns.series_id = @series)
         AND (@ids IS NULL OR ns.note_id IN (SELECT value FROM json_each(@ids)))
       ORDER BY d.created_at ASC, d.id ASC`
    )
    .all({ ...scope(s), series: seriesId, ids }) as Row[]
  return rows.map(toNoteSource)
}

// ---------- spans ----------

function spanValues(sp: NewSourceSpan): NewSourceSpan {
  if (typeof sp !== 'object' || sp === null) throw invalid('span must be an object')
  const ms = (v: unknown, what: string): number => {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > Number.MAX_SAFE_INTEGER) throw invalid(`${what} must be a number`)
    return Math.round(v)
  }
  const wallStart = ms(sp.wall_start, 'wall_start')
  const wallEnd = ms(sp.wall_end, 'wall_end')
  if (wallEnd < wallStart) throw invalid('wall_end is before wall_start')
  if (typeof sp.rate !== 'number' || !(sp.rate > 0 && sp.rate <= 16)) throw invalid('rate must be above 0 and at most 16')
  return { wall_start: wallStart, wall_end: wallEnd, pos_start_ms: ms(sp.pos_start_ms, 'pos_start_ms'), pos_end_ms: ms(sp.pos_end_ms, 'pos_end_ms'), rate: sp.rate }
}

/** Position ranges this close count as touching when two capped spans merge. */
const SPAN_TOUCH_MS = 2_000

/**
 * Keeps a note at the span cap: the oldest spans merge pairwise (the first's wall start, the
 * second's wall end and rate) until the count fits. Their positions become the union when the
 * two ranges overlap or touch; otherwise the longer range is kept, so a seek never inflates the
 * watched share. Returns how many rows went.
 */
function capSpans(s: StoreCtx, noteId: string): number {
  const count = (s.db.prepare(`SELECT count(*) AS n FROM source_spans WHERE note_id = ?`).get(noteId) as { n: number }).n
  const excess = count - SOURCES_LIMITS.spansPerNote
  if (excess <= 0) return 0
  const oldest = s.db
    .prepare(`SELECT rid, wall_end, pos_start_ms, pos_end_ms, rate FROM source_spans WHERE note_id = ? ORDER BY wall_start, rid LIMIT ?`)
    .all(noteId, excess * 2) as { rid: number; wall_end: number; pos_start_ms: number; pos_end_ms: number; rate: number }[]
  const widen = s.db.prepare(`UPDATE source_spans SET wall_end = ?, pos_start_ms = ?, pos_end_ms = ?, rate = ? WHERE rid = ?`)
  const drop = s.db.prepare(`DELETE FROM source_spans WHERE rid = ?`)
  let merged = 0
  for (let i = 0; i + 1 < oldest.length; i += 2) {
    const [a, b] = [oldest[i]!, oldest[i + 1]!]
    const [as, ae] = [Math.min(a.pos_start_ms, a.pos_end_ms), Math.max(a.pos_start_ms, a.pos_end_ms)]
    const [bs, be] = [Math.min(b.pos_start_ms, b.pos_end_ms), Math.max(b.pos_start_ms, b.pos_end_ms)]
    const touching = bs <= ae + SPAN_TOUCH_MS && be >= as - SPAN_TOUCH_MS
    const [ps, pe] = touching ? [Math.min(as, bs), Math.max(ae, be)] : be - bs > ae - as ? [bs, be] : [as, ae]
    widen.run(b.wall_end, ps, pe, b.rate, a.rid)
    drop.run(b.rid)
    merged++
  }
  return merged
}

export function addSourceSpans(s: StoreCtx, noteId: string, spans: NewSourceSpan[]): { added: number; merged: number } {
  id(noteId, 'noteId')
  if (!Array.isArray(spans) || spans.length > MAX_SPANS_PER_CALL) throw invalid(`spans must be at most ${MAX_SPANS_PER_CALL} spans`)
  if (!spans.length) return { added: 0, merged: 0 }
  const clean = spans.map(spanValues)
  const res = inTransaction(s.db, () => {
    ownNoteRow(s, noteId)
    const now = nowIso()
    const insert = s.db.prepare(
      `INSERT INTO source_spans (id, workspace_id, owner_id, note_id, wall_start, wall_end, pos_start_ms, pos_end_ms, rate, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    for (const sp of clean) {
      insert.run(randomUUID(), s.identity.workspaceId, s.identity.ownerId, noteId, sp.wall_start, sp.wall_end, sp.pos_start_ms, sp.pos_end_ms, sp.rate, now)
    }
    return { added: clean.length, merged: capSpans(s, noteId) }
  })
  s.touch('source_spans', noteId)
  if (res.merged) s.log('info', 'sources:spans-merged', { noteId, merged: res.merged })
  return res
}

export function listSourceSpans(s: StoreCtx, noteId: string): SourceSpan[] {
  id(noteId, 'noteId')
  return spansByNote(s, [noteId]).get(noteId) ?? []
}

// ---------- series ----------

export function getSeries(s: StoreCtx, seriesId: string): SourceSeries | null {
  const r = s.db.prepare(`SELECT ${SERIES_COLS} FROM source_series WHERE id = @id AND ${OWN_ROW}`).get({ ...scope(s), id: id(seriesId, 'seriesId') }) as
    | Row
    | undefined
  return r ? toSeries(r) : null
}

/** The ids of the local owner's series filed into these folders (read before a folder delete). */
export function seriesInFolders(s: StoreCtx, folderIds: string[]): string[] {
  if (!folderIds.length) return []
  return rowIds(s, `SELECT id FROM source_series WHERE folder_id IN (SELECT value FROM json_each(@folders)) AND ${OWN_ROW}`, {
    ...scope(s),
    folders: JSON.stringify(folderIds)
  })
}

export function findSeriesByFolder(s: StoreCtx, folderId: string): SourceSeries | null {
  const r = s.db
    .prepare(
      `SELECT ${SERIES_COLS} FROM source_series WHERE folder_id = @folder AND owner_id = @owner AND workspace_id = @workspace
       ORDER BY created_at ASC, rid ASC LIMIT 1`
    )
    .get({ ...scope(s), folder: id(folderId, 'folderId') }) as Row | undefined
  return r ? toSeries(r) : null
}

export function upsertSeries(s: StoreCtx, input: NewSourceSeries): { series: SourceSeries; created: boolean } {
  if (typeof input !== 'object' || input === null) throw invalid('series must be an object')
  const kind = oneOf(input.kind, SERIES_KINDS, 'series kind')
  const provider = oneOf(input.provider, SOURCE_PROVIDERS, 'source provider')
  const canonicalKey = key(input.canonical_key)
  const title = text(input.title ?? '', 'title', MAX_TITLE).trim()
  const folderId = input.folder_id === undefined || input.folder_id === null ? null : id(input.folder_id, 'folder_id')
  const state = input.state === undefined ? 'active' : oneOf(input.state, SERIES_STATES, 'series state')
  const res = inTransaction(s.db, () => {
    const found = s.db
      .prepare(`SELECT ${SERIES_COLS} FROM source_series WHERE owner_id = ? AND kind = ? AND provider = ? AND canonical_key = ?`)
      .get(s.identity.ownerId, kind, provider, canonicalKey) as Row | undefined
    if (found) {
      const series = toSeries(found)
      if (!series.title && title) {
        s.db.prepare(`UPDATE source_series SET title = ?, updated_at = ? WHERE id = ?`).run(title, nowIso(), series.id)
        return { id: series.id, created: false, changed: true }
      }
      return { id: series.id, created: false, changed: false }
    }
    if (folderId) requireFolderRow(s, folderId)
    const sid = randomUUID()
    const now = nowIso()
    s.db
      .prepare(
        `INSERT INTO source_series (id, workspace_id, owner_id, kind, provider, canonical_key, title, folder_id, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(sid, s.identity.workspaceId, s.identity.ownerId, kind, provider, canonicalKey, title, folderId, state, now, now)
    return { id: sid, created: true, changed: true }
  })
  if (res.changed) s.touch('source_series', res.id)
  return { series: getSeries(s, res.id) as SourceSeries, created: res.created }
}

export function updateSeries(s: StoreCtx, seriesId: string, patch: SourceSeriesPatch): SourceSeries {
  id(seriesId, 'seriesId')
  if (typeof patch !== 'object' || patch === null) throw invalid('patch must be an object')
  const changed = inTransaction(s.db, () => {
    if (!getSeries(s, seriesId)) throw notFound('series', seriesId)
    const sets: string[] = []
    const params: Record<string, unknown> = { id: seriesId, now: nowIso() }
    if (patch.title !== undefined) {
      sets.push('title = @title')
      params['title'] = text(patch.title, 'title', MAX_TITLE).trim()
    }
    if (patch.folder_id !== undefined) {
      const folderId = patch.folder_id === null ? null : id(patch.folder_id, 'folder_id')
      if (folderId) requireFolderRow(s, folderId)
      sets.push('folder_id = @folder_id')
      params['folder_id'] = folderId
    }
    if (patch.state !== undefined) {
      sets.push('state = @state')
      params['state'] = oneOf(patch.state, SERIES_STATES, 'series state')
    }
    if (!sets.length) return false
    s.db.prepare(`UPDATE source_series SET ${sets.join(', ')}, updated_at = @now WHERE id = @id AND ${OWN_ROW}`).run({ ...params, ...scope(s) })
    return true
  })
  if (changed) s.touch('source_series', seriesId)
  return getSeries(s, seriesId) as SourceSeries
}

export function pauseSeries(s: StoreCtx, seriesId: string): SourceSeries {
  return updateSeries(s, seriesId, { state: 'paused' })
}

export function listSeries(s: StoreCtx): SeriesListItem[] {
  return seriesListItems(s, null)
}

/** One `listSeries` row, or null for an unknown series or another owner's. */
export function getSeriesListItem(s: StoreCtx, seriesId: string): SeriesListItem | null {
  return seriesListItems(s, id(seriesId, 'seriesId'))[0] ?? null
}

function seriesListItems(s: StoreCtx, seriesId: string | null): SeriesListItem[] {
  const rows = s.db
    .prepare(
      `SELECT ${SERIES_COLS.split(', ').map((c) => `ss.${c}`).join(', ')},
         (SELECT count(*) FROM note_sources ns JOIN documents d ON d.id = ns.note_id WHERE ns.series_id = ss.id AND ${OWN_NOTE}) AS note_count,
         (SELECT count(*) FROM series_catalog_items ci WHERE ci.series_id = ss.id) AS catalog_count,
         (SELECT count(*) FROM note_sources ns JOIN documents d ON d.id = ns.note_id
            WHERE ns.series_id = ss.id AND ns.lesson_state = 'pending' AND ${OWN_NOTE}) AS pending_count,
         (SELECT max(sp.wall_end) FROM source_spans sp JOIN note_sources ns ON ns.note_id = sp.note_id JOIN documents d ON d.id = ns.note_id
            WHERE ns.series_id = ss.id AND ${OWN_NOTE}) AS last_wall
       FROM source_series ss
       WHERE ss.owner_id = @owner AND ss.workspace_id = @workspace AND (@series IS NULL OR ss.id = @series)
       ORDER BY lower(ss.title), ss.created_at, ss.id`
    )
    .all({ ...scope(s), series: seriesId }) as Row[]
  return rows.map((r) => ({
    ...toSeries(r),
    noteCount: num(r['note_count']) ?? 0,
    catalogCount: num(r['catalog_count']) ?? 0,
    pendingCount: num(r['pending_count']) ?? 0,
    lastWatchedAt: isoOfMs(num(r['last_wall']))
  }))
}

/** Groups of own, non-trashed notes sharing a key, oldest note first; optionally one series. */
export function listSourceDuplicates(s: StoreCtx, q?: { seriesId?: string }): { canonicalKey: CanonicalKey; noteIds: string[] }[] {
  const seriesId = q?.seriesId === undefined ? null : id(q.seriesId, 'seriesId')
  const rows = s.db
    .prepare(
      `SELECT ns.canonical_key AS k, d.id FROM note_sources ns JOIN documents d ON d.id = ns.note_id
       WHERE ${OWN_NOTE} AND (@series IS NULL OR ns.series_id = @series)
         AND ns.canonical_key IN (
           SELECT ns2.canonical_key FROM note_sources ns2 JOIN documents d2 ON d2.id = ns2.note_id
           WHERE d2.deleted_at IS NULL AND d2.owner_id = @owner AND d2.workspace_id = @workspace AND d2.is_shared = 0
             AND (@series IS NULL OR ns2.series_id = @series)
           GROUP BY ns2.canonical_key HAVING count(*) > 1)
       ORDER BY ns.canonical_key, d.created_at ASC, d.id ASC`
    )
    .all({ ...scope(s), series: seriesId }) as Row[]
  const groups = new Map<string, string[]>()
  for (const r of rows) {
    const k = String(r['k'])
    const list = groups.get(k)
    if (list) list.push(String(r['id']))
    else groups.set(k, [String(r['id'])])
  }
  return [...groups].map(([canonicalKey, noteIds]) => ({ canonicalKey, noteIds }))
}

/**
 * Lessons in catalog order. Each catalog item takes the series' note with its key, else its URL,
 * else its number (a `numbered` lesson); the notes left over follow by lesson number, then age.
 * Notes sharing a key show once (the oldest) and are listed as duplicates.
 */
export function getSeriesDetail(s: StoreCtx, seriesId: string): SeriesDetail | null {
  const series = getSeries(s, seriesId)
  if (!series) return null
  const catalog = listCatalog(s, seriesId)
  const notes = listNoteSources(s, { seriesId })
  const spans = spansByNote(s, notes.map((n) => n.note_id))
  const duplicates = listSourceDuplicates(s, { seriesId })
  const shown = new Map<string, NoteSource>()
  for (const n of notes) if (!shown.has(n.canonical_key)) shown.set(n.canonical_key, n)
  const unused = new Set([...shown.values()].map((n) => n.note_id))
  // Per match value, the shown notes that have it in age order; taken notes are skipped lazily.
  const index = <K>(keyOf: (n: NoteSource) => K | null): Map<K, NoteSource[]> => {
    const m = new Map<K, NoteSource[]>()
    for (const n of shown.values()) {
      const k = keyOf(n)
      if (k === null) continue
      const list = m.get(k)
      if (list) list.push(n)
      else m.set(k, [n])
    }
    return m
  }
  const firstUnused = <K>(m: Map<K, NoteSource[]>, k: K): NoteSource | undefined => {
    const list = m.get(k)
    while (list?.length && !unused.has(list[0]!.note_id)) list.shift()
    return list?.[0]
  }
  const byKey = index((n) => n.canonical_key)
  const byUrl = index((n) => n.url)
  const byNumber = index((n) => (n.lesson_state === 'numbered' ? n.lesson_number : null))
  const matched = new Map<string, NoteSource>()
  const take = (itemId: string, n: NoteSource | undefined): void => {
    if (!n || !unused.has(n.note_id) || matched.has(itemId)) return
    matched.set(itemId, n)
    unused.delete(n.note_id)
  }
  const available = (): NoteSource[] => [...shown.values()].filter((n) => unused.has(n.note_id))
  for (const it of catalog) if (it.canonical_key) take(it.id, firstUnused(byKey, it.canonical_key))
  for (const it of catalog) if (it.url) take(it.id, firstUnused(byUrl, it.url))
  for (const it of catalog) if (it.number !== null) take(it.id, firstUnused(byNumber, it.number))
  const lessonOf = (n: NoteSource): Pick<SeriesLesson, 'noteId' | 'lessonState' | 'watchedPercent' | 'lastWatchedAt'> => {
    const sp = spans.get(n.note_id) ?? []
    return { noteId: n.note_id, lessonState: n.lesson_state, watchedPercent: watchedPercent(sp, n.duration_ms, n.live), lastWatchedAt: isoOfMs(lastWall(sp)) }
  }
  const lessons: SeriesLesson[] = catalog.map((it) => {
    const n = matched.get(it.id)
    return {
      catalogItemId: it.id,
      number: it.number ?? n?.lesson_number ?? null,
      label: n?.lesson_label ?? null,
      section: it.section,
      title: it.title || n?.title || '',
      url: it.url ?? n?.url ?? null,
      canonicalKey: it.canonical_key ?? n?.canonical_key ?? null,
      durationMs: it.duration_ms ?? n?.duration_ms ?? null,
      ...(n ? lessonOf(n) : { noteId: null, lessonState: null, watchedPercent: null, lastWatchedAt: null })
    }
  })
  const rest = available().sort(
    (a, b) =>
      (a.lesson_number ?? Number.MAX_SAFE_INTEGER) - (b.lesson_number ?? Number.MAX_SAFE_INTEGER) ||
      a.created_at.localeCompare(b.created_at)
  )
  for (const n of rest) {
    lessons.push({
      catalogItemId: null,
      number: n.lesson_number,
      label: n.lesson_label,
      section: null,
      title: n.title,
      url: n.url,
      canonicalKey: n.canonical_key,
      durationMs: n.duration_ms,
      ...lessonOf(n)
    })
  }
  return { series, lessons, duplicates }
}

// ---------- catalog ----------

export function listCatalog(s: StoreCtx, seriesId: string): CatalogItem[] {
  const rows = s.db
    .prepare(`SELECT ${CATALOG_COLS} FROM series_catalog_items WHERE series_id = @series AND ${OWN_ROW} ORDER BY position`)
    .all({ ...scope(s), series: id(seriesId, 'seriesId') }) as Row[]
  return rows.map(toCatalogItem)
}

export function replaceCatalog(s: StoreCtx, seriesId: string, items: NewCatalogItem[]): CatalogItem[] {
  id(seriesId, 'seriesId')
  if (!Array.isArray(items) || items.length > SOURCES_LIMITS.catalogItems) throw invalid(`a catalog has at most ${SOURCES_LIMITS.catalogItems} items`)
  const clean = items.map((it) => {
    if (typeof it !== 'object' || it === null) throw invalid('catalog item must be an object')
    return {
      number: intOrNull(it.number, 'number'),
      section: textOrNull(it.section, 'section', MAX_SECTION),
      title: text(it.title ?? '', 'title', MAX_TITLE).trim(),
      url: url(it.url),
      canonical_key: it.canonical_key === null || it.canonical_key === undefined ? null : key(it.canonical_key),
      duration_ms: intOrNull(it.duration_ms, 'duration_ms')
    }
  })
  inTransaction(s.db, () => {
    requireSeriesRow(s, seriesId)
    s.db.prepare(`DELETE FROM series_catalog_items WHERE series_id = ?`).run(seriesId)
    const now = nowIso()
    const insert = s.db.prepare(
      `INSERT INTO series_catalog_items (id, workspace_id, owner_id, series_id, position, number, section, title, url, canonical_key,
         duration_ms, created_at, updated_at)
       VALUES (@id, @workspace, @owner, @series, @position, @number, @section, @title, @url, @canonical_key, @duration_ms, @now, @now)`
    )
    clean.forEach((it, position) => insert.run({ id: randomUUID(), ...scope(s), series: seriesId, position, ...it, now }))
  })
  s.touch('series_catalog_items', seriesId)
  return listCatalog(s, seriesId)
}

export function deleteCatalog(s: StoreCtx, seriesId: string): number {
  const n = s.db
    .prepare(`DELETE FROM series_catalog_items WHERE series_id = @series AND ${OWN_ROW}`)
    .run({ ...scope(s), series: id(seriesId, 'seriesId') }).changes
  if (n) s.touch('series_catalog_items', seriesId)
  return n
}

export function findCatalogItem(s: StoreCtx, seriesId: string, q: { canonicalKey?: string | null; url?: string | null }): CatalogItem | null {
  id(seriesId, 'seriesId')
  const k = q?.canonicalKey ? key(q.canonicalKey, 'canonicalKey') : null
  const u = q?.url ? text(q.url, 'url', MAX_URL) : null
  const one = (where: string, v: string): CatalogItem | null => {
    const r = s.db
      .prepare(`SELECT ${CATALOG_COLS} FROM series_catalog_items WHERE series_id = @series AND ${OWN_ROW} AND ${where} = @v ORDER BY position LIMIT 1`)
      .get({ ...scope(s), series: seriesId, v }) as Row | undefined
    return r ? toCatalogItem(r) : null
  }
  return (k ? one('canonical_key', k) : null) ?? (u ? one('url', u) : null)
}

export function applyLessonNumbers(s: StoreCtx, rows: LessonNumberUpdate[], opts?: { onlyUnsettled?: boolean }): number {
  if (!Array.isArray(rows) || rows.length > SOURCES_LIMITS.catalogItems) throw invalid(`at most ${SOURCES_LIMITS.catalogItems} rows`)
  const onlyUnsettled = opts?.onlyUnsettled !== false
  const clean = rows.map((r) => {
    if (typeof r !== 'object' || r === null) throw invalid('row must be an object')
    return {
      note_id: id(r.noteId, 'noteId'),
      lesson_number: intOrNull(r.lesson_number, 'lesson_number'),
      lesson_label: textOrNull(r.lesson_label, 'lesson_label', MAX_LABEL),
      lesson_state: oneOf(r.lesson_state, LESSON_STATES, 'lesson state'),
      lesson_origin: r.lesson_origin === null || r.lesson_origin === undefined ? null : oneOf(r.lesson_origin, LESSON_ORIGINS, 'lesson origin')
    }
  })
  const changed = inTransaction(s.db, () => {
    const now = nowIso()
    const stmt = s.db.prepare(
      `UPDATE note_sources SET lesson_number = @lesson_number, lesson_label = @lesson_label, lesson_state = @lesson_state,
         lesson_origin = @lesson_origin, updated_at = @now
       WHERE note_id = @note_id AND (lesson_origin IS NULL OR lesson_origin != 'manual')
         AND (@unsettled = 0 OR lesson_state IN ('pending', 'guessed'))`
    )
    return clean.filter((r) => stmt.run({ ...r, now, unsettled: onlyUnsettled ? 1 : 0 }).changes > 0).map((r) => r.note_id)
  })
  if (changed.length) s.touch('note_sources', ...changed)
  return changed.length
}

// ---------- merge ----------

/**
 * The refusal of a merge whose newer note has recordings: their files live under that note's
 * id, so they can't move with its sessions yet, and a purge of the trashed note would delete
 * them. `invalid-input`, worded for the UI.
 */
export const MERGE_RECORDINGS_REFUSAL = "The newer note has recordings, so these notes can't be merged yet."

/** A tag the merge set on the kept note, and the tag of that category it replaced (null: none). */
interface MergeTag {
  before: DocumentTag | null
  after: DocumentTag
}

/** What a merge moved, kept to undo it. */
interface MergeUndo {
  sessionIds: string[]
  spanIds: string[]
  panelIds: string[]
  attachmentIds: string[]
  folderIds: string[]
  /** The people added to the kept note's attendees, exactly as added. */
  attendees: NotePerson[]
  tags: MergeTag[]
  /** The newer note's superseded sessions added to the kept note's source. */
  supersededIds: string[]
  audioImportIds: string[]
  /** The speaker-name suggestions moved to the kept note, by speaker key. */
  speakerKeys?: string[]
}

const personKey = (p: NotePerson): string | null => {
  const k = (typeof p?.email === 'string' && p.email.trim()) || (typeof p?.name === 'string' && p.name.trim()) || ''
  return k ? k.toLowerCase() : null
}

function extraJson(v: unknown): string | null {
  if (v === undefined || v === null) return null
  const json = JSON.stringify(v)
  if (json === undefined || json.length > MAX_EXTRA_BYTES) throw invalid('extra is too large')
  return json
}

function rowIds(s: StoreCtx, sql: string, ...params: unknown[]): string[] {
  return (s.db.prepare(sql).all(...params) as Row[]).map((r) => String(r['id']))
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

function noteTags(s: StoreCtx, noteId: string): DocumentTag[] {
  const raw = parseJson<unknown>((s.db.prepare(`SELECT tags FROM documents WHERE id = ?`).get(noteId) as Row | undefined)?.['tags'], [])
  return Array.isArray(raw) ? raw.filter((t): t is DocumentTag => typeof t === 'object' && t !== null && typeof (t as DocumentTag).category === 'string') : []
}

const sameTag = (a: DocumentTag, b: DocumentTag): boolean => a.category === b.category && a.value === b.value && a.source === b.source

const TAG_ORDER: readonly string[] = ['meeting_kind', 'is_sensitive']

/** Writes a note's tags in the category order `tags-repo` uses. */
function writeTags(s: StoreCtx, noteId: string, tags: DocumentTag[]): void {
  const rank = (t: DocumentTag): number => {
    const i = TAG_ORDER.indexOf(t.category)
    return i < 0 ? TAG_ORDER.length : i
  }
  s.db.prepare(`UPDATE documents SET tags = ? WHERE id = ?`).run(JSON.stringify([...tags].sort((x, y) => rank(x) - rank(y))), noteId)
}

function setSuperseded(s: StoreCtx, noteId: string, ids: string[], now: string): void {
  s.db.prepare(`UPDATE note_sources SET superseded_session_ids = ?, updated_at = ? WHERE note_id = ?`).run(JSON.stringify(ids), now, noteId)
}

/** A panel's `document_id` change doesn't fire the FTS triggers: requeue so the index row follows. */
function requeuePanels(s: StoreCtx, panelIds: string[], now: string): void {
  if (!panelIds.length) return
  s.db
    .prepare(`INSERT OR REPLACE INTO fts_queue (kind, row_id, queued_at) SELECT 'panel', value, ? FROM json_each(?)`)
    .run(now, JSON.stringify(panelIds))
}

function moveNoteAttachments(s: StoreCtx, from: string, to: string, ids: string[]): void {
  if (!ids.length) return
  s.db
    .prepare(`UPDATE attachments SET parent_id = ? WHERE parent_type = 'note' AND parent_id = ? AND id IN (SELECT value FROM json_each(?))`)
    .run(to, from, JSON.stringify(ids))
  const read = (noteId: string): unknown[] => {
    const raw = parseJson<unknown>((s.db.prepare(`SELECT attachments FROM documents WHERE id = ?`).get(noteId) as Row | undefined)?.['attachments'], [])
    return Array.isArray(raw) ? raw : []
  }
  const isMoved = (x: unknown): boolean => typeof x === 'object' && x !== null && ids.includes(String((x as { id?: unknown }).id))
  const fromList = read(from)
  const toList = read(to)
  const write = s.db.prepare(`UPDATE documents SET attachments = ? WHERE id = ?`)
  write.run(JSON.stringify(fromList.filter((x) => !isMoved(x))), from)
  write.run(JSON.stringify([...toList.filter((x) => !isMoved(x)), ...fromList.filter(isMoved)]), to)
}

export function mergeSourceNotes(
  s: StoreCtx,
  q: { noteIds: [string, string]; extra?: unknown }
): { mergeId: string; keptNoteId: string; trashedNoteId: string; moved: SourceMergeMoved } {
  if (typeof q !== 'object' || q === null || !Array.isArray(q.noteIds) || q.noteIds.length !== 2) throw invalid('noteIds must be two note ids')
  const [a, b] = [id(q.noteIds[0], 'noteIds'), id(q.noteIds[1], 'noteIds')]
  if (a === b) throw invalid('Choose two different notes')
  const extra = extraJson(q.extra)
  const res = inTransaction(s.db, () => {
    const rows = [ownNoteRow(s, a), ownNoteRow(s, b)]
    if (rows.some((r) => r['deleted_at'] !== null)) throw invalid('A note in Trash cannot be merged')
    rows.sort((x, y) => String(x['created_at']).localeCompare(String(y['created_at'])) || String(x['id']).localeCompare(String(y['id'])))
    const keep = String(rows[0]!['id'])
    const drop = String(rows[1]!['id'])
    const keepSource = getSourceRow(s, keep)
    const dropSource = getSourceRow(s, drop)
    if (!keepSource || !dropSource || keepSource.canonical_key !== dropSource.canonical_key) {
      throw invalid('Only notes linked to the same source can be merged')
    }
    if (s.db.prepare(`SELECT 1 FROM recordings WHERE note_id = ? LIMIT 1`).get(drop)) throw invalid(MERGE_RECORDINGS_REFUSAL)
    const now = nowIso()

    const sessionIds = [
      ...new Set([
        ...rowIds(s, `SELECT id FROM transcription_sessions WHERE document_id = ?`, drop),
        ...rowIds(s, `SELECT DISTINCT transcription_session_id AS id FROM transcript_chunks WHERE document_id = ?`, drop)
      ])
    ]
    s.db.prepare(`UPDATE transcription_sessions SET document_id = ? WHERE document_id = ?`).run(keep, drop)
    const chunks = s.db.prepare(`UPDATE transcript_chunks SET document_id = ?, updated_at = ? WHERE document_id = ?`).run(keep, now, drop).changes

    // The sessions the newer note had replaced stay hidden on the kept note.
    const supersededIds = dropSource.superseded_session_ids.filter((x) => sessionIds.includes(x) && !keepSource.superseded_session_ids.includes(x))
    if (supersededIds.length) setSuperseded(s, keep, [...keepSource.superseded_session_ids, ...supersededIds], now)

    const spanIds = rowIds(s, `SELECT id FROM source_spans WHERE note_id = ?`, drop)
    s.db.prepare(`UPDATE source_spans SET note_id = ? WHERE note_id = ?`).run(keep, drop)
    const spansMerged = capSpans(s, keep)

    const panelIds = rowIds(s, `SELECT id FROM note_panels WHERE document_id = ? AND deleted_at IS NULL`, drop)
    if (panelIds.length) {
      s.db.prepare(`UPDATE note_panels SET document_id = ? WHERE id IN (SELECT value FROM json_each(?))`).run(keep, JSON.stringify(panelIds))
      requeuePanels(s, panelIds, now)
    }

    const attachmentIds = rowIds(s, `SELECT id FROM attachments WHERE parent_type = 'note' AND parent_id = ?`, drop)
    moveNoteAttachments(s, drop, keep, attachmentIds)

    // `audio_imports` has no foreign key and goes with a purge: its provenance follows the sessions.
    const audioImportIds = rowIds(s, `SELECT id FROM audio_imports WHERE note_id = ?`, drop)
    if (audioImportIds.length) s.db.prepare(`UPDATE audio_imports SET note_id = ?, updated_at = ? WHERE note_id = ?`).run(keep, now, drop)

    // Speaker-name suggestions are keyed by the moved sessions' speakers, so they follow them,
    // after the kept note's own; a key the kept note already has keeps its own row.
    const speakerKeys = (
      s.db
        .prepare(
          `SELECT speaker_key FROM speaker_guesses WHERE document_id = ?
             AND speaker_key NOT IN (SELECT speaker_key FROM speaker_guesses WHERE document_id = ?)`
        )
        .all(drop, keep) as Row[]
    ).map((r) => String(r['speaker_key']))
    if (speakerKeys.length) {
      const base = Number((s.db.prepare(`SELECT COALESCE(MAX(position) + 1, 0) AS n FROM speaker_guesses WHERE document_id = ?`).get(keep) as Row)['n'])
      s.db
        .prepare(`UPDATE speaker_guesses SET document_id = ?, position = position + ? WHERE document_id = ? AND speaker_key IN (SELECT value FROM json_each(?))`)
        .run(keep, base, drop, JSON.stringify(speakerKeys))
    }

    const folderIds = rowIds(
      s,
      `SELECT fn.folder_id AS id FROM folder_notes fn WHERE fn.note_id = ?
         AND NOT EXISTS (SELECT 1 FROM folder_notes k WHERE k.folder_id = fn.folder_id AND k.note_id = ?)`,
      drop,
      keep
    )
    const addMember = s.db.prepare(`INSERT OR IGNORE INTO folder_notes (folder_id, note_id, created_at, source) VALUES (?, ?, ?, 'manual')`)
    for (const f of folderIds) addMember.run(f, keep, now)

    const keepPeople = parseJson<NotePeople | null>(rows[0]!['people'], null) ?? {}
    const dropPeople = parseJson<NotePeople | null>(rows[1]!['people'], null) ?? {}
    const have = new Set((keepPeople.attendees ?? []).map(personKey).filter((k): k is string => !!k))
    const added: NotePerson[] = []
    for (const p of [...(dropPeople.creator ? [dropPeople.creator] : []), ...(dropPeople.attendees ?? [])]) {
      const k = personKey(p)
      if (!k || have.has(k) || personKey(keepPeople.creator ?? {}) === k) continue
      have.add(k)
      added.push(p)
    }
    if (added.length) {
      const people: NotePeople = { ...keepPeople, attendees: [...(keepPeople.attendees ?? []), ...added] }
      s.db.prepare(`UPDATE documents SET people = ? WHERE id = ?`).run(JSON.stringify(people), keep)
    }

    // Tags unite: a category the kept note lacks comes over, and "sensitive" always wins.
    const keepTags = noteTags(s, keep)
    const tags: MergeTag[] = []
    for (const t of noteTags(s, drop)) {
      if (tags.some((x) => x.after.category === t.category)) continue
      const mine = keepTags.find((k) => k.category === t.category)
      if (!mine) tags.push({ before: null, after: t })
      else if (t.category === 'is_sensitive' && t.value === 'true' && mine.value !== 'true') tags.push({ before: mine, after: t })
    }
    if (tags.length) {
      const changed = new Set(tags.map((x) => x.after.category))
      writeTags(s, keep, [...keepTags.filter((k) => !changed.has(k.category)), ...tags.map((x) => x.after)])
    }

    s.db.prepare(`UPDATE documents SET updated_at = ? WHERE id = ?`).run(now, keep)
    s.db.prepare(`UPDATE documents SET deleted_at = ?, updated_at = ?, once_trashed = 1 WHERE id = ?`).run(now, now, drop)

    const undo: MergeUndo = { sessionIds, spanIds, panelIds, attachmentIds, folderIds, attendees: added, tags, supersededIds, audioImportIds, speakerKeys }
    const mergeId = randomUUID()
    s.db
      .prepare(
        `INSERT INTO source_merges (id, workspace_id, owner_id, kept_note_id, trashed_note_id, undo, extra, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(mergeId, s.identity.workspaceId, s.identity.ownerId, keep, drop, JSON.stringify(undo), extra, now)
    return {
      mergeId,
      keptNoteId: keep,
      trashedNoteId: drop,
      moved: {
        sessions: sessionIds.length,
        chunks,
        spans: spanIds.length,
        panels: panelIds.length,
        attachments: attachmentIds.length,
        folders: folderIds.length,
        attendees: added.length
      },
      tags: tags.length,
      superseded: supersededIds.length,
      audioImportIds,
      speakerGuesses: speakerKeys.length,
      spansMerged
    }
  })
  const notes = [res.keptNoteId, res.trashedNoteId]
  s.touch('documents', ...notes)
  s.touch('transcript_chunks', ...notes)
  s.touch('transcription_sessions', ...notes)
  s.touch('source_spans', ...notes)
  if (res.superseded) s.touch('note_sources', res.keptNoteId)
  if (res.moved.panels) s.touch('note_panels', ...notes)
  if (res.moved.attachments) s.touch('attachments', ...notes)
  if (res.moved.folders) s.touch('folder_notes', res.keptNoteId)
  if (res.audioImportIds.length) s.touch('audio_imports', ...res.audioImportIds)
  if (res.speakerGuesses) s.touch('speaker_guesses', ...notes)
  s.log('info', 'sources:merged', {
    mergeId: res.mergeId,
    ...res.moved,
    tags: res.tags,
    superseded: res.superseded,
    audioImports: res.audioImportIds.length,
    speakerGuesses: res.speakerGuesses,
    spansMerged: res.spansMerged
  })
  return { mergeId: res.mergeId, keptNoteId: res.keptNoteId, trashedNoteId: res.trashedNoteId, moved: res.moved }
}

function getMergeRow(s: StoreCtx, mergeId: string): Row | undefined {
  return s.db
    .prepare(
      `SELECT id, kept_note_id, trashed_note_id, undo, extra, created_at, undone_at FROM source_merges
       WHERE id = @id AND owner_id = @owner AND workspace_id = @workspace`
    )
    .get({ ...scope(s), id: id(mergeId, 'mergeId') }) as Row | undefined
}

export function getSourceMerge(s: StoreCtx, mergeId: string): SourceMergeRecord | null {
  const r = getMergeRow(s, mergeId)
  if (!r) return null
  return {
    mergeId: String(r['id']),
    keptNoteId: String(r['kept_note_id']),
    trashedNoteId: String(r['trashed_note_id']),
    extra: parseJson<unknown>(r['extra'], null),
    createdAt: String(r['created_at']),
    undoneAt: str(r['undone_at'])
  }
}

export function setSourceMergeExtra(s: StoreCtx, mergeId: string, extra: unknown): void {
  const json = extraJson(extra)
  const n = s.db
    .prepare(`UPDATE source_merges SET extra = @extra WHERE id = @id AND owner_id = @owner AND workspace_id = @workspace AND undone_at IS NULL`)
    .run({ ...scope(s), extra: json, id: id(mergeId, 'mergeId') }).changes
  if (!n) throw notFound('merge', mergeId)
}

export function undoSourceMerge(s: StoreCtx, mergeId: string): { keptNoteId: string; restoredNoteId: string; extra: unknown } {
  const res = inTransaction(s.db, () => {
    const r = getMergeRow(s, mergeId)
    // The record goes with either note's permanent delete.
    if (!r) throw notFound('merge', mergeId)
    if (r['undone_at'] !== null) throw invalid('This merge was already undone')
    const keep = String(r['kept_note_id'])
    const drop = String(r['trashed_note_id'])
    const u = parseJson<Partial<MergeUndo>>(r['undo'], {})
    const list = (v: unknown): string => JSON.stringify(strings(v))
    const now = nowIso()
    s.db
      .prepare(`UPDATE transcription_sessions SET document_id = ? WHERE document_id = ? AND id IN (SELECT value FROM json_each(?))`)
      .run(drop, keep, list(u.sessionIds))
    s.db
      .prepare(
        `UPDATE transcript_chunks SET document_id = ?, updated_at = ?
         WHERE document_id = ? AND transcription_session_id IN (SELECT value FROM json_each(?))`
      )
      .run(drop, now, keep, list(u.sessionIds))
    const superseded = strings(u.supersededIds)
    const keepSource = superseded.length ? getSourceRow(s, keep) : null
    if (keepSource) setSuperseded(s, keep, keepSource.superseded_session_ids.filter((x) => !superseded.includes(x)), now)
    s.db.prepare(`UPDATE source_spans SET note_id = ? WHERE note_id = ? AND id IN (SELECT value FROM json_each(?))`).run(drop, keep, list(u.spanIds))
    const panelIds = rowIds(s, `SELECT id FROM note_panels WHERE document_id = ? AND id IN (SELECT value FROM json_each(?))`, keep, list(u.panelIds))
    if (panelIds.length) {
      s.db.prepare(`UPDATE note_panels SET document_id = ? WHERE id IN (SELECT value FROM json_each(?))`).run(drop, JSON.stringify(panelIds))
      requeuePanels(s, panelIds, now)
    }
    moveNoteAttachments(s, keep, drop, strings(u.attachmentIds))
    const audioImportIds = rowIds(s, `SELECT id FROM audio_imports WHERE note_id = ? AND id IN (SELECT value FROM json_each(?))`, keep, list(u.audioImportIds))
    if (audioImportIds.length) {
      s.db.prepare(`UPDATE audio_imports SET note_id = ?, updated_at = ? WHERE id IN (SELECT value FROM json_each(?))`).run(drop, now, JSON.stringify(audioImportIds))
    }
    // A suggestion run on the kept note since may have rebuilt them: whatever rows still carry
    // the moved keys go back with their sessions.
    s.db
      .prepare(
        `UPDATE OR IGNORE speaker_guesses SET document_id = ? WHERE document_id = ? AND speaker_key IN (SELECT value FROM json_each(?))`
      )
      .run(drop, keep, list(u.speakerKeys))
    s.db.prepare(`DELETE FROM folder_notes WHERE note_id = ? AND folder_id IN (SELECT value FROM json_each(?))`).run(keep, list(u.folderIds))
    // Only the entries the merge added go, each once: a person added again since stays.
    const added = Array.isArray(u.attendees) ? u.attendees : []
    if (added.length) {
      const people = parseJson<NotePeople | null>((s.db.prepare(`SELECT people FROM documents WHERE id = ?`).get(keep) as Row)['people'], null)
      if (people?.attendees) {
        const attendees = [...people.attendees]
        for (const p of added) {
          const i = attendees.findIndex((x) => JSON.stringify(x) === JSON.stringify(p))
          if (i >= 0) attendees.splice(i, 1)
        }
        if (attendees.length !== people.attendees.length) s.db.prepare(`UPDATE documents SET people = ? WHERE id = ?`).run(JSON.stringify({ ...people, attendees }), keep)
      }
    }
    // A tag changed since the merge is the user's: it stays.
    const tagChanges = Array.isArray(u.tags) ? u.tags : []
    if (tagChanges.length) {
      let tags = noteTags(s, keep)
      let changed = false
      for (const x of tagChanges) {
        const cur = tags.find((t) => t.category === x.after?.category)
        if (!cur || !sameTag(cur, x.after)) continue
        tags = [...tags.filter((t) => t !== cur), ...(x.before ? [x.before] : [])]
        changed = true
      }
      if (changed) writeTags(s, keep, tags)
    }
    s.db.prepare(`UPDATE documents SET updated_at = ? WHERE id = ?`).run(now, keep)
    s.db.prepare(`UPDATE documents SET deleted_at = NULL, updated_at = ?, once_trashed = 0 WHERE id = ?`).run(now, drop)
    s.db.prepare(`UPDATE source_merges SET undone_at = ? WHERE id = ?`).run(now, mergeId)
    return { keptNoteId: keep, restoredNoteId: drop, extra: parseJson<unknown>(r['extra'], null), audioImportIds }
  })
  const notes = [res.keptNoteId, res.restoredNoteId]
  for (const t of ['documents', 'transcript_chunks', 'transcription_sessions', 'note_sources', 'source_spans', 'note_panels', 'attachments', 'folder_notes', 'speaker_guesses']) {
    s.touch(t, ...notes)
  }
  if (res.audioImportIds.length) s.touch('audio_imports', ...res.audioImportIds)
  s.log('info', 'sources:merge-undone', { mergeId })
  return { keptNoteId: res.keptNoteId, restoredNoteId: res.restoredNoteId, extra: res.extra }
}
