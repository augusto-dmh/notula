// SPDX-License-Identifier: Apache-2.0
// Dev-only check for the notes-list query: runs the old text (which selected `d.*` in its
// first CTE) and the narrowed one side by side on an in-memory database of synthetic notes,
// and asserts the same rows in the same order for every filter. Then times both on 1,200
// notes with ~10 KB bodies.
// Run: node scripts/dev/notes-list-check.ts   (Node's type stripping; exits 1 on a failure)

import { DatabaseSync } from 'node:sqlite'
import { notesListSql } from '../../src/main/storage/notes-list-sql.ts'
import { NOTE_LIST_COLUMNS } from '../../src/main/storage/rows.ts'

// The listable scope, as in notes-repo.ts.
const LISTABLE_SOURCES = ['macOS', 'Windows', 'desktop', 'shared_tab']
const LISTABLE = `
  d.deleted_at IS NULL
  AND d.owner_id = @owner AND d.workspace_id = @workspace
  AND (
    d.created_via IS NULL OR d.created_via = ''
    OR d.created_via IN (${LISTABLE_SOURCES.map((s) => `'${s}'`).join(', ')})
    OR EXISTS (SELECT 1 FROM note_panels p WHERE p.document_id = d.id AND p.deleted_at IS NULL)
  )`

/** The query as it was before the narrowing, kept as the fixture. */
function oldSql(): string {
  return `WITH listable AS (
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
}

const OWNER = 'owner-1'
const WORKSPACE = 'ws-1'

function schema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE documents (
      id TEXT PRIMARY KEY, title TEXT, created_at TEXT, updated_at TEXT, owner_id TEXT, workspace_id TEXT,
      linked_event TEXT, people TEXT, event_id TEXT, sort_epoch INTEGER, is_shared INTEGER NOT NULL DEFAULT 0,
      transcribe INTEGER NOT NULL DEFAULT 0, is_event_main_note INTEGER NOT NULL DEFAULT 0,
      deleted_at TEXT, created_via TEXT, notes TEXT, notes_md TEXT
    );
    CREATE TABLE note_panels (document_id TEXT, deleted_at TEXT);
    CREATE TABLE folder_notes (folder_id TEXT, note_id TEXT);
    CREATE TABLE document_tags (document_id TEXT, category TEXT, value TEXT);
  `)
}

interface Doc {
  id: string
  epoch: number
  owner?: string
  uid?: string
  eventId?: string
  main?: boolean
  shared?: boolean
  deleted?: boolean
  via?: string | null
  body?: string
}

function insert(db: DatabaseSync, d: Doc): void {
  const linked = d.eventId ? JSON.stringify({ id: d.eventId, ...(d.uid ? { iCalUID: d.uid } : {}) }) : null
  db.prepare(
    `INSERT INTO documents (id, title, created_at, updated_at, owner_id, workspace_id, linked_event, people, event_id,
       sort_epoch, is_shared, transcribe, is_event_main_note, deleted_at, created_via, notes, notes_md)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    d.id,
    `Example note ${d.id}`,
    '2026-01-01T00:00:00.000Z',
    '2026-01-02T00:00:00.000Z',
    d.owner ?? OWNER,
    WORKSPACE,
    linked,
    '[]',
    d.eventId ?? null,
    d.epoch,
    d.shared ? 1 : 0,
    1,
    d.main ? 1 : 0,
    d.deleted ? '2026-01-03T00:00:00.000Z' : null,
    d.via === undefined ? 'desktop' : d.via,
    d.body ?? '{"type":"doc"}',
    d.body ?? ''
  )
}

/** About 60 notes covering the dedupe, the scope and every filter. */
function fixtures(db: DatabaseSync): void {
  const docs: Doc[] = [
    // Event A at 1000: the main note is not the lowest id, and wins.
    { id: 'a1', epoch: 1000, uid: 'uid-a', eventId: 'ev-a' },
    { id: 'a2', epoch: 1000, uid: 'uid-a', eventId: 'ev-a', main: true },
    { id: 'a3', epoch: 1000, uid: 'uid-a', eventId: 'ev-a2' },
    // Event B at 1100: no main note, the lowest id wins.
    { id: 'b3', epoch: 1100, uid: 'uid-b', eventId: 'ev-b' },
    { id: 'b2', epoch: 1100, uid: 'uid-b', eventId: 'ev-b' },
    { id: 'b9', epoch: 1100, uid: 'uid-b', eventId: 'ev-b', shared: true },
    // Event B again at another time: a separate occurrence, not deduped against 1100.
    { id: 'b5', epoch: 1200, uid: 'uid-b', eventId: 'ev-b' },
    // Event C, no iCalUID: dedupes on the event id.
    { id: 'c1', epoch: 1300, eventId: 'ev-c' },
    { id: 'c2', epoch: 1300, eventId: 'ev-c', main: true },
    // Event D: the main note is deleted, so the lowest live id wins.
    { id: 'd1', epoch: 1400, uid: 'uid-d', eventId: 'ev-d', main: true, deleted: true },
    { id: 'd2', epoch: 1400, uid: 'uid-d', eventId: 'ev-d' },
    { id: 'd3', epoch: 1400, uid: 'uid-d', eventId: 'ev-d' },
    // Event E: someone else's main note is out of scope; ours remain.
    { id: 'e1', epoch: 1500, uid: 'uid-e', eventId: 'ev-e', main: true, owner: 'owner-2' },
    { id: 'e2', epoch: 1500, uid: 'uid-e', eventId: 'ev-e' },
    // Event F: excluded by the exclude list in one case.
    { id: 'f1', epoch: 1600, uid: 'uid-f', eventId: 'ev-f' },
    // Scope: a non-listable source, the same with a live panel, and with a deleted one.
    { id: 's1', epoch: 1700, via: 'import' },
    { id: 's2', epoch: 1700, via: 'import' },
    { id: 's3', epoch: 1700, via: 'import' },
    { id: 's4', epoch: 1710, via: null },
    { id: 's5', epoch: 1720, via: '' },
    { id: 's6', epoch: 1730, via: 'shared_tab', shared: true }
  ]
  // Notes with no event, some on the same time (ordered by id), some shared.
  for (let i = 1; i <= 40; i++) {
    docs.push({ id: `n${String(i).padStart(2, '0')}`, epoch: 2000 + Math.floor(i / 3) * 10, shared: i % 7 === 0, deleted: i % 13 === 0 })
  }
  for (const d of docs) insert(db, d)
  db.exec(`
    INSERT INTO note_panels VALUES ('s2', NULL), ('s3', '2026-01-03T00:00:00.000Z');
    INSERT INTO folder_notes VALUES ('folder-1', 'a1'), ('folder-1', 'a3'), ('folder-1', 'b2'), ('folder-1', 'b3'),
      ('folder-1', 'n01'), ('folder-1', 'n05'), ('folder-1', 'n07'), ('folder-1', 'n13'), ('folder-2', 'c2');
    INSERT INTO document_tags VALUES ('n02', 'type', 'customer'), ('n03', 'type', 'customer'), ('n03', 'stage', NULL),
      ('n04', 'type', 'partner'), ('a1', 'type', 'customer'), ('a2', 'type', 'customer'), ('n06', 'stage', NULL),
      ('b5', 'type', 'customer'), ('b5', 'stage', 'won');
  `)
}

interface Query {
  folderId?: string | null
  ids?: string[] | null
  ownOnly?: boolean
  tags?: { category: string; values: (string | null)[] }[] | null
  exclude?: { eventId: string; displayTimeUnixSeconds: number }[]
  limit?: number
}

function run(db: DatabaseSync, sql: string, q: Query): { rows: Record<string, unknown>[]; hasMore: boolean } {
  const limit = q.limit === undefined ? -1 : q.limit
  const rows = db.prepare(sql).all({
    owner: OWNER,
    workspace: WORKSPACE,
    exclude: JSON.stringify(q.exclude ?? []),
    folderId: q.folderId ?? null,
    ids: q.ids ? JSON.stringify(q.ids) : null,
    ownOnly: q.ownOnly ? 1 : 0,
    tags: q.tags && q.tags.length ? JSON.stringify(q.tags) : null,
    limit: limit < 0 ? -1 : limit + 1
  }) as Record<string, unknown>[]
  const hasMore = limit >= 0 && rows.length > limit
  return { rows: hasMore ? rows.slice(0, limit) : rows, hasMore }
}

const CASES: { name: string; q: Query; expect?: (ids: string[]) => boolean }[] = [
  { name: 'all', q: {}, expect: (ids) => ids.includes('a2') && !ids.includes('a1') && ids.includes('b2') && !ids.includes('b3') && ids.includes('b5') && ids.includes('c2') && ids.includes('d2') && !ids.includes('d3') && ids.includes('e2') && ids.includes('s2') && !ids.includes('s1') && !ids.includes('s3') },
  { name: 'exclude', q: { exclude: [{ eventId: 'ev-f', displayTimeUnixSeconds: 1600 }, { eventId: 'ev-b', displayTimeUnixSeconds: 1200 }] }, expect: (ids) => !ids.includes('f1') && !ids.includes('b5') },
  { name: 'folder', q: { folderId: 'folder-1' }, expect: (ids) => ids.includes('a1') && !ids.includes('a3') && ids.includes('b2') && !ids.includes('b3') },
  { name: 'folder-2', q: { folderId: 'folder-2' }, expect: (ids) => ids.join() === 'c2' },
  { name: 'ids', q: { ids: ['a1', 'a3', 'n10', 'n11', 's1', 'missing'] }, expect: (ids) => ids.join() === 'n10,n11,a1' },
  { name: 'own-only', q: { ownOnly: true }, expect: (ids) => !ids.includes('n07') && !ids.includes('s6') },
  { name: 'tags', q: { tags: [{ category: 'type', values: ['customer'] }] }, expect: (ids) => ids.join() === 'n03,n02,b5,a2' },
  { name: 'tags-null-and', q: { tags: [{ category: 'type', values: ['customer', 'partner'] }, { category: 'stage', values: [null] }] }, expect: (ids) => ids.join() === 'n03' },
  { name: 'limit', q: { limit: 5 }, expect: (ids) => ids.length === 5 },
  { name: 'limit-exact', q: { folderId: 'folder-1', limit: 6 } },
  { name: 'limit-zero', q: { limit: 0 } },
  { name: 'folder-own-limit', q: { folderId: 'folder-1', ownOnly: true, limit: 2 } }
]

let failed = 0
const db = new DatabaseSync(':memory:')
schema(db)
fixtures(db)
const before = oldSql()
const after = notesListSql(LISTABLE, NOTE_LIST_COLUMNS)
if (before.includes('d.*') && after.includes('d.*')) {
  console.log('FAIL narrowed query still selects d.*')
  failed++
}
for (const c of CASES) {
  const a = run(db, before, c.q)
  const b = run(db, after, c.q)
  const ids = b.rows.map((r) => String(r['id']))
  const same = JSON.stringify(a) === JSON.stringify(b)
  const sane = c.expect ? c.expect(ids) : true
  if (!same || !sane) failed++
  console.log(`${same && sane ? 'ok  ' : 'FAIL'} ${c.name}: ${ids.length} rows, hasMore ${b.hasMore}${same ? '' : ' (differs from the old query)'}${sane ? '' : ` (unexpected: ${ids.join(',')})`}`)
}
db.close()

// Timing: 1,200 notes with ~10 KB bodies, first page of 50.
const big = new DatabaseSync(':memory:')
schema(big)
const body = 'x'.repeat(10_000)
big.exec('BEGIN')
for (let i = 0; i < 1200; i++) {
  const ev = i % 4 === 0 ? { uid: `uid-${Math.floor(i / 8)}`, eventId: `ev-${Math.floor(i / 8)}` } : {}
  insert(big, { id: `t${String(i).padStart(4, '0')}`, epoch: 100_000 + Math.floor(i / 2) * 60, body, ...ev })
}
big.exec('COMMIT')
function median(sql: string): number {
  const times: number[] = []
  for (let i = 0; i < 25; i++) {
    const t0 = performance.now()
    run(big, sql, { limit: 50 })
    times.push(performance.now() - t0)
  }
  times.sort((x, y) => x - y)
  return times[Math.floor(times.length / 2)]!
}
const same = JSON.stringify(run(big, before, { limit: 50 })) === JSON.stringify(run(big, after, { limit: 50 }))
if (!same) failed++
console.log(`${same ? 'ok  ' : 'FAIL'} 1,200 notes: first page old ${median(before).toFixed(1)} ms, new ${median(after).toFixed(1)} ms (median of 25)`)
big.close()

if (failed) {
  console.log(`${failed} failed`)
  process.exit(1)
}
console.log('all passed')
