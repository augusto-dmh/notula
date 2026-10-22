// SPDX-License-Identifier: Apache-2.0
// The Markdown importer's history: `import_batches` and `import_items`. One item becomes one
// note, written in one transaction with its panels, transcript, folders and source, so a crash
// never leaves half a note. A batch keeps the root path and each item's relative path and hash
// for re-import matching and undo; Clear history removes them and keeps the notes.
//
// - `counts` is derived from the items' states on every item change.
// - Only one batch is queued or running at a time.
// - States follow the transition tables (`BATCH_NEXT`, `ITEM_NEXT`): `done` is set only by
//   `importNoteItem` and `undone` only by `undoImportBatch`, so an item imports once and a batch
//   undoes once.
// - Logs carry ids, states and counts only, never paths, titles or content.

import { randomUUID } from 'node:crypto'
import type { CreationSource, DocumentTag, NotePeople } from '@shared/types/notes'
import type { AudioSource } from '@shared/types/common'
import {
  IMPORT_LIMITS,
  type CandidateLink,
  type CandidateRole,
  type ImportBatch,
  type ImportBatchState,
  type ImportCounts,
  type ImportFolderMode,
  type ImportFormat,
  type ImportItem,
  type ImportItemState,
  type ImportOptions,
  type ImportPreset,
  type ImportUndoPreview
} from '@shared/types/imports-markdown'
import type {
  ImportBatchPatch,
  ImportCandidateRow,
  ImportItemPatch,
  ImportMatches,
  ImportNotePayload,
  NewImportBatch,
  NewImportItem,
  NewPanel
} from './api'
import { addNotesToFolder, deleteFolder } from './folders-repo'
import { createPanel } from './panels-repo'
import { nowIso, parseJson } from './rows'
import { seriesInFolders, writeNoteSource } from './sources-repo'
import { inTransaction, invalid, notFound, type StoreCtx } from './store'

type Row = Record<string, unknown>

const PRESETS: readonly ImportPreset[] = ['auto', 'plain', 'obsidian', 'notula-export', 'study-vault']
const FORMATS: readonly ImportFormat[] = ['plain', 'obsidian', 'notula-export', 'study-lesson', 'transcript-copy']
const FOLDER_MODES: readonly ImportFolderMode[] = ['mirror', 'single', 'none']
const BATCH_STATES: readonly ImportBatchState[] = ['queued', 'running', 'complete', 'cancelled', 'failed', 'undone']
const ITEM_STATES: readonly ImportItemState[] = ['planned', 'done', 'skipped', 'failed', 'undone']
const ROLES: readonly CandidateRole[] = ['source', 'series', 'reference', 'plain']
const CREATED_VIA: readonly CreationSource[] = ['macOS', 'Windows', 'desktop', 'unknown', 'chat_tool']
const SOURCES: readonly AudioSource[] = ['microphone', 'system']
const TAG_CATEGORIES = ['meeting_kind', 'is_sensitive']
/** The moves `updateImportBatch` and `updateImportItem` allow; keeping the same state is always allowed. */
const BATCH_NEXT: Record<ImportBatchState, readonly ImportBatchState[]> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['complete', 'cancelled', 'failed'],
  complete: [],
  cancelled: [],
  failed: [],
  undone: []
}
const ITEM_NEXT: Record<ImportItemState, readonly ImportItemState[]> = {
  planned: ['skipped', 'failed'],
  // A retry.
  failed: ['planned'],
  skipped: [],
  done: [],
  undone: []
}
/** The batch states in which items still change. */
const ACTIVE: readonly ImportBatchState[] = ['queued', 'running']
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const HASH = /^[0-9a-f]{64}$/i

const MAX_PATH = 4_000
const MAX_TITLE = 1_000
const MAX_REASON = 1_000
const MAX_TEXT = 4 * 1024 * 1024
const MAX_META_BYTES = 256 * 1024
const MAX_PANELS = 20
const MAX_FOLDERS = 20
const MAX_MATCH_KEYS = IMPORT_LIMITS.entries

const BATCH_COLS =
  'id, workspace_id, owner_id, root_path, preset, options, state, counts, created_folder_ids, error, created_at, updated_at, finished_at, undone_at'
const ITEM_COLS =
  'id, batch_id, workspace_id, owner_id, source_key, rel_path, format, content_hash, size_bytes, note_id, export_note_id, state, reason, candidates, meta, imported_title, created_at, updated_at'

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)
const pick = <T extends string>(v: unknown, list: readonly T[], fallback: T): T => (list.includes(v as T) ? (v as T) : fallback)
const scope = (s: StoreCtx): { owner: string; workspace: string } => ({ owner: s.identity.ownerId, workspace: s.identity.workspaceId })

// ---------- rows ----------

function toBatch(r: Row): ImportBatch {
  const counts = parseJson<Partial<ImportCounts>>(r['counts'], {})
  const options = parseJson<Partial<ImportOptions>>(r['options'], {})
  const folders = parseJson<unknown>(r['created_folder_ids'], [])
  return {
    id: String(r['id']),
    workspace_id: String(r['workspace_id']),
    owner_id: String(r['owner_id']),
    root_path: String(r['root_path']),
    preset: pick(r['preset'], PRESETS, 'auto'),
    options: {
      folderMode: pick(options.folderMode, FOLDER_MODES, 'mirror'),
      trash: options.trash === 'import-into-trash' ? 'import-into-trash' : 'skip',
      findSourcesAfter: options.findSourcesAfter !== false,
      includeOtherFiles: options.includeOtherFiles === true
    },
    state: pick(r['state'], BATCH_STATES, 'failed'),
    counts: {
      planned: Number(counts.planned ?? 0),
      done: Number(counts.done ?? 0),
      skipped: Number(counts.skipped ?? 0),
      failed: Number(counts.failed ?? 0)
    },
    created_folder_ids: Array.isArray(folders) ? folders.filter((x): x is string => typeof x === 'string') : [],
    error: str(r['error']),
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at']),
    finished_at: str(r['finished_at']),
    undone_at: str(r['undone_at'])
  }
}

function toItem(r: Row): ImportItem {
  const candidates = parseJson<unknown>(r['candidates'], [])
  const meta = parseJson<unknown>(r['meta'], {})
  return {
    id: String(r['id']),
    batch_id: String(r['batch_id']),
    workspace_id: String(r['workspace_id']),
    owner_id: String(r['owner_id']),
    source_key: String(r['source_key']),
    rel_path: String(r['rel_path']),
    format: pick(r['format'], FORMATS, 'plain'),
    content_hash: String(r['content_hash']),
    size_bytes: Number(r['size_bytes'] ?? 0),
    note_id: str(r['note_id']),
    export_note_id: str(r['export_note_id']),
    state: pick(r['state'], ITEM_STATES, 'failed'),
    reason: str(r['reason']),
    candidates: Array.isArray(candidates) ? (candidates as CandidateLink[]) : [],
    meta: meta && typeof meta === 'object' && !Array.isArray(meta) ? (meta as Record<string, unknown>) : {},
    imported_title: str(r['imported_title']),
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at'])
  }
}

// ---------- validation ----------

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

function iso(v: unknown, what: string): string {
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw invalid(`${what} must be a time`)
  return new Date(v).toISOString()
}

function uuidOrNew(v: unknown, what: string): string {
  if (v === undefined || v === null) return randomUUID()
  if (typeof v !== 'string' || !UUID.test(v)) throw invalid(`${what} must be a UUID`)
  return v.toLowerCase()
}

function hash(v: unknown): string {
  if (typeof v !== 'string' || !HASH.test(v)) throw invalid('content_hash must be a SHA-256 hex digest')
  return v.toLowerCase()
}

function options(v: unknown): ImportOptions {
  const o = (typeof v === 'object' && v !== null ? v : {}) as Partial<ImportOptions>
  return {
    folderMode: oneOf(o.folderMode ?? 'mirror', FOLDER_MODES, 'folder mode'),
    trash: o.trash === 'import-into-trash' ? 'import-into-trash' : 'skip',
    findSourcesAfter: o.findSourcesAfter !== false,
    includeOtherFiles: o.includeOtherFiles === true
  }
}

function candidatesJson(v: unknown): string {
  if (v === undefined || v === null) return '[]'
  if (!Array.isArray(v) || v.length > IMPORT_LIMITS.candidatesPerItem) throw invalid(`at most ${IMPORT_LIMITS.candidatesPerItem} candidates`)
  const out: CandidateLink[] = v.map((c: Partial<CandidateLink>) => {
    if (typeof c !== 'object' || c === null) throw invalid('candidate must be an object')
    const startMs = c.startMs === null || c.startMs === undefined ? null : Number(c.startMs)
    if (startMs !== null && !(Number.isFinite(startMs) && startMs >= 0)) throw invalid('candidate startMs must be a number')
    return {
      url: text(c.url, 'candidate url', 4_096),
      role: oneOf(c.role, ROLES, 'candidate role'),
      label: textOrNull(c.label, 'candidate label', 500),
      canonicalKey: textOrNull(c.canonicalKey, 'candidate canonicalKey', 2_100),
      startMs
    }
  })
  return JSON.stringify(out)
}

function metaJson(v: unknown): string {
  if (v === undefined || v === null) return '{}'
  if (typeof v !== 'object' || Array.isArray(v)) throw invalid('meta must be an object')
  const json = JSON.stringify(v)
  if (json.length > MAX_META_BYTES) throw invalid('meta is too large')
  return json
}

function itemValues(it: NewImportItem): Record<string, unknown> {
  if (typeof it !== 'object' || it === null) throw invalid('item must be an object')
  const size = Number(it.size_bytes)
  if (!(Number.isFinite(size) && size >= 0)) throw invalid('size_bytes must be a number')
  return {
    id: uuidOrNew(it.id, 'item id'),
    source_key: text(it.source_key, 'source_key', MAX_PATH),
    rel_path: text(it.rel_path, 'rel_path', MAX_PATH),
    format: oneOf(it.format, FORMATS, 'import format'),
    content_hash: hash(it.content_hash),
    size_bytes: Math.round(size),
    export_note_id: textOrNull(it.export_note_id, 'export_note_id', 200),
    candidates: candidatesJson(it.candidates),
    meta: metaJson(it.meta),
    imported_title: textOrNull(it.imported_title, 'imported_title', MAX_TITLE)
  }
}

function idList(v: unknown, what: string, max: number = MAX_MATCH_KEYS): string {
  if (!Array.isArray(v) || v.length > max || v.some((x) => typeof x !== 'string')) throw invalid(`${what} must be at most ${max} strings`)
  return JSON.stringify(v)
}

// ---------- batches and items ----------

/** The local owner's rows (no alias). */
const OWN_ROW = `owner_id = @owner AND workspace_id = @workspace`

function findBatchRow(s: StoreCtx, batchId: string): Row | undefined {
  return s.db.prepare(`SELECT ${BATCH_COLS} FROM import_batches WHERE id = @id AND ${OWN_ROW}`).get({ ...scope(s), id: batchId }) as Row | undefined
}

function batchRow(s: StoreCtx, batchId: string): Row {
  const r = findBatchRow(s, batchId)
  if (!r) throw notFound('import batch', batchId)
  return r
}

function itemRow(s: StoreCtx, itemId: string): Row {
  const r = s.db.prepare(`SELECT ${ITEM_COLS} FROM import_items WHERE id = @id AND ${OWN_ROW}`).get({ ...scope(s), id: itemId }) as Row | undefined
  if (!r) throw notFound('import item', itemId)
  return r
}

function batchState(r: Row): ImportBatchState {
  return pick(r['state'], BATCH_STATES, 'failed')
}

/** Rewrites the batch's counts from its items' states. */
function recount(s: StoreCtx, batchId: string, now: string): void {
  const counts: ImportCounts = { planned: 0, done: 0, skipped: 0, failed: 0 }
  const rows = s.db.prepare(`SELECT state, count(*) AS n FROM import_items WHERE batch_id = ? GROUP BY state`).all(batchId) as Row[]
  for (const r of rows) {
    const st = r['state'] as keyof ImportCounts
    if (st in counts) counts[st] = Number(r['n'])
  }
  s.db.prepare(`UPDATE import_batches SET counts = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(counts), now, batchId)
}

export function getImportBatch(s: StoreCtx, batchId: string): ImportBatch | null {
  if (typeof batchId !== 'string' || !batchId) throw invalid('batchId is required')
  const r = findBatchRow(s, batchId)
  return r ? toBatch(r) : null
}

export function listImportBatches(s: StoreCtx): ImportBatch[] {
  const rows = s.db
    .prepare(`SELECT ${BATCH_COLS} FROM import_batches WHERE owner_id = @owner AND workspace_id = @workspace ORDER BY created_at DESC, rid DESC`)
    .all(scope(s)) as Row[]
  return rows.map(toBatch)
}

export function listImportItems(s: StoreCtx, batchId: string, q?: { states?: ImportItemState[] }): ImportItem[] {
  if (typeof batchId !== 'string' || !batchId) throw invalid('batchId is required')
  const states = q?.states === undefined ? null : JSON.stringify(q.states.map((st) => oneOf(st, ITEM_STATES, 'item state')))
  const rows = s.db
    .prepare(
      `SELECT ${ITEM_COLS} FROM import_items WHERE batch_id = @batch AND ${OWN_ROW}
         AND (@states IS NULL OR state IN (SELECT value FROM json_each(@states)))
       ORDER BY rid`
    )
    .all({ ...scope(s), batch: batchId, states }) as Row[]
  return rows.map(toItem)
}

export function createImportBatch(s: StoreCtx, b: NewImportBatch): { batch: ImportBatch; items: ImportItem[] } {
  if (typeof b !== 'object' || b === null) throw invalid('batch must be an object')
  const batchId = uuidOrNew(b.id, 'batch id')
  const root = text(b.root_path, 'root_path', MAX_PATH)
  const preset = oneOf(b.preset, PRESETS, 'import preset')
  const opts = options(b.options)
  if (!Array.isArray(b.items) || b.items.length < 1 || b.items.length > IMPORT_LIMITS.itemsPerBatch) {
    throw invalid(`a batch has 1–${IMPORT_LIMITS.itemsPerBatch} items`)
  }
  const items = b.items.map(itemValues)
  inTransaction(s.db, () => {
    if (s.db.prepare(`SELECT 1 FROM import_batches WHERE state IN ('queued', 'running') LIMIT 1`).get()) {
      throw invalid('An import is already running')
    }
    const now = nowIso()
    const counts: ImportCounts = { planned: items.length, done: 0, skipped: 0, failed: 0 }
    s.db
      .prepare(
        `INSERT INTO import_batches (id, workspace_id, owner_id, root_path, preset, options, state, counts, created_folder_ids, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, '[]', ?, ?)`
      )
      .run(batchId, s.identity.workspaceId, s.identity.ownerId, root, preset, JSON.stringify(opts), JSON.stringify(counts), now, now)
    const insert = s.db.prepare(
      `INSERT INTO import_items (id, batch_id, workspace_id, owner_id, source_key, rel_path, format, content_hash, size_bytes, note_id,
         export_note_id, state, reason, candidates, meta, imported_title, created_at, updated_at)
       VALUES (@id, @batch, @workspace, @owner, @source_key, @rel_path, @format, @content_hash, @size_bytes, NULL,
         @export_note_id, 'planned', NULL, @candidates, @meta, @imported_title, @now, @now)`
    )
    for (const it of items) insert.run({ ...it, batch: batchId, ...scope(s), now })
  })
  s.touch('import_batches', batchId)
  s.touch('import_items', batchId)
  s.log('info', 'notes-import:batch-created', { batchId, items: items.length, preset })
  return { batch: toBatch(batchRow(s, batchId)), items: listImportItems(s, batchId) }
}

export function updateImportBatch(s: StoreCtx, batchId: string, patch: ImportBatchPatch): ImportBatch {
  if (typeof batchId !== 'string' || !batchId) throw invalid('batchId is required')
  if (typeof patch !== 'object' || patch === null) throw invalid('patch must be an object')
  const sets: string[] = []
  const params: Record<string, unknown> = { id: batchId }
  if (patch.state !== undefined) {
    sets.push('state = @state')
    params['state'] = oneOf(patch.state, BATCH_STATES, 'batch state')
  }
  if (patch.error !== undefined) {
    sets.push('error = @error')
    params['error'] = patch.error === null ? null : text(patch.error, 'error', MAX_REASON)
  }
  if (patch.created_folder_ids !== undefined) {
    sets.push('created_folder_ids = @folders')
    params['folders'] = idList(patch.created_folder_ids, 'created_folder_ids', 10_000)
  }
  if (patch.finished_at !== undefined) {
    sets.push('finished_at = @finished')
    params['finished'] = patch.finished_at === null ? null : iso(patch.finished_at, 'finished_at')
  }
  inTransaction(s.db, () => {
    const from = batchState(batchRow(s, batchId))
    const to = params['state'] as ImportBatchState | undefined
    if (to !== undefined && to !== from && !BATCH_NEXT[from].includes(to)) throw invalid(`An import can't go from ${from} to ${to}`)
    const now = nowIso()
    if (sets.length) s.db.prepare(`UPDATE import_batches SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run({ ...params, now })
    recount(s, batchId, now)
  })
  s.touch('import_batches', batchId)
  return toBatch(batchRow(s, batchId))
}

export function updateImportItem(s: StoreCtx, itemId: string, patch: ImportItemPatch): ImportItem {
  if (typeof itemId !== 'string' || !itemId) throw invalid('itemId is required')
  if (typeof patch !== 'object' || patch === null) throw invalid('patch must be an object')
  const sets: string[] = []
  const params: Record<string, unknown> = { id: itemId }
  if (patch.state !== undefined) {
    sets.push('state = @state')
    params['state'] = oneOf(patch.state, ITEM_STATES, 'item state')
  }
  if (patch.reason !== undefined) {
    sets.push('reason = @reason')
    params['reason'] = patch.reason === null ? null : text(patch.reason, 'reason', MAX_REASON)
  }
  if (patch.content_hash !== undefined) {
    sets.push('content_hash = @hash')
    params['hash'] = hash(patch.content_hash)
  }
  if (patch.candidates !== undefined) {
    sets.push('candidates = @candidates')
    params['candidates'] = candidatesJson(patch.candidates)
  }
  if (patch.meta !== undefined) {
    sets.push('meta = @meta')
    params['meta'] = metaJson(patch.meta)
  }
  const batchId = inTransaction(s.db, () => {
    const row = itemRow(s, itemId)
    const from = pick(row['state'], ITEM_STATES, 'failed')
    const to = params['state'] as ImportItemState | undefined
    if (to !== undefined && to !== from) {
      if (!ITEM_NEXT[from].includes(to)) throw invalid(`An import item can't go from ${from} to ${to}`)
      const batch = batchState(batchRow(s, String(row['batch_id'])))
      if (!ACTIVE.includes(batch)) throw invalid(`The import is ${batch}: its items no longer change`)
    }
    const now = nowIso()
    if (sets.length) s.db.prepare(`UPDATE import_items SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run({ ...params, now })
    recount(s, String(row['batch_id']), now)
    return String(row['batch_id'])
  })
  s.touch('import_items', batchId)
  s.touch('import_batches', batchId)
  return toItem(itemRow(s, itemId))
}

export function findImportMatches(s: StoreCtx, q: { sourceKeys: string[]; hashes: string[]; exportIds: string[] }): ImportMatches {
  if (typeof q !== 'object' || q === null) throw invalid('query must be an object')
  const keys = idList(q.sourceKeys ?? [], 'sourceKeys')
  const hashes = idList((q.hashes ?? []).map((h) => (typeof h === 'string' ? h.toLowerCase() : h)), 'hashes')
  const exportIds = idList(q.exportIds ?? [], 'exportIds')
  const rows = s.db
    .prepare(
      `SELECT ii.id, ii.batch_id, ii.source_key, ii.rel_path, ii.content_hash, ii.state, ii.note_id, d.id AS doc, d.deleted_at
       FROM import_items ii LEFT JOIN documents d ON d.id = ii.note_id
       WHERE ii.owner_id = @owner AND ii.workspace_id = @workspace AND ii.state IN ('done', 'undone')
         AND (ii.source_key IN (SELECT value FROM json_each(@keys)) OR ii.content_hash IN (SELECT value FROM json_each(@hashes)))
       ORDER BY ii.created_at DESC, ii.rid DESC`
    )
    .all({ ...scope(s), keys, hashes }) as Row[]
  const docs = s.db
    .prepare(`SELECT id, deleted_at FROM documents WHERE id IN (SELECT value FROM json_each(?))`)
    .all(exportIds) as Row[]
  return {
    items: rows.map((r) => ({
      id: String(r['id']),
      batch_id: String(r['batch_id']),
      source_key: String(r['source_key']),
      rel_path: String(r['rel_path']),
      content_hash: String(r['content_hash']),
      state: pick(r['state'], ITEM_STATES, 'done'),
      note_id: str(r['doc']),
      note_state: r['doc'] === null || r['doc'] === undefined ? 'purged' : r['deleted_at'] === null ? 'live' : 'trashed'
    })),
    exportNotes: docs.map((r) => ({ id: String(r['id']), state: r['deleted_at'] === null ? 'live' : 'trashed' }))
  }
}

// ---------- one note per item ----------

function peopleJson(v: unknown): string | null {
  if (v === undefined || v === null) return null
  if (typeof v !== 'object' || Array.isArray(v)) throw invalid('people must be an object')
  const p = v as NotePeople
  if (p.attendees !== undefined && (!Array.isArray(p.attendees) || p.attendees.length > 500)) throw invalid('at most 500 attendees')
  const json = JSON.stringify(p)
  if (json.length > MAX_META_BYTES) throw invalid('people is too large')
  return json
}

function tagsJson(v: unknown): string {
  if (v === undefined || v === null) return '[]'
  if (!Array.isArray(v)) throw invalid('tags must be a list')
  const out: DocumentTag[] = []
  for (const t of v as Partial<DocumentTag>[]) {
    if (typeof t !== 'object' || t === null || !TAG_CATEGORIES.includes(String(t.category)) || out.some((x) => x.category === t.category)) continue
    out.push({
      category: t.category as DocumentTag['category'],
      value: typeof t.value === 'string' ? t.value.slice(0, 200) : null,
      source: typeof t.source === 'string' ? t.source.slice(0, 100) : 'notula-local',
      updated_at: typeof t.updated_at === 'string' ? t.updated_at : nowIso()
    })
  }
  return JSON.stringify(out)
}

function panelOf(noteId: string, p: ImportNotePayload['panels'][number]): NewPanel {
  if (typeof p !== 'object' || p === null) throw invalid('panel must be an object')
  const md = text(p.content_markdown, 'content_markdown', MAX_TEXT)
  return {
    document_id: noteId,
    content_edited_at: null,
    deleted_at: null,
    title: text(p.title ?? '', 'panel title', MAX_TITLE),
    template_key: textOrNull(p.template_key, 'template_key', 200),
    content: null,
    content_markdown: md,
    generated_content: md,
    last_opened_at: null,
    crdt_version: 1,
    enhance_started_at: null,
    enhance_failed_at: null,
    enhance_error: null,
    speakers_attributed: false,
    ai_line_map: null
  }
}

export function importNoteItem(s: StoreCtx, p: ImportNotePayload): { noteId: string; item: ImportItem } {
  if (typeof p !== 'object' || p === null || typeof p.note !== 'object' || p.note === null) throw invalid('payload must be an object')
  if (typeof p.itemId !== 'string' || !p.itemId) throw invalid('itemId is required')
  const n = p.note
  const createdAt = iso(n.created_at, 'created_at')
  const updatedAt = iso(n.updated_at, 'updated_at')
  const note = {
    title: textOrNull(n.title, 'title', MAX_TITLE),
    created_at: createdAt,
    updated_at: updatedAt < createdAt ? createdAt : updatedAt,
    created_via: oneOf(n.created_via, CREATED_VIA, 'created_via'),
    notes_md: text(n.notes_md ?? '', 'notes_md', MAX_TEXT),
    notes_text: text(n.notes_text ?? '', 'notes_text', MAX_TEXT),
    people: peopleJson(n.people),
    tags: tagsJson(n.tags)
  }
  if (!Array.isArray(p.panels) || p.panels.length > MAX_PANELS) throw invalid(`at most ${MAX_PANELS} panels`)
  if (!Array.isArray(p.folderIds) || p.folderIds.length > MAX_FOLDERS || p.folderIds.some((f) => typeof f !== 'string' || !f)) {
    throw invalid(`at most ${MAX_FOLDERS} folder ids`)
  }
  const t = p.transcript
  let session: Record<string, unknown> | null = null
  let chunks: Record<string, unknown>[] = []
  if (t !== null && t !== undefined) {
    if (typeof t !== 'object' || typeof t.session !== 'object' || t.session === null || !Array.isArray(t.chunks)) throw invalid('transcript is invalid')
    if (t.chunks.length > IMPORT_LIMITS.chunksPerNote) throw invalid(`at most ${IMPORT_LIMITS.chunksPerNote} transcript chunks`)
    session = {
      id: uuidOrNew(t.session.id, 'session id'),
      provider: text(t.session.provider, 'provider', 50),
      model: text(t.session.model, 'model', 100),
      language: text(t.session.language ?? '', 'language', 35),
      started_at: iso(t.session.started_at, 'started_at'),
      ended_at: iso(t.session.ended_at, 'ended_at'),
      end_reason: text(t.session.end_reason, 'end_reason', 100)
    }
    chunks = t.chunks.map((c) => {
      if (typeof c !== 'object' || c === null) throw invalid('chunk must be an object')
      return {
        id: randomUUID(),
        source: oneOf(c.source, SOURCES, 'chunk source'),
        start: iso(c.start_timestamp, 'start_timestamp'),
        end: iso(c.end_timestamp, 'end_timestamp'),
        text: text(c.text, 'chunk text', 100_000),
        speaker: textOrNull(c.detected_speaker_name, 'detected_speaker_name', 300)
      }
    })
  }

  const res = inTransaction(s.db, () => {
    const item = itemRow(s, p.itemId)
    if (item['state'] !== 'planned') throw invalid('This item was already imported or skipped')
    const batchId = String(item['batch_id'])
    const batch = batchState(batchRow(s, batchId))
    if (!ACTIVE.includes(batch)) throw invalid(`The import is ${batch}: its items can't be imported`)
    let noteId: string = randomUUID()
    if (typeof n.id === 'string' && UUID.test(n.id) && !s.db.prepare(`SELECT 1 FROM documents WHERE id = ?`).get(n.id.toLowerCase())) {
      noteId = n.id.toLowerCase()
    }
    // A session id is kept only when free, like the note id (a re-import beside the original).
    if (session && s.db.prepare(`SELECT 1 FROM transcription_sessions WHERE id = ?`).get(session['id'])) session['id'] = randomUUID()
    s.db
      .prepare(
        `INSERT INTO documents (id, workspace_id, owner_id, created_at, updated_at, title, type, created_via, transcribe,
           notes, notes_text, notes_md, people, tags, is_shared)
         VALUES (@id, @workspace, @owner, @created_at, @updated_at, @title, 'meeting', @created_via, 0,
           NULL, @notes_text, @notes_md, @people, @tags, 0)`
      )
      .run({ id: noteId, ...scope(s), ...note })
    for (const panel of p.panels) createPanel(s, panelOf(noteId, panel))
    if (session) {
      s.db
        .prepare(
          `INSERT INTO transcription_sessions (id, document_id, workspace_id, owner_id, provider, model, language, started_at, ended_at, end_reason)
           VALUES (@id, @note, @workspace, @owner, @provider, @model, @language, @started_at, @ended_at, @end_reason)`
        )
        .run({ ...session, note: noteId, ...scope(s) })
      const insert = s.db.prepare(
        `INSERT INTO transcript_chunks (id, document_id, workspace_id, owner_id, transcription_session_id, source, start_timestamp,
           end_timestamp, text, is_final, detected_speaker_name, detected_speaker, provider_details, created_at, updated_at)
         VALUES (@id, @note, @workspace, @owner, @session, @source, @start, @end, @text, 1, @speaker, NULL, @details, @now, @now)`
      )
      const now = nowIso()
      // The session's provider and model ride on each chunk, so the transcript view can tell an
      // untimed import (`IMPORT_SESSION.untimed`) without a session read.
      const details = JSON.stringify({
        words: [],
        provider: session['provider'],
        model: session['model'],
        wallClockAnchorMs: Date.parse(String(session['started_at']))
      })
      for (const c of chunks) insert.run({ ...c, note: noteId, session: session['id'], ...scope(s), details, now })
    }
    for (const folderId of new Set(p.folderIds)) addNotesToFolder(s, folderId, [noteId], 'add_notes')
    if (p.source) writeNoteSource(s, { ...p.source, note_id: noteId }, false)
    if (n.trashed === true) {
      const now = nowIso()
      s.db.prepare(`UPDATE documents SET deleted_at = ?, once_trashed = 1 WHERE id = ?`).run(now, noteId)
    }
    const now = nowIso()
    s.db
      .prepare(`UPDATE import_items SET state = 'done', note_id = ?, imported_title = ?, reason = NULL, updated_at = ? WHERE id = ?`)
      .run(noteId, note.title, now, p.itemId)
    recount(s, batchId, now)
    return { noteId, batchId }
  })
  s.touch('documents', res.noteId)
  if (session) {
    s.touch('transcription_sessions', res.noteId)
    s.touch('transcript_chunks', res.noteId)
  }
  if (p.source) s.touch('note_sources', res.noteId)
  s.touch('import_items', res.batchId)
  s.touch('import_batches', res.batchId)
  return { noteId: res.noteId, item: toItem(itemRow(s, p.itemId)) }
}

// ---------- undo, history, candidates ----------

/** Live notes of the batch, flagged when their room exists, a panel changed, or the title changed. */
export function importUndoPreview(s: StoreCtx, batchId: string): ImportUndoPreview {
  const batch = toBatch(batchRow(s, batchId))
  const rows = s.db
    .prepare(
      `SELECT d.id, d.title,
         (d.title IS NOT ii.imported_title
          OR EXISTS (SELECT 1 FROM ydocs y WHERE y.room_id = 'notes:1:' || d.id)
          OR EXISTS (SELECT 1 FROM note_panels np WHERE np.document_id = d.id
                     AND (np.content_edited_at IS NOT NULL OR EXISTS (SELECT 1 FROM ydocs y2 WHERE y2.room_id = 'summary:1:' || np.id)))
         ) AS changed
       FROM import_items ii JOIN documents d ON d.id = ii.note_id
       WHERE ii.batch_id = ? AND ii.state = 'done' AND d.deleted_at IS NULL
       ORDER BY ii.rid`
    )
    .all(batchId) as Row[]
  const noteIds = rows.map((r) => String(r['id']))
  return {
    batchId,
    notes: rows.map((r) => ({ noteId: String(r['id']), title: str(r['title']), changedSinceImport: Number(r['changed']) === 1 })),
    foldersToDelete: emptyCreatedFolders(s, batch.created_folder_ids, noteIds).length
  }
}

/**
 * The batch-created folders that hold nothing but `leaving` notes (and no subfolders), the
 * subfolders first.
 */
function emptyCreatedFolders(s: StoreCtx, folderIds: string[], leaving: string[]): string[] {
  const check = s.db.prepare(
    `SELECT 1 FROM folders f WHERE f.id = @id
       AND NOT EXISTS (SELECT 1 FROM folders c WHERE c.parent_id = f.id AND c.id NOT IN (SELECT value FROM json_each(@gone)))
       AND NOT EXISTS (SELECT 1 FROM folder_notes fn JOIN documents d ON d.id = fn.note_id
                       WHERE fn.folder_id = f.id AND d.deleted_at IS NULL AND d.id NOT IN (SELECT value FROM json_each(@leaving)))`
  )
  const parentOf = s.db.prepare(`SELECT parent_id FROM folders WHERE id = ?`)
  const ordered = [...folderIds].sort((a, b) => {
    const pa = (parentOf.get(a) as Row | undefined)?.['parent_id'] ? 0 : 1
    const pb = (parentOf.get(b) as Row | undefined)?.['parent_id'] ? 0 : 1
    return pa - pb
  })
  const gone: string[] = []
  for (const fid of ordered) {
    if (check.get({ id: fid, gone: JSON.stringify(gone), leaving: JSON.stringify(leaving) })) gone.push(fid)
  }
  return gone
}

export function undoImportBatch(s: StoreCtx, batchId: string): { batch: ImportBatch; foldersDeleted: number } {
  const res = inTransaction(s.db, () => {
    const batch = toBatch(batchRow(s, batchId))
    if (batch.state === 'queued' || batch.state === 'running') throw invalid('Wait for the import to finish before undoing it')
    if (batch.state === 'undone') throw invalid('This import was already undone')
    const folders = emptyCreatedFolders(s, batch.created_folder_ids, [])
    // The folder trigger pauses these series inside SQLite; their change event is ours to send.
    const series = seriesInFolders(s, folders)
    for (const fid of folders) deleteFolder(s, fid)
    const now = nowIso()
    s.db.prepare(`UPDATE import_items SET state = 'undone', updated_at = ? WHERE batch_id = ? AND state = 'done'`).run(now, batchId)
    s.db.prepare(`UPDATE import_batches SET state = 'undone', undone_at = ?, updated_at = ? WHERE id = ?`).run(now, now, batchId)
    return { deleted: folders.length, series }
  })
  s.touch('import_batches', batchId)
  s.touch('import_items', batchId)
  if (res.series.length) s.touch('source_series', ...res.series)
  s.log('info', 'notes-import:batch-undone', { batchId, foldersDeleted: res.deleted })
  return { batch: toBatch(batchRow(s, batchId)), foldersDeleted: res.deleted }
}

export function clearImportHistory(s: StoreCtx): number {
  const ids = inTransaction(s.db, () =>
    (
      s.db
        .prepare(
          `DELETE FROM import_batches WHERE owner_id = @owner AND workspace_id = @workspace AND state NOT IN ('queued', 'running') RETURNING id`
        )
        .all(scope(s)) as Row[]
    ).map((r) => String(r['id']))
  )
  if (ids.length) {
    s.touch('import_batches', ...ids)
    s.touch('import_items', ...ids)
  }
  s.log('info', 'notes-import:history-cleared', { batches: ids.length })
  return ids.length
}

export function getImportCandidates(s: StoreCtx, noteIds: string[]): ImportCandidateRow[] {
  const ids = idList(noteIds, 'noteIds', 5_000)
  const rows = s.db
    .prepare(
      `SELECT ${ITEM_COLS} FROM import_items
       WHERE note_id IN (SELECT value FROM json_each(@ids)) AND ${OWN_ROW} AND state IN ('done', 'undone')
       ORDER BY created_at DESC, rid DESC`
    )
    .all({ ...scope(s), ids }) as Row[]
  const seen = new Set<string>()
  const out: ImportCandidateRow[] = []
  for (const r of rows) {
    const it = toItem(r)
    if (!it.note_id || seen.has(it.note_id)) continue
    seen.add(it.note_id)
    out.push({ noteId: it.note_id, itemId: it.id, batchId: it.batch_id, relPath: it.rel_path, format: it.format, candidates: it.candidates, meta: it.meta })
  }
  return out
}
