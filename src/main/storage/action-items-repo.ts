// SPDX-License-Identifier: Apache-2.0
// Action items: `action_items` and
// `action_item_feedback`; a purged note's items go with it (FK cascade).
//
// - A fresh extraction replaces the note's items that are still unreviewed and
//   unarchived; kept, dismissed and archived items stay.
// - Applying a regenerate preview does the same for every source note at once, in one
//   transaction.
// - Change events carry the source note ids, which main forwards as `action-items:changed`.

import { randomUUID } from 'node:crypto'
import {
  ACTION_ITEMS_LIMITS,
  type ActionItem,
  type ActionItemAttribution,
  type ActionItemFeedback,
  type ActionItemFeedbackInput,
  type ActionItemReview,
  type ActionItemsQuery,
  type RegeneratedActionItem
} from '@shared/types/action-items'
import type { NewActionItem } from './api'
import { nowIso, parseJson } from './rows'
import { inTransaction, invalid, notFound, type StoreCtx } from './store'

type Row = Record<string, unknown>

const MAX_INTENT = 500
const MAX_DETAIL = 2_000
const MAX_FEEDBACK = 4_000
const MAX_LINE = 2_000
const MAX_LIST = 1_000
const REVIEWS: readonly ActionItemReview[] = ['kept', 'dismissed']

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function toFeedback(r: Row): ActionItemFeedback {
  return {
    id: r['id'] as string,
    actionItemId: str(r['action_item_id']),
    direction: r['direction'] as ActionItemFeedback['direction'],
    feedback: str(r['feedback']),
    createdAt: r['created_at'] as string,
    updatedAt: r['updated_at'] as string
  }
}

function toItem(r: Row, feedback: ActionItemFeedback[]): ActionItem {
  const id = r['id'] as string
  return {
    id,
    actionItemId: id,
    intent: r['intent'] as string,
    detail: str(r['detail']),
    status: r['status'] === 'done' ? 'done' : 'todo',
    archivedAt: str(r['archived_at']),
    sourceNoteId: str(r['source_document_id']),
    sourcePanelId: str(r['source_panel_id']),
    attribution: attributionOf(parseJson<unknown>(r['attribution'], [])),
    createdAt: r['created_at'] as string,
    reviewStatus: r['review_status'] === 'kept' || r['review_status'] === 'dismissed' ? r['review_status'] : null,
    reviewReason: str(r['review_reason']),
    reviewedAt: str(r['reviewed_at']),
    feedback
  }
}

/** Every well-formed `{ name, identifiers }` entry; anything else is dropped. */
function attributionOf(v: unknown): ActionItemAttribution[] {
  if (!Array.isArray(v)) return []
  const out: ActionItemAttribution[] = []
  for (const a of v.slice(0, 20)) {
    if (typeof a !== 'object' || a === null) continue
    const name = (a as { name?: unknown }).name
    if (typeof name !== 'string' || !name.trim()) continue
    const ids = (a as { identifiers?: unknown }).identifiers
    out.push({
      name: name.trim().slice(0, 200),
      identifiers: Array.isArray(ids)
        ? ids.filter((x): x is string => typeof x === 'string' && x.length > 0 && x.length <= 320).slice(0, 10)
        : []
    })
  }
  return out
}

/** Items with their feedback, newest feedback first. */
function withFeedback(s: StoreCtx, rows: Row[]): ActionItem[] {
  if (rows.length === 0) return []
  const ids = rows.map((r) => r['id'] as string)
  const byItem = new Map<string, ActionItemFeedback[]>()
  const feedback = s.db
    .prepare(
      `SELECT * FROM action_item_feedback WHERE action_item_id IN (SELECT value FROM json_each(?))
       ORDER BY created_at DESC, rid DESC`
    )
    .all(JSON.stringify(ids)) as Row[]
  for (const f of feedback) {
    const key = f['action_item_id'] as string
    const list = byItem.get(key) ?? []
    list.push(toFeedback(f))
    byItem.set(key, list)
  }
  return rows.map((r) => toItem(r, byItem.get(r['id'] as string) ?? []))
}

function requireItem(s: StoreCtx, id: string): Row {
  if (typeof id !== 'string' || !id) throw invalid('id is required')
  const row = s.db.prepare(`SELECT * FROM action_items WHERE id = ? AND deleted_at IS NULL`).get(id) as Row | undefined
  if (!row) throw notFound('action item', id)
  return row
}

function getItems(s: StoreCtx, ids: string[]): ActionItem[] {
  if (ids.length === 0) return []
  const rows = s.db
    .prepare(`SELECT * FROM action_items WHERE id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC, rid ASC`)
    .all(JSON.stringify(ids)) as Row[]
  return withFeedback(s, rows)
}

function isoOrUndefined(v: unknown, what: string): string | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) throw invalid(`${what} is not a valid time`)
  return v
}

function idList(v: unknown, what: string): string[] | undefined {
  if (v === undefined) return undefined
  if (!Array.isArray(v) || v.length > MAX_LIST || v.some((x) => typeof x !== 'string')) throw invalid(`${what} is invalid`)
  return v as string[]
}

/** Newest first; within one extraction, the model's order (most important first). */
export function listActionItems(s: StoreCtx, q: ActionItemsQuery): ActionItem[] {
  const query = (typeof q === 'object' && q !== null ? q : {}) as ActionItemsQuery
  const noteIds = idList(query.noteIds, 'noteIds')
  const ids = idList(query.ids, 'ids')
  const after = isoOrUndefined(query.createdAfter, 'createdAfter')
  const before = isoOrUndefined(query.createdBefore, 'createdBefore')
  let limit = -1
  if (query.limit !== undefined) {
    if (typeof query.limit !== 'number' || !Number.isFinite(query.limit) || query.limit < 0) throw invalid('limit is invalid')
    limit = Math.min(Math.floor(query.limit), 5_000)
  }
  const rows = s.db
    .prepare(
      `SELECT a.* FROM action_items a
       LEFT JOIN documents d ON d.id = a.source_document_id
       WHERE a.deleted_at IS NULL AND a.owner_id = @owner AND a.workspace_id = @workspace
         AND (a.source_document_id IS NULL OR d.deleted_at IS NULL)
         AND (@archived = 1 OR a.archived_at IS NULL)
         AND (@noteIds IS NULL OR a.source_document_id IN (SELECT value FROM json_each(@noteIds)))
         AND (@ids IS NULL OR a.id IN (SELECT value FROM json_each(@ids)))
         AND (@after IS NULL OR a.created_at > @after)
         AND (@before IS NULL OR a.created_at < @before)
       ORDER BY a.created_at DESC, a.rid ASC
       LIMIT @limit`
    )
    .all({
      owner: s.identity.ownerId,
      workspace: s.identity.workspaceId,
      archived: query.includeArchived ? 1 : 0,
      noteIds: noteIds ? JSON.stringify(noteIds) : null,
      ids: ids ? JSON.stringify(ids) : null,
      after: after ?? null,
      before: before ?? null,
      limit
    }) as Row[]
  return withFeedback(s, rows)
}

interface CleanItem {
  intent: string
  detail: string | null
  attribution: ActionItemAttribution[]
}

function cleanItem(v: { intent?: unknown; detail?: unknown; attribution?: unknown }): CleanItem | null {
  if (typeof v !== 'object' || v === null) return null
  const intent = typeof v.intent === 'string' ? v.intent.trim() : ''
  if (!intent) return null
  const detail = typeof v.detail === 'string' && v.detail.trim() ? v.detail.trim().slice(0, MAX_DETAIL) : null
  return { intent: intent.slice(0, MAX_INTENT), detail, attribution: attributionOf(v.attribution) }
}

/** Inserts in the given order; one shared timestamp keeps them together, `rid` keeps their order. */
function insertItems(s: StoreCtx, noteId: string, panelId: string | null, items: CleanItem[], now: string): string[] {
  const insert = s.db.prepare(
    `INSERT INTO action_items (id, workspace_id, owner_id, source_document_id, source_panel_id, intent, detail,
       attribution, status, created_at, updated_at)
     VALUES (@id, @workspace, @owner, @noteId, @panelId, @intent, @detail, @attribution, 'todo', @now, @now)`
  )
  const ids: string[] = []
  for (const item of items) {
    const id = randomUUID()
    insert.run({
      id,
      workspace: s.identity.workspaceId,
      owner: s.identity.ownerId,
      noteId,
      panelId,
      intent: item.intent,
      detail: item.detail,
      attribution: JSON.stringify(item.attribution),
      now
    })
    ids.push(id)
  }
  return ids
}

/** The note's unreviewed, unarchived items go (their feedback with them, by cascade). */
function deleteReplaceable(s: StoreCtx, noteId: string): number {
  return s.db
    .prepare(
      `DELETE FROM action_items
       WHERE source_document_id = ? AND review_status IS NULL AND archived_at IS NULL AND deleted_at IS NULL`
    )
    .run(noteId).changes
}

function requireLiveNote(s: StoreCtx, noteId: string): void {
  const row = s.db.prepare(`SELECT deleted_at FROM documents WHERE id = ?`).get(noteId) as { deleted_at: string | null } | undefined
  if (!row) throw notFound('note', noteId)
}

/** Replaces the note's unreviewed, unarchived items; at most 20 are kept. */
export function replaceNoteActionItems(s: StoreCtx, noteId: string, panelId: string, items: NewActionItem[]): ActionItem[] {
  if (typeof noteId !== 'string' || !noteId) throw invalid('noteId is required')
  if (typeof panelId !== 'string' || !panelId) throw invalid('panelId is required')
  if (!Array.isArray(items)) throw invalid('items must be an array')
  const clean = items
    .map((i) => cleanItem(i))
    .filter((i): i is CleanItem => i !== null)
    .slice(0, ACTION_ITEMS_LIMITS.perNote)
  const ids = inTransaction(s.db, () => {
    requireLiveNote(s, noteId)
    const removed = deleteReplaceable(s, noteId)
    const inserted = insertItems(s, noteId, panelId, clean, nowIso())
    s.log('info', 'action-items-replaced', { noteId, removed, inserted: inserted.length })
    return inserted
  })
  s.touch('action_items', noteId)
  const byId = new Map(getItems(s, ids).map((i) => [i.id, i]))
  return ids.map((id) => byId.get(id)).filter((i): i is ActionItem => !!i)
}

export function reviewActionItem(s: StoreCtx, id: string, review: ActionItemReview, reason?: string): ActionItem {
  if (!REVIEWS.includes(review)) throw invalid('reviewStatus is invalid')
  if (reason !== undefined && reason !== null && (typeof reason !== 'string' || reason.length > MAX_FEEDBACK)) {
    throw invalid('reason is invalid')
  }
  const noteId = inTransaction(s.db, () => {
    const row = requireItem(s, id)
    if (row['archived_at'] !== null) throw invalid('the action item is archived')
    const now = nowIso()
    s.db
      .prepare(`UPDATE action_items SET review_status = ?, review_reason = ?, reviewed_at = ?, updated_at = ? WHERE id = ?`)
      .run(review, reason ?? null, now, now, id)
    return str(row['source_document_id'])
  })
  s.touch('action_items', ...(noteId ? [noteId] : []))
  return getItems(s, [id])[0] as ActionItem
}

/** Idempotent: an archived item keeps its first `archived_at`. */
export function archiveActionItem(s: StoreCtx, id: string): void {
  const noteId = inTransaction(s.db, () => {
    const row = requireItem(s, id)
    if (row['archived_at'] === null) {
      const now = nowIso()
      s.db.prepare(`UPDATE action_items SET archived_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id)
    }
    return str(row['source_document_id'])
  })
  s.touch('action_items', ...(noteId ? [noteId] : []))
}

function lineText(v: unknown, what: string): string {
  if (typeof v !== 'string' || !v.trim() || v.length > MAX_LINE) throw invalid(`${what} is invalid`)
  return v.trim()
}

/** A linked item's thumbs, or an unlinked line's under an action heading. */
export function addActionItemFeedback(s: StoreCtx, f: ActionItemFeedbackInput): ActionItemFeedback {
  if (typeof f !== 'object' || f === null) throw invalid('feedback must be an object')
  if (f.direction !== 'positive' && f.direction !== 'negative') throw invalid('direction is invalid')
  if (f.feedback !== null && f.feedback !== undefined && (typeof f.feedback !== 'string' || f.feedback.length > MAX_FEEDBACK)) {
    throw invalid('feedback is invalid')
  }
  const text = typeof f.feedback === 'string' ? f.feedback.trim() || null : null
  const id = randomUUID()
  const now = nowIso()
  const touched = inTransaction(s.db, () => {
    let itemId: string | null = null
    let documentId: string | null = null
    let panelId: string | null = null
    let heading: string | null = null
    let item: string | null = null
    if ('actionItemId' in f && f.actionItemId !== undefined) {
      const row = requireItem(s, f.actionItemId)
      itemId = f.actionItemId
      documentId = str(row['source_document_id'])
      panelId = str(row['source_panel_id'])
    } else {
      const unlinked = f as { panelId?: unknown; headingText?: unknown; itemText?: unknown }
      if (typeof unlinked.panelId !== 'string' || !unlinked.panelId) throw invalid('panelId is required')
      const panel = s.db.prepare(`SELECT document_id FROM note_panels WHERE id = ?`).get(unlinked.panelId) as
        | { document_id: string }
        | undefined
      if (!panel) throw notFound('panel', unlinked.panelId)
      panelId = unlinked.panelId
      documentId = panel.document_id
      heading = lineText(unlinked.headingText, 'headingText')
      item = lineText(unlinked.itemText, 'itemText')
    }
    s.db
      .prepare(
        `INSERT INTO action_item_feedback (id, workspace_id, owner_id, action_item_id, document_id, panel_id,
           heading_text, item_text, direction, feedback, created_at, updated_at)
         VALUES (@id, @workspace, @owner, @itemId, @documentId, @panelId, @heading, @item, @direction, @feedback, @now, @now)`
      )
      .run({
        id,
        workspace: s.identity.workspaceId,
        owner: s.identity.ownerId,
        itemId,
        documentId,
        panelId,
        heading,
        item,
        direction: f.direction,
        feedback: text,
        now
      })
    return documentId
  })
  s.touch('action_items', ...(touched ? [touched] : []))
  const actionItemId = 'actionItemId' in f && f.actionItemId ? f.actionItemId : null
  return { id, actionItemId, direction: f.direction, feedback: text, createdAt: now, updatedAt: now }
}

/**
 * "Keep regenerated": for every source note, the unreviewed non-archived items are
 * replaced by its regenerated ones, all in one transaction. Items of a note outside
 * `noteIds`, or of a note that is gone, are skipped. Resolves with the rows written.
 */
export function applyRegeneratedActionItems(
  s: StoreCtx,
  noteIds: string[],
  items: RegeneratedActionItem[]
): { insertedCount: number } {
  if (!Array.isArray(noteIds) || noteIds.length > MAX_LIST || noteIds.some((n) => typeof n !== 'string' || !n)) {
    throw invalid('noteIds are invalid')
  }
  if (!Array.isArray(items) || items.length > noteIds.length * ACTION_ITEMS_LIMITS.perNote) throw invalid('items are invalid')
  const notes = [...new Set(noteIds)]
  const insertedCount = inTransaction(s.db, () => {
    const now = nowIso()
    let count = 0
    for (const noteId of notes) {
      const live = s.db.prepare(`SELECT 1 FROM documents WHERE id = ? AND deleted_at IS NULL`).get(noteId)
      if (!live) continue
      deleteReplaceable(s, noteId)
      const panel = s.db
        .prepare(
          `SELECT id FROM note_panels WHERE document_id = ? AND deleted_at IS NULL ORDER BY created_at DESC, rid DESC LIMIT 1`
        )
        .get(noteId) as { id: string } | undefined
      const clean = items
        .filter((i) => typeof i === 'object' && i !== null && i.sourceNoteId === noteId)
        .map((i) => cleanItem(i))
        .filter((i): i is CleanItem => i !== null)
        .slice(0, ACTION_ITEMS_LIMITS.perNote)
      count += insertItems(s, noteId, panel?.id ?? null, clean, now).length
    }
    return count
  })
  s.touch('action_items', ...notes)
  s.log('info', 'action-items-regenerated-applied', { notes: notes.length, insertedCount })
  return { insertedCount }
}
