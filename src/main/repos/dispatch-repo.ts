// SPDX-License-Identifier: Apache-2.0
// Dispatch: the storage-worker side of its StorageApi group. Worker-safe: no Electron imports.
//
// - To-dos mirror the notes' action items (one per item). Their status syncs both ways inside
//   this repo's transactions: a to-do write also writes `action_items.status`, and a list first
//   takes over a status changed on the action item (marking the item done marks the to-do done,
//   and back).
// - Dispatches carry a label `D<n>` among the open ones, oldest first.
// - Runs: one row per owner and local day.

import { randomUUID } from 'node:crypto'
import type { IsoTime } from '@shared/types/common'
import type { Dispatch, DispatchRunStatus, DispatchStatus, DispatchTodo, DispatchTodoStatus, DispatchTodoType, DispatchType } from '@shared/types/dispatch'
import type { DispatchInsert, DispatchRunRow, DispatchTodoUpsert } from '../storage/api'
import { nowIso } from '../storage/rows'
import { inTransaction, invalid, notFound, type StoreCtx } from '../storage/store'

type Row = Record<string, unknown>

const TODO_STATUSES: readonly DispatchTodoStatus[] = ['open', 'done', 'dismissed']
const DISPATCH_STATUSES: readonly DispatchStatus[] = ['open', 'done', 'archived']
const LIST_MAX = 500

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function toTodo(r: Row): DispatchTodo {
  const conf = r['confidence']
  return {
    id: String(r['id']),
    action_item_id: String(r['action_item_id']),
    document_id: str(r['document_id']),
    type: String(r['type']) as DispatchTodoType,
    confidence: conf === 'high' || conf === 'low' ? conf : null,
    title: String(r['title']),
    task: String(r['task']),
    status: String(r['status']) as DispatchTodoStatus,
    meeting_title: str(r['meeting_title']),
    meeting_at: r['meeting_unix'] == null ? null : new Date(Number(r['meeting_unix']) * 1000).toISOString(),
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at'])
  }
}

function toDispatch(r: Row, labels: Map<string, string>): Dispatch {
  return {
    id: String(r['id']),
    label: labels.get(String(r['id'])) ?? '',
    todo_id: str(r['todo_id']),
    title: String(r['title']),
    type: String(r['type']) as DispatchType,
    task: String(r['task']),
    source: String(r['source'] ?? ''),
    run_day: String(r['run_day']),
    reason: str(r['reason']),
    thread_id: str(r['thread_id']),
    status: String(r['status']) as DispatchStatus,
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at'])
  }
}

/** The action item's status wins where the two disagree: only action items write one side alone. */
function syncFromActionItems(s: StoreCtx): void {
  const now = nowIso()
  const rows = s.db
    .prepare(
      `SELECT t.id, t.status, a.status AS item_status FROM dispatch_todos t JOIN action_items a ON a.id = t.action_item_id
       WHERE t.owner_id = ? AND ((a.status = 'done' AND t.status = 'open') OR (a.status = 'todo' AND t.status = 'done'))`
    )
    .all(s.identity.ownerId) as Row[]
  if (rows.length === 0) return
  const set = s.db.prepare(`UPDATE dispatch_todos SET status = ?, updated_at = ? WHERE id = ?`)
  inTransaction(s.db, () => {
    for (const r of rows) set.run(r['item_status'] === 'done' ? 'done' : 'open', now, r['id'])
  })
  s.touch('dispatch_todos', ...rows.map((r) => String(r['id'])))
}

export function listDispatchTodos(s: StoreCtx, q: { statuses?: DispatchTodoStatus[]; since?: IsoTime }): DispatchTodo[] {
  syncFromActionItems(s)
  const where = ['t.owner_id = ?', 'a.deleted_at IS NULL', 'a.archived_at IS NULL', '(d.id IS NULL OR d.deleted_at IS NULL)']
  const args: unknown[] = [s.identity.ownerId]
  const statuses = (q.statuses ?? []).filter((x) => TODO_STATUSES.includes(x))
  if (statuses.length) {
    where.push(`t.status IN (${statuses.map(() => '?').join(', ')})`)
    args.push(...statuses)
  }
  if (q.since) {
    where.push('t.created_at >= ?')
    args.push(q.since)
  }
  const rows = s.db
    .prepare(
      `SELECT t.*, d.title AS meeting_title, d.sort_epoch AS meeting_unix FROM dispatch_todos t
       JOIN action_items a ON a.id = t.action_item_id LEFT JOIN documents d ON d.id = t.document_id
       WHERE ${where.join(' AND ')}
       ORDER BY coalesce(d.sort_epoch, 0) DESC, t.created_at DESC LIMIT ${LIST_MAX}`
    )
    .all(...args) as Row[]
  return rows.map(toTodo)
}

export function upsertDispatchTodos(s: StoreCtx, ts: DispatchTodoUpsert[]): DispatchTodo[] {
  if (ts.length === 0) return []
  const now = nowIso()
  const ids = inTransaction(s.db, () => {
    const out: string[] = []
    for (const t of ts) {
      const item = s.db.prepare(`SELECT id FROM action_items WHERE id = ? AND owner_id = ?`).get(t.action_item_id, s.identity.ownerId)
      if (!item) continue
      const cur = s.db.prepare(`SELECT id FROM dispatch_todos WHERE action_item_id = ?`).get(t.action_item_id) as Row | undefined
      if (cur) {
        // Reclassifying keeps the user's status.
        s.db
          .prepare(`UPDATE dispatch_todos SET document_id = ?, type = ?, confidence = ?, title = ?, task = ?, updated_at = ? WHERE id = ?`)
          .run(t.document_id, t.type, t.confidence, t.title, t.task, now, cur['id'])
        out.push(String(cur['id']))
      } else {
        const id = randomUUID()
        s.db
          .prepare(
            `INSERT INTO dispatch_todos (id, workspace_id, owner_id, action_item_id, document_id, type, confidence, title, task, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(id, s.identity.workspaceId, s.identity.ownerId, t.action_item_id, t.document_id, t.type, t.confidence, t.title, t.task, t.status, now, now)
        out.push(id)
      }
    }
    return out
  })
  if (ids.length) s.touch('dispatch_todos', ...ids)
  const get = s.db.prepare(
    `SELECT t.*, d.title AS meeting_title, d.sort_epoch AS meeting_unix FROM dispatch_todos t
     LEFT JOIN documents d ON d.id = t.document_id WHERE t.id = ?`
  )
  return ids.map((id) => toTodo(get.get(id) as Row))
}

export function setDispatchTodoStatus(s: StoreCtx, id: string, status: DispatchTodoStatus): void {
  if (!TODO_STATUSES.includes(status)) throw invalid('Unknown status.')
  const now = nowIso()
  const itemId = inTransaction(s.db, () => {
    const cur = s.db.prepare(`SELECT action_item_id FROM dispatch_todos WHERE id = ? AND owner_id = ?`).get(id, s.identity.ownerId) as Row | undefined
    if (!cur) throw notFound('To-do', id)
    s.db.prepare(`UPDATE dispatch_todos SET status = ?, updated_at = ? WHERE id = ?`).run(status, now, id)
    // Dismissing a to-do leaves the action item as it is.
    if (status !== 'dismissed') {
      s.db.prepare(`UPDATE action_items SET status = ?, updated_at = ? WHERE id = ?`).run(status === 'done' ? 'done' : 'todo', now, cur['action_item_id'])
    }
    return String(cur['action_item_id'])
  })
  s.touch('dispatch_todos', id)
  if (status !== 'dismissed') s.touch('action_items', itemId)
}

function openLabels(s: StoreCtx): Map<string, string> {
  const rows = s.db.prepare(`SELECT id FROM dispatches WHERE owner_id = ? AND status = 'open' ORDER BY created_at ASC, rid ASC`).all(s.identity.ownerId) as Row[]
  return new Map(rows.map((r, i) => [String(r['id']), `D${i + 1}`]))
}

export function listDispatches(s: StoreCtx, q: { view: 'today' | 'archived'; day: string }): Dispatch[] {
  const rows =
    q.view === 'archived'
      ? (s.db
          .prepare(`SELECT * FROM dispatches WHERE owner_id = ? AND status = 'archived' ORDER BY run_day DESC, created_at DESC LIMIT ${LIST_MAX}`)
          .all(s.identity.ownerId) as Row[])
      : (s.db
          .prepare(
            `SELECT * FROM dispatches WHERE owner_id = ? AND (status = 'open' OR (status = 'done' AND run_day = ?))
             ORDER BY run_day DESC, created_at ASC LIMIT ${LIST_MAX}`
          )
          .all(s.identity.ownerId, q.day) as Row[])
  const labels = openLabels(s)
  return rows.map((r) => toDispatch(r, labels))
}

export function insertDispatches(s: StoreCtx, ds: DispatchInsert[]): Dispatch[] {
  if (ds.length === 0) return []
  const now = nowIso()
  const ids = inTransaction(s.db, () =>
    ds.map((d) => {
      if (!DISPATCH_STATUSES.includes(d.status)) throw invalid('Unknown status.')
      const id = randomUUID()
      s.db
        .prepare(
          `INSERT INTO dispatches (id, workspace_id, owner_id, todo_id, title, type, task, source, run_day, reason, thread_id, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, s.identity.workspaceId, s.identity.ownerId, d.todo_id, d.title, d.type, d.task, d.source, d.run_day, d.reason, d.thread_id, d.status, now, now)
      return id
    })
  )
  s.touch('dispatches', ...ids)
  const labels = openLabels(s)
  const get = s.db.prepare(`SELECT * FROM dispatches WHERE id = ?`)
  return ids.map((id) => toDispatch(get.get(id) as Row, labels))
}

export function resurfaceDispatches(s: StoreCtx, items: { id: string; day: string; reason: string }[]): void {
  if (items.length === 0) return
  const now = nowIso()
  const set = s.db.prepare(`UPDATE dispatches SET run_day = ?, reason = ?, updated_at = ? WHERE id = ? AND owner_id = ? AND status = 'open'`)
  inTransaction(s.db, () => {
    for (const i of items) set.run(i.day, i.reason, now, i.id, s.identity.ownerId)
  })
  s.touch('dispatches', ...items.map((i) => i.id))
}

export function archiveUnstartedDispatches(s: StoreCtx, beforeDay: string): number {
  const ids = (
    s.db
      .prepare(`SELECT id FROM dispatches WHERE owner_id = ? AND status = 'open' AND thread_id IS NULL AND run_day < ?`)
      .all(s.identity.ownerId, beforeDay) as Row[]
  ).map((r) => String(r['id']))
  if (ids.length === 0) return 0
  const now = nowIso()
  const set = s.db.prepare(`UPDATE dispatches SET status = 'archived', updated_at = ? WHERE id = ?`)
  inTransaction(s.db, () => {
    for (const id of ids) set.run(now, id)
  })
  s.touch('dispatches', ...ids)
  return ids.length
}

export function setDispatch(s: StoreCtx, id: string, patch: { status?: DispatchStatus; thread_id?: string }): void {
  if (patch.status && !DISPATCH_STATUSES.includes(patch.status)) throw invalid('Unknown status.')
  const cur = s.db.prepare(`SELECT status, thread_id FROM dispatches WHERE id = ? AND owner_id = ?`).get(id, s.identity.ownerId) as Row | undefined
  if (!cur) throw notFound('Dispatch', id)
  s.db
    .prepare(`UPDATE dispatches SET status = ?, thread_id = ?, updated_at = ? WHERE id = ?`)
    .run(patch.status ?? cur['status'], patch.thread_id ?? cur['thread_id'] ?? null, nowIso(), id)
  s.touch('dispatches', id)
}

function toRun(r: Row): DispatchRunRow {
  return {
    run_day: String(r['run_day']),
    status: String(r['status']) as DispatchRunStatus,
    started_at: str(r['started_at']),
    finished_at: str(r['finished_at']),
    proposed: Number(r['proposed'] ?? 0),
    archived: Number(r['archived'] ?? 0),
    reason: str(r['reason'])
  }
}

export function getDispatchRun(s: StoreCtx, day: string): DispatchRunRow | null {
  const r = s.db.prepare(`SELECT * FROM dispatch_runs WHERE owner_id = ? AND run_day = ?`).get(s.identity.ownerId, day) as Row | undefined
  return r ? toRun(r) : null
}

export function upsertDispatchRun(s: StoreCtx, r: DispatchRunRow): void {
  s.db
    .prepare(
      `INSERT INTO dispatch_runs (run_day, workspace_id, owner_id, status, started_at, finished_at, proposed, archived, reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (owner_id, run_day) DO UPDATE SET status = excluded.status, started_at = excluded.started_at,
         finished_at = excluded.finished_at, proposed = excluded.proposed, archived = excluded.archived, reason = excluded.reason`
    )
    .run(r.run_day, s.identity.workspaceId, s.identity.ownerId, r.status, r.started_at, r.finished_at, r.proposed, r.archived, r.reason)
  s.touch('dispatch_runs', r.run_day)
}

export function pruneDispatchRuns(s: StoreCtx, beforeDay: string): number {
  const r = s.db.prepare(`DELETE FROM dispatch_runs WHERE owner_id = ? AND run_day < ?`).run(s.identity.ownerId, beforeDay)
  if (r.changes) s.touch('dispatch_runs')
  return r.changes
}
