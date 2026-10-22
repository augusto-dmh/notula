// SPDX-License-Identifier: Apache-2.0
// Note search: the exact local query on the
// trigram FTS tables, the merge and order, and the snippets. Non-deleted notes
// and panels only; no limit.
//
// Matching mirrors SQLite `LIKE`: a substring match that ignores ASCII case. A term with
// `\`, `%` or `_` is escaped with a backslash (`ESCAPE '\'`), so it matches literally;
// a term without them keeps a plain `LIKE`, which the trigram index can serve.

import type { SearchMatchType, SearchResponse, SearchResult } from '@shared/types/search'
import type { StoreCtx } from './store'

type Row = Record<string, unknown>

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** Title terms checked in SQL; the rest are checked in JS on the rows SQL returns. */
const SQL_TITLE_TERMS = 32

// Snippet limits.
const SNIPPET_LINE_MAX = 160
const SNIPPET_BEFORE = 60
const SNIPPET_AFTER = 80
const BREAKS = '.?!\n\r'

/** SQLite LIKE folds ASCII letters only; JS checks use the same rule. */
function asciiLower(s: string): string {
  return s.replace(/[A-Z]/g, (c) => c.toLowerCase())
}

function like(column: string, param: string, term: string, params: Record<string, string>): string {
  const special = /[\\%_]/.test(term)
  params[param] = `%${special ? term.replace(/[\\%_]/g, (c) => `\\${c}`) : term}%`
  return special ? `${column} LIKE @${param} ESCAPE '\\'` : `${column} LIKE @${param}`
}

/** A bare UUID, or `notula://open?path=/meeting/<uuid>`. */
function noteIdFrom(text: string): string | null {
  if (UUID.test(text)) return text.toLowerCase()
  if (!/^notula:\/\//i.test(text)) return null
  try {
    const url = new URL(text)
    if (url.protocol !== 'notula:' || url.hostname !== 'open') return null
    const m = /^\/meeting\/([^/?#]+)$/.exec(url.searchParams.get('path') ?? '')
    return m && UUID.test(m[1] as string) ? (m[1] as string).toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * The first case-insensitive occurrence of `term` in `text`. Its line when that is
 * at most 160 characters; otherwise a window from just after a sentence end or line break
 * in the 60 characters before the match (else after the last space, else at the match) to
 * just after the first one in the 80 characters from the match start (else the last
 * space, else the match end). Trimmed, no ellipsis. Empty when there is no occurrence.
 */
export function snippetFor(text: string, term: string): string {
  if (!term) return ''
  const at = asciiLower(text).indexOf(asciiLower(term))
  if (at < 0) return ''
  const matchEnd = at + term.length
  const lineStart = at > 0 ? Math.max(text.lastIndexOf('\n', at - 1), text.lastIndexOf('\r', at - 1)) + 1 : 0
  let lineEnd = text.length
  for (let i = at; i < text.length; i++) {
    if (text[i] === '\n' || text[i] === '\r') {
      lineEnd = i
      break
    }
  }
  const line = text.slice(lineStart, lineEnd).trim()
  if (line.length <= SNIPPET_LINE_MAX) return line

  let start = at
  const before = Math.max(0, at - SNIPPET_BEFORE)
  let found = false
  for (let i = before; i < at; i++) {
    if (BREAKS.includes(text[i] as string)) {
      start = i + 1
      found = true
      break
    }
  }
  if (!found) {
    const space = at > 0 ? text.lastIndexOf(' ', at - 1) : -1
    if (space >= before) start = space + 1
  }

  let end = matchEnd
  const limit = Math.min(text.length, at + SNIPPET_AFTER)
  found = false
  for (let i = matchEnd; i < limit; i++) {
    if (BREAKS.includes(text[i] as string)) {
      end = i + 1
      found = true
      break
    }
  }
  if (!found) {
    const space = text.slice(matchEnd, limit).lastIndexOf(' ')
    if (space >= 0) end = matchEnd + space
  }
  return text.slice(start, end).trim()
}

interface Hit {
  result: SearchResult
  own: boolean
  order: number
}

function hit(r: Row, matchType: SearchMatchType, snippet: string | null, own: boolean, order: number): Hit {
  return {
    result: {
      id: String(r['id']),
      title: typeof r['title'] === 'string' ? r['title'] : null,
      owner_id: String(r['owner_id']),
      sort_epoch: Number(r['sort_epoch']) || 0,
      matchType,
      snippet
    },
    own,
    order
  }
}

/**
 * `query` in the response echoes the request, so the palette can drop a
 * response for an older query.
 */
export function searchNotes(s: StoreCtx, query: string): SearchResponse {
  const raw = typeof query === 'string' ? query : ''
  const text = raw.trim()
  if (!text) return { query: raw, phrase: null, results: [] }
  const isOwn = (r: Row): boolean =>
    r['owner_id'] === s.identity.ownerId && r['workspace_id'] === s.identity.workspaceId && r['is_shared'] !== 1
  const cols = 'd.id, d.title, d.owner_id, d.workspace_id, d.is_shared, d.sort_epoch'

  // Step 2: a note id returns that note alone; an unknown id falls through to text search.
  const noteId = noteIdFrom(text)
  if (noteId) {
    const row = s.db.prepare(`SELECT ${cols} FROM documents d WHERE d.id = ? AND d.deleted_at IS NULL`).get(noteId) as
      | Row
      | undefined
    if (row) return { query: raw, phrase: null, results: [hit(row, 'title', null, isOwn(row), 0).result] }
  }

  // Step 4: a quoted phrase is one term everywhere; otherwise title words split on whitespace.
  const phrase = text.length > 2 && text.startsWith('"') && text.endsWith('"') ? text.slice(1, -1) : null
  const whole = phrase ?? text
  const terms = phrase !== null ? [phrase] : [...new Set(text.split(/\s+/).filter(Boolean))]

  const hits = new Map<string, Hit>()
  let order = 0
  const keep = (r: Row, matchType: SearchMatchType, snippet: string | null): void => {
    const id = String(r['id'])
    if (!hits.has(id)) hits.set(id, hit(r, matchType, snippet, isOwn(r), order++))
  }

  // Title: every term occurs in `documents_fts.title`.
  const titleParams: Record<string, string> = {}
  const titleWhere = terms.slice(0, SQL_TITLE_TERMS).map((t, i) => like('f.title', `t${i}`, t, titleParams))
  const rest = terms.slice(SQL_TITLE_TERMS).map(asciiLower)
  const titleRows = s.db
    .prepare(
      `SELECT ${cols}, f.title AS fts_title FROM documents_fts f JOIN documents d ON d.rid = f.rowid
       WHERE ${titleWhere.join(' AND ')} AND d.deleted_at IS NULL`
    )
    .all(titleParams) as Row[]
  for (const r of titleRows) {
    const t = asciiLower(String(r['fts_title'] ?? ''))
    if (rest.every((term) => t.includes(term))) keep(r, 'title', null)
  }

  // Plain notes: the whole text (or the phrase) as one substring.
  const notesParams: Record<string, string> = {}
  const notesRows = s.db
    .prepare(
      `SELECT ${cols}, f.notes_text AS text FROM documents_fts f JOIN documents d ON d.rid = f.rowid
       WHERE ${like('f.notes_text', 'w', whole, notesParams)} AND d.deleted_at IS NULL`
    )
    .all(notesParams) as Row[]
  for (const r of notesRows) {
    if (!hits.has(String(r['id']))) keep(r, 'notes', snippetFor(String(r['text'] ?? ''), whole))
  }

  // AI panels: non-deleted panels of non-deleted notes; the oldest matching panel per note.
  const panelParams: Record<string, string> = {}
  const panelRows = s.db
    .prepare(
      `SELECT ${cols}, f.content_plain AS text FROM note_panels_fts f
       JOIN note_panels p ON p.rid = f.rowid
       JOIN documents d ON d.id = p.document_id
       WHERE ${like('f.content_plain', 'w', whole, panelParams)} AND p.deleted_at IS NULL AND d.deleted_at IS NULL
       ORDER BY p.created_at ASC, p.id ASC`
    )
    .all(panelParams) as Row[]
  for (const r of panelRows) {
    if (!hits.has(String(r['id']))) keep(r, 'panel', snippetFor(String(r['text'] ?? ''), whole))
  }

  // Own notes first, then display time, newest first; ties keep the merge order.
  const results = [...hits.values()]
    .sort(
      (a, b) =>
        Number(b.own) - Number(a.own) ||
        b.result.sort_epoch - a.result.sort_epoch ||
        a.order - b.order
    )
    .map((h) => h.result)
  return { query: raw, phrase, results }
}
