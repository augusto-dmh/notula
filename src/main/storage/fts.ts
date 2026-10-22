// SPDX-License-Identifier: Apache-2.0
// Full-text indexing. Triggers enqueue rows in
// `fts_queue` inside the writing transaction, so the queue is crash-safe. The
// indexer drains it in batches of 100 documents, then 10 panels, pausing 5 ms
// between batches, and starts at most 5 s after the first pending write.

import type { FtsHit, FtsQuery } from './api'
import type { DebugSearchResult } from './protocol'
import { inTransaction, StoreError, type StoreCtx } from './store'

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
 * (`source: 'document'`, with `inTitle`) and one per panel (`source: 'panel'`), each
 * with the number of distinct terms it matched; best first. Own, non-deleted notes only.
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
    }))
  ]
  hits.sort(
    (a, b) =>
      b.matchedTerms - a.matchedTerms ||
      Number(b.inTitle) - Number(a.inTitle) ||
      (a.source === b.source ? 0 : a.source === 'document' ? -1 : 1) ||
      a.documentId.localeCompare(b.documentId)
  )
  return hits.slice(0, limit)
}

const DOC_BATCH = 100
const PANEL_BATCH = 10
const PAUSE_MS = 5
/** Quiet period after a write before indexing starts. */
const IDLE_MS = 250
/** Upper bound between the first pending write and the start of indexing. */
const MAX_DELAY_MS = 5_000

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

  /** `ctx()` is null once the database is closed. */
  constructor(private readonly ctx: () => StoreCtx | null) {}

  /** Call after any write to documents or panels. */
  schedule(): void {
    if (this.stopped) return
    if (this.running) {
      this.rerun = true
      return
    }
    const now = Date.now()
    if (this.timer) clearTimeout(this.timer)
    else this.firstPendingAt = now
    const delay = Math.max(0, Math.min(IDLE_MS, this.firstPendingAt + MAX_DELAY_MS - now))
    this.timer = setTimeout(() => void this.drain(), delay)
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }

  /** Startup: queue rows missing from the index and drop index rows whose source is gone. */
  backfill(): void {
    const s = this.ctx()
    if (!s) return
    try {
      const queued = inTransaction(s.db, () => {
        const now = new Date().toISOString()
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
        s.db.prepare(`DELETE FROM documents_fts WHERE rowid NOT IN (SELECT rid FROM documents)`).run()
        s.db.prepare(`DELETE FROM note_panels_fts WHERE rowid NOT IN (SELECT rid FROM note_panels)`).run()
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
    try {
      while (!this.stopped) {
        const s = this.ctx()
        if (!s) break
        const docs = this.indexDocuments(s)
        await sleep(PAUSE_MS)
        const s2 = this.ctx()
        if (!s2 || this.stopped) break
        const panels = this.indexPanels(s2)
        if (docs + panels === 0) break
        await sleep(PAUSE_MS)
      }
    } catch (err) {
      this.ctx()?.log('error', 'fts-index-failed', { err })
    } finally {
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
