// SPDX-License-Identifier: Apache-2.0
// Full-text indexing. Triggers enqueue rows in
// `fts_queue` inside the writing transaction, so the queue is crash-safe. The
// indexer drains it in batches of 100 documents, then 10 panels, pausing 5 ms
// between batches, and starts at most 5 s after the first pending write.
//
// Transcripts have their own queue (`transcripts_fts_queue`, one row per note) and one index row
// per note. Live capture writes chunks about every second, so a note is indexed only once it has
// had no transcript write for 30 s: during pauses and after the meeting, not on every write. A
// deferred note brings the indexer back on its own when it comes due. Removed text (an erased or
// a deleted chunk) is queued as due at once, and later writes don't defer it (migration 20). A
// transcript batch is at most 5 notes or about 300,000 characters (always at least one note),
// after the panels. A failed drain tries again after 5 s, 30 s, then every 2 minutes.

import { DELETED_CHUNK_MARKER } from '@shared/types/transcript'
import type { FtsHit, FtsQuery } from './api'
import type { DebugSearchResult } from './protocol'
import { inTransaction, StoreError, type Db, type StoreCtx } from './store'

/** Trigram MATCH needs at least 3 characters. */
const MIN_TERM_CHARS = 3
const MAX_TERMS = 32
const MAX_HITS = 500

/** One FTS5 phrase: the term quoted, inner quotes doubled, so it never reads as query syntax. */
function phrase(term: string): string {
  return `"${term.replaceAll('"', '""')}"`
}

/**
 * Chat retrieval and search: case-insensitive substring search over
 * the trigram indexes. Terms shorter than 3 characters are ignored. One hit per note
 * (`source: 'document'`, with `inTitle`), one per panel (`source: 'panel'`) and, when
 * `sources` asks for `'transcripts'`, one per note transcript (`source: 'transcript'`), each
 * with the number of distinct terms it matched; best first, and at equal terms a transcript
 * hit after the others. Own, non-deleted notes only.
 */
export function searchFts(s: StoreCtx, q: FtsQuery): FtsHit[] {
  if (typeof q !== 'object' || q === null || !Array.isArray(q.terms)) throw new StoreError('invalid-input', 'terms must be an array')
  const terms = [
    ...new Set(q.terms.filter((t): t is string => typeof t === 'string').map((t) => t.trim()).filter((t) => [...t].length >= MIN_TERM_CHARS))
  ].slice(0, MAX_TERMS)
  if (terms.length === 0) return []
  const limit = Math.min(MAX_HITS, Math.max(1, Math.floor(Number(q.limit) || MAX_HITS)))
  const sources = Array.isArray(q.sources) && q.sources.length ? q.sources : ['documents', 'panels']
  const ids = Array.isArray(q.documentIds) ? JSON.stringify(q.documentIds.filter((i) => typeof i === 'string')) : null
  const scope = { owner: s.identity.ownerId, workspace: s.identity.workspaceId, ids }
  const owned = `d.deleted_at IS NULL AND d.owner_id = @owner AND d.workspace_id = @workspace
    AND (@ids IS NULL OR d.id IN (SELECT value FROM json_each(@ids)))`

  const docs = new Map<string, { terms: Set<string>; inTitle: boolean }>()
  const panels = new Map<string, { documentId: string; terms: Set<string> }>()
  const transcripts = new Map<string, Set<string>>()
  const docStmt = sources.includes('documents')
    ? s.db.prepare(
        `SELECT d.id, f.title FROM documents_fts f JOIN documents d ON d.rid = f.rowid
         WHERE documents_fts MATCH @match AND ${owned}`
      )
    : null
  const panelStmt = sources.includes('panels')
    ? s.db.prepare(
        `SELECT p.id, p.document_id FROM note_panels_fts f
         JOIN note_panels p ON p.rid = f.rowid JOIN documents d ON d.id = p.document_id
         WHERE note_panels_fts MATCH @match AND p.deleted_at IS NULL AND ${owned}`
      )
    : null
  const transcriptStmt = sources.includes('transcripts')
    ? s.db.prepare(
        `SELECT d.id FROM transcripts_fts f JOIN documents d ON d.rid = f.rowid
         WHERE transcripts_fts MATCH @match AND ${owned}`
      )
    : null

  for (const term of terms) {
    const lower = term.toLowerCase()
    for (const r of (docStmt?.all({ ...scope, match: phrase(term) }) ?? []) as { id: string; title: string | null }[]) {
      const hit = docs.get(r.id) ?? { terms: new Set<string>(), inTitle: false }
      hit.terms.add(lower)
      if ((r.title ?? '').toLowerCase().includes(lower)) hit.inTitle = true
      docs.set(r.id, hit)
    }
    for (const r of (panelStmt?.all({ ...scope, match: phrase(term) }) ?? []) as { id: string; document_id: string }[]) {
      const hit = panels.get(r.id) ?? { documentId: r.document_id, terms: new Set<string>() }
      hit.terms.add(lower)
      panels.set(r.id, hit)
    }
    for (const r of (transcriptStmt?.all({ ...scope, match: phrase(term) }) ?? []) as { id: string }[]) {
      const hit = transcripts.get(r.id) ?? new Set<string>()
      hit.add(lower)
      transcripts.set(r.id, hit)
    }
  }

  const hits: FtsHit[] = [
    ...[...docs].map(([documentId, h]) => ({
      documentId,
      matchedTerms: h.terms.size,
      inTitle: h.inTitle,
      source: 'document' as const,
      panelId: null
    })),
    ...[...panels].map(([panelId, h]) => ({
      documentId: h.documentId,
      matchedTerms: h.terms.size,
      inTitle: false,
      source: 'panel' as const,
      panelId
    })),
    ...[...transcripts].map(([documentId, t]) => ({
      documentId,
      matchedTerms: t.size,
      inTitle: false,
      source: 'transcript' as const,
      panelId: null
    }))
  ]
  hits.sort(
    (a, b) =>
      b.matchedTerms - a.matchedTerms ||
      Number(b.inTitle) - Number(a.inTitle) ||
      SOURCE_RANK[a.source] - SOURCE_RANK[b.source] ||
      a.documentId.localeCompare(b.documentId)
  )
  return hits.slice(0, limit)
}

const SOURCE_RANK: Record<FtsHit['source'], number> = { document: 0, panel: 1, transcript: 2 }

/**
 * A note's transcript as the index holds it: its final chunks in transcript order, text only
 * (no speakers), one per line, without erased chunks or the sessions a merge hid. Empty for a
 * deleted or missing note, which then has no index row.
 */
export function transcriptText(db: Db, noteId: string): string {
  const doc = db.prepare(`SELECT deleted_at FROM documents WHERE id = ?`).get(noteId) as { deleted_at: string | null } | undefined
  if (!doc || doc.deleted_at !== null) return ''
  const rows = db
    .prepare(
      `SELECT c.text FROM transcript_chunks c
       WHERE c.document_id = @id AND ${indexableChunk('c', '@id')}
       ORDER BY c.start_timestamp, c.end_timestamp, c.id`
    )
    .all({ id: noteId, marker: DELETED_CHUNK_MARKER }) as { text: unknown }[]
  const lines: string[] = []
  for (const r of rows) {
    const line = typeof r.text === 'string' ? r.text.trim() : ''
    if (line) lines.push(line)
  }
  return lines.join('\n')
}

/** A final chunk, not erased, outside the sessions a merge hid; `@marker` is bound by the caller. */
function indexableChunk(c: string, noteId: string): string {
  return `${c}.is_final = 1 AND ${c}.text != @marker
    AND ${c}.transcription_session_id NOT IN (
      SELECT value FROM json_each(COALESCE(
        (SELECT CASE WHEN json_valid(superseded_session_ids) AND json_type(superseded_session_ids) = 'array'
          THEN superseded_session_ids END FROM note_sources WHERE note_id = ${noteId}), '[]')))`
}

/** What `String.prototype.trim` drops, near enough for a blank test in SQL. */
const SQL_BLANKS = `' ' || char(9, 10, 11, 12, 13, 160, 8232, 8233, 65279)`

const DOC_BATCH = 100
const PANEL_BATCH = 10
const PAUSE_MS = 5
/** Quiet period after a write before indexing starts. */
const IDLE_MS = 250
/** Upper bound between the first pending write and the start of indexing. */
const MAX_DELAY_MS = 5_000
/** A note is indexed once its transcript has had no write for this long. */
const TRANSCRIPT_QUIET_MS = 30_000
const TRANSCRIPT_BATCH_NOTES = 5
const TRANSCRIPT_BATCH_CHARS = 300_000
/** Waits after the first and the second failed drain in a row, then after every later one until a drain works. */
const RETRY_AFTER_MS: readonly number[] = [5_000, 30_000]
const RETRY_MAX_MS = 120_000

/** The clock and the quiet period; a check passes its own. */
export interface FtsIndexerOptions {
  now?: () => number
  transcriptQuietMs?: number
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Panel plain text: the markdown with its markers stripped, blocks separated by newlines. */
export function markdownToPlain(md: string | null): string {
  if (!md) return ''
  const lines: string[] = []
  for (const raw of md.split(/\r?\n/)) {
    if (/^\s*([-*_]\s*){3,}$/.test(raw)) continue
    let line = raw
      .replace(/^\s*(>\s?)+/, '')
      .replace(/^\s*#{1,6}\s+/, '')
      .replace(/^\s*([-*+]|\d+[.)])\s+/, '')
      .replace(/^\[[ xX]\]\s+/, '')
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/`+/g, '')
      .replace(/(\*\*|__|~~)/g, '')
      .replace(/(^|[^\w*])[*_]+(?=\w)/g, '$1')
      .replace(/(\w)[*_]+(?=[^\w*]|$)/g, '$1')
    line = line.trim()
    if (line) lines.push(line)
  }
  return lines.join('\n')
}

export class FtsIndexer {
  private timer: NodeJS.Timeout | null = null
  private firstPendingAt = 0
  private running = false
  private rerun = false
  private stopped = false
  /** Brings the indexer back when the oldest deferred transcript comes due. */
  private wakeTimer: NodeJS.Timeout | null = null
  private readonly now: () => number
  private readonly quietMs: number
  /** Transcripts indexed in the current drain, for its log line. */
  private drained = { notes: 0, chars: 0, ms: 0 }
  /** Failed drains in a row, and the wall-clock time before which no drain starts. */
  private failures = 0
  private retryAt = 0

  /** `ctx()` is null once the database is closed. */
  constructor(
    private readonly ctx: () => StoreCtx | null,
    opts: FtsIndexerOptions = {}
  ) {
    this.now = opts.now ?? Date.now
    this.quietMs = opts.transcriptQuietMs ?? TRANSCRIPT_QUIET_MS
  }

  /** Call after any write to documents, panels, transcript chunks or note sources. */
  schedule(): void {
    if (this.stopped) return
    if (this.running) {
      this.rerun = true
      return
    }
    const now = Date.now()
    if (this.timer) clearTimeout(this.timer)
    else this.firstPendingAt = now
    // After a failure, writes don't bring the next try forward.
    const delay = Math.max(0, Math.min(IDLE_MS, this.firstPendingAt + MAX_DELAY_MS - now), this.retryAt - now)
    this.timer = setTimeout(() => void this.drain(), delay)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = null
  }

  /** Runs one drain now and resolves when it ends; the check's way in. */
  async drainNow(): Promise<void> {
    if (this.running || this.stopped) return
    if (this.timer) clearTimeout(this.timer)
    await this.drain()
  }

  /** Startup: queue rows missing from the index and drop index rows whose source is gone. */
  backfill(): void {
    const s = this.ctx()
    if (!s) return
    try {
      const queued = inTransaction(s.db, () => {
        const now = new Date(this.now()).toISOString()
        let n = 0
        n += s.db
          .prepare(
            `INSERT OR IGNORE INTO fts_queue (kind, row_id, queued_at)
             SELECT 'document', d.id, ? FROM documents d
             WHERE (d.deleted_at IS NULL) != EXISTS (SELECT 1 FROM documents_fts f WHERE f.rowid = d.rid)`
          )
          .run(now).changes
        n += s.db
          .prepare(
            `INSERT OR IGNORE INTO fts_queue (kind, row_id, queued_at)
             SELECT 'panel', p.id, ? FROM note_panels p
             WHERE (p.deleted_at IS NULL) != EXISTS (SELECT 1 FROM note_panels_fts f WHERE f.rowid = p.rid)`
          )
          .run(now).changes
        // A note whose indexable transcript and index row disagree. The first start after the
        // upgrade queues every note with a transcript; the 30 s rule lets startup settle first.
        n += s.db
          .prepare(
            `INSERT OR IGNORE INTO transcripts_fts_queue (document_id, queued_at)
             SELECT d.id, @now FROM documents d
             WHERE (d.deleted_at IS NULL AND EXISTS (
                 SELECT 1 FROM transcript_chunks c WHERE c.document_id = d.id AND ${indexableChunk('c', 'd.id')}
                   AND TRIM(c.text, ${SQL_BLANKS}) != ''))
               != EXISTS (SELECT 1 FROM transcripts_fts f WHERE f.rowid = d.rid)`
          )
          .run({ now, marker: DELETED_CHUNK_MARKER }).changes
        s.db.prepare(`DELETE FROM documents_fts WHERE rowid NOT IN (SELECT rid FROM documents)`).run()
        s.db.prepare(`DELETE FROM note_panels_fts WHERE rowid NOT IN (SELECT rid FROM note_panels)`).run()
        s.db.prepare(`DELETE FROM transcripts_fts WHERE rowid NOT IN (SELECT rid FROM documents)`).run()
        return n
      })
      if (queued) s.log('info', 'fts-backfill-queued', { rows: queued })
    } catch (err) {
      s.log('error', 'fts-backfill-failed', { err })
    }
    this.schedule()
  }

  search(query: string): DebugSearchResult {
    const s = this.ctx()
    if (!s || typeof query !== 'string' || !query.trim()) return { documents: [], panels: [] }
    const q = query.trim()
    // Trigram MATCH needs at least 3 characters; shorter strings fall back to LIKE.
    const useMatch = [...q].length >= 3
    const term = useMatch ? `"${q.replaceAll('"', '""')}"` : `%${q}%`
    const documents = s.db
      .prepare(
        useMatch
          ? `SELECT d.id, d.title FROM documents_fts JOIN documents d ON d.rid = documents_fts.rowid
             WHERE documents_fts MATCH ? AND d.deleted_at IS NULL LIMIT 50`
          : `SELECT d.id, d.title FROM documents_fts JOIN documents d ON d.rid = documents_fts.rowid
             WHERE (documents_fts.title LIKE ?1 OR documents_fts.notes_text LIKE ?1) AND d.deleted_at IS NULL LIMIT 50`
      )
      .all(term) as DebugSearchResult['documents']
    const panels = s.db
      .prepare(
        useMatch
          ? `SELECT p.id, p.document_id FROM note_panels_fts JOIN note_panels p ON p.rid = note_panels_fts.rowid
             WHERE note_panels_fts MATCH ? AND p.deleted_at IS NULL LIMIT 50`
          : `SELECT p.id, p.document_id FROM note_panels_fts JOIN note_panels p ON p.rid = note_panels_fts.rowid
             WHERE note_panels_fts.content_plain LIKE ? AND p.deleted_at IS NULL LIMIT 50`
      )
      .all(term) as DebugSearchResult['panels']
    return { documents, panels }
  }

  private async drain(): Promise<void> {
    this.timer = null
    this.running = true
    this.drained = { notes: 0, chars: 0, ms: 0 }
    let retryIn = 0
    try {
      while (!this.stopped) {
        const s = this.ctx()
        if (!s) break
        const docs = this.indexDocuments(s)
        await sleep(PAUSE_MS)
        const s2 = this.ctx()
        if (!s2 || this.stopped) break
        const panels = this.indexPanels(s2)
        await sleep(PAUSE_MS)
        const s3 = this.ctx()
        if (!s3 || this.stopped) break
        const notes = this.indexTranscripts(s3)
        if (docs + panels + notes === 0) break
        await sleep(PAUSE_MS)
      }
      if (this.failures) this.ctx()?.log('info', 'fts-index-recovered', { failures: this.failures })
      this.failures = 0
      this.retryAt = 0
    } catch (err) {
      // A failure that repeats (a damaged table, a full disk) waits longer each time, logged once per step.
      retryIn = RETRY_AFTER_MS[this.failures] ?? RETRY_MAX_MS
      if (this.failures <= RETRY_AFTER_MS.length) this.ctx()?.log('error', 'fts-index-failed', { err, retryInMs: retryIn })
      this.failures++
      this.retryAt = Date.now() + retryIn
    } finally {
      if (this.drained.notes) this.ctx()?.log('info', 'fts-transcripts-indexed', { ...this.drained })
      if (retryIn && !this.stopped) this.wakeAfter(retryIn)
      else this.wakeForDeferred()
      this.running = false
      if (this.rerun) {
        this.rerun = false
        this.schedule()
      }
    }
  }

  private indexDocuments(s: StoreCtx): number {
    return inTransaction(s.db, () => {
      const rows = s.db
        .prepare(
          `SELECT q.row_id AS id, d.rid, d.title, d.notes_text, d.deleted_at
           FROM fts_queue q LEFT JOIN documents d ON d.id = q.row_id
           WHERE q.kind = 'document' ORDER BY q.queued_at LIMIT ?`
        )
        .all(DOC_BATCH) as {
        id: string
        rid: number | null
        title: string | null
        notes_text: string | null
        deleted_at: string | null
      }[]
      const del = s.db.prepare(`DELETE FROM documents_fts WHERE rowid = ?`)
      const ins = s.db.prepare(`INSERT INTO documents_fts (rowid, document_id, title, notes_text) VALUES (?, ?, ?, ?)`)
      const deq = s.db.prepare(`DELETE FROM fts_queue WHERE kind = 'document' AND row_id = ?`)
      for (const r of rows) {
        if (r.rid !== null) {
          del.run(r.rid)
          if (r.deleted_at === null) ins.run(r.rid, r.id, r.title ?? '', r.notes_text ?? '')
        }
        deq.run(r.id)
      }
      return rows.length
    })
  }

  /** Sets the wake timer for the oldest queued transcript that isn't due yet. */
  private wakeForDeferred(): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = null
    const s = this.ctx()
    if (!s || this.stopped) return
    try {
      const oldest = (s.db.prepare(`SELECT MIN(queued_at) AS t FROM transcripts_fts_queue`).get() as { t: string | null }).t
      if (oldest === null) return
      const at = Date.parse(oldest)
      // A time ahead of the clock (the clock moved back) waits one quiet period at most.
      const wait = Math.min(this.quietMs, Math.max(0, (Number.isNaN(at) ? 0 : at) + this.quietMs - this.now()))
      this.wakeAfter(wait + 50)
    } catch (err) {
      s.log('error', 'fts-index-failed', { err })
    }
  }

  private wakeAfter(ms: number): void {
    if (this.wakeTimer) clearTimeout(this.wakeTimer)
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = null
      this.schedule()
    }, ms)
    this.wakeTimer.unref?.()
  }

  /**
   * One batch of due transcripts: queue rows at least the quiet period old, oldest first. Each
   * note's row is rebuilt from its chunks; a deleted, missing or empty note loses its row. The
   * queue row goes only if it still carries the time read, so a write in between keeps it queued.
   */
  private indexTranscripts(s: StoreCtx): number {
    const started = this.now()
    const due = new Date(started - this.quietMs).toISOString()
    let chars = 0
    const notes = inTransaction(s.db, () => {
      const rows = s.db
        .prepare(
          `SELECT q.document_id AS id, q.queued_at, d.rid FROM transcripts_fts_queue q
           LEFT JOIN documents d ON d.id = q.document_id
           WHERE q.queued_at <= ? ORDER BY q.queued_at LIMIT ?`
        )
        .all(due, TRANSCRIPT_BATCH_NOTES) as { id: string; queued_at: string; rid: number | null }[]
      const del = s.db.prepare(`DELETE FROM transcripts_fts WHERE rowid = ?`)
      const ins = s.db.prepare(`INSERT INTO transcripts_fts (rowid, document_id, text) VALUES (?, ?, ?)`)
      const deq = s.db.prepare(`DELETE FROM transcripts_fts_queue WHERE document_id = ? AND queued_at = ?`)
      let n = 0
      for (const r of rows) {
        const text = r.rid === null ? '' : transcriptText(s.db, r.id)
        if (n > 0 && chars + text.length > TRANSCRIPT_BATCH_CHARS) break
        if (r.rid !== null) {
          del.run(r.rid)
          if (text) ins.run(r.rid, r.id, text)
        }
        deq.run(r.id, r.queued_at)
        chars += text.length
        n++
      }
      return n
    })
    if (notes) {
      this.drained.notes += notes
      this.drained.chars += chars
      this.drained.ms += this.now() - started
    }
    return notes
  }

  private indexPanels(s: StoreCtx): number {
    return inTransaction(s.db, () => {
      const rows = s.db
        .prepare(
          `SELECT q.row_id AS id, p.rid, p.document_id, p.content_markdown, p.deleted_at
           FROM fts_queue q LEFT JOIN note_panels p ON p.id = q.row_id
           WHERE q.kind = 'panel' ORDER BY q.queued_at LIMIT ?`
        )
        .all(PANEL_BATCH) as {
        id: string
        rid: number | null
        document_id: string | null
        content_markdown: string | null
        deleted_at: string | null
      }[]
      const del = s.db.prepare(`DELETE FROM note_panels_fts WHERE rowid = ?`)
      const ins = s.db.prepare(
        `INSERT INTO note_panels_fts (rowid, panel_id, document_id, content_plain) VALUES (?, ?, ?, ?)`
      )
      const deq = s.db.prepare(`DELETE FROM fts_queue WHERE kind = 'panel' AND row_id = ?`)
      for (const r of rows) {
        if (r.rid !== null) {
          del.run(r.rid)
          if (r.deleted_at === null) ins.run(r.rid, r.id, r.document_id, markdownToPlain(r.content_markdown))
        }
        deq.run(r.id)
      }
      return rows.length
    })
  }
}
