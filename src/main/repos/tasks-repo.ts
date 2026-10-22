// SPDX-License-Identifier: Apache-2.0
// Tasks: the storage-worker side of their StorageApi group. Worker-safe: no Electron imports.
//
// A note's tasks are the `taskItem` nodes of its newest summary panel (not deleted, newest
// by last-viewed time, else creation time). The panel's document is read from, in order:
// - its Yjs room (`summary:1:<panelId>`, fragment `prosemirror`) when the room has content;
// - else the ProseMirror JSON projection (`content`), which the editor seeds the room from;
// - else the markdown (`content_markdown`, else `generated_content`), the editor's other seed.
// Node paths are child indexes from the root in that same document, so a toggle reaches the
// item the list showed. A toggle on a room returns the Yjs update (main appends and pushes it);
// on an unseeded panel it rewrites the seed the editor will use, in place.

import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import type { IsoTime } from '@shared/types/common'
import { DEMO_MEETING_PREFIX } from '@shared/types/notes'
import { TASKS_LIMITS, type ManualTask, type TaskGroup, type TaskItem, type TasksList } from '@shared/types/tasks'
import { YDOC_FRAGMENT, YDOC_ROOM_VERSION } from '@shared/types/ydoc'
import { nowIso, parseJson } from '../storage/rows'
import { inTransaction, invalid, type StoreCtx } from '../storage/store'

type Row = Record<string, unknown>

/** Older notes scanned for "Show <n> more from older meetings". */
const OLDER_NOTES_MAX = 300

// ---------- one tree shape over the three sources ----------

interface TNode {
  type: string
  attrs: Record<string, unknown>
  children: TNode[]
  /** Text of a text node (JSON) or of a Y.XmlText run. */
  text?: string
  /** Markdown source: the line of a task item. */
  line?: number
}

function fromY(el: Y.XmlElement | Y.XmlFragment): TNode[] {
  const out: TNode[] = []
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlElement) out.push({ type: child.nodeName, attrs: child.getAttributes(), children: fromY(child) })
    else if (child instanceof Y.XmlText) {
      let text = ''
      for (const d of child.toDelta() as { insert?: unknown }[]) if (typeof d.insert === 'string') text += d.insert
      out.push({ type: 'text', attrs: {}, children: [], text })
    }
  }
  return out
}

function fromJson(v: unknown): TNode | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as { type?: unknown; attrs?: unknown; content?: unknown; text?: unknown }
  if (typeof o.type !== 'string') return null
  const children = Array.isArray(o.content) ? o.content.map(fromJson).filter((c): c is TNode => c !== null) : []
  const attrs = typeof o.attrs === 'object' && o.attrs !== null ? (o.attrs as Record<string, unknown>) : {}
  return { type: o.type, attrs, children, ...(typeof o.text === 'string' ? { text: o.text } : {}) }
}

const TASK_LINE = /^(\s*)[-*+]\s+\[([ xX])\]\s?(.*)$/
const BULLET_LINE = /^(\s*)(?:[-*+]|\d+[.)])\s+(.*)$/

/**
 * The editor's block structure of a markdown summary, enough for task paths: blank lines
 * separate blocks; consecutive list lines form one list; an indented task line nests under the
 * previous item (child 1, after its paragraph). Headings and rules are one block each.
 */
function fromMarkdown(markdown: string): TNode[] {
  const lines = markdown.split(/\r?\n/)
  const blocks: TNode[] = []
  let para: string[] | null = null
  let list: { node: TNode; task: boolean } | null = null
  const endPara = (): void => {
    if (para) blocks.push({ type: 'paragraph', attrs: {}, children: [{ type: 'text', attrs: {}, children: [], text: para.join(' ') }] })
    para = null
  }
  const item = (type: string, text: string, attrs: Record<string, unknown>, line: number): TNode => ({
    type,
    attrs,
    line,
    children: [{ type: 'paragraph', attrs: {}, children: [{ type: 'text', attrs: {}, children: [], text }] }]
  })
  lines.forEach((raw, i) => {
    const task = TASK_LINE.exec(raw)
    const bullet = task ? null : BULLET_LINE.exec(raw)
    if (!raw.trim()) {
      endPara()
      list = null
      return
    }
    if (task || bullet) {
      endPara()
      const indent = (task ?? bullet)![1]!.length
      const isTask = !!task
      const node = isTask ? item('taskItem', task![3]!, { checked: task![2] !== ' ' }, i) : item('listItem', bullet![2]!, {}, i)
      if (list && indent >= 2 && list.node.children.length) {
        const parent = list.node.children[list.node.children.length - 1]!
        const nested = parent.children[1]
        if (nested) nested.children.push(node)
        else parent.children.push({ type: isTask ? 'taskList' : 'bulletList', attrs: {}, children: [node] })
        return
      }
      if (!list || list.task !== isTask) {
        list = { node: { type: isTask ? 'taskList' : 'bulletList', attrs: {}, children: [] }, task: isTask }
        blocks.push(list.node)
      }
      list.node.children.push(node)
      return
    }
    list = null
    if (/^#{1,6}\s/.test(raw) || /^(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {
      endPara()
      blocks.push({ type: raw.startsWith('#') ? 'heading' : 'horizontalRule', attrs: {}, children: [{ type: 'text', attrs: {}, children: [], text: raw.replace(/^#+\s*/, '') }] })
      return
    }
    ;(para ??= []).push(raw.trim())
  })
  endPara()
  return blocks
}

function textOf(n: TNode): string {
  if (n.text !== undefined) return n.text
  return n.children.map(textOf).join(n.type === 'doc' ? '\n' : '')
}

/** Block text joined by spaces between blocks, so "a" + "b" don't run together. */
function blockText(n: TNode): string {
  if (n.text !== undefined) return n.text
  const inline = n.children.every((c) => c.text !== undefined)
  return inline ? n.children.map(textOf).join('') : n.children.map(blockText).filter(Boolean).join(' ')
}

interface Found {
  path: number[]
  node: TNode
  top: number
}

function findTasks(nodes: TNode[], prefix: number[], top: number, out: Found[]): Found[] {
  nodes.forEach((n, i) => {
    const path = [...prefix, i]
    const t = prefix.length === 0 ? i : top
    if (n.type === 'taskItem') out.push({ path, node: n, top: t })
    findTasks(n.children, path, t, out)
  })
  return out
}

function nodeAt(nodes: TNode[], path: number[]): TNode | null {
  let cur: TNode | null = null
  let list = nodes
  for (const i of path) {
    cur = list[i] ?? null
    if (!cur) return null
    list = cur.children
  }
  return cur
}

// ---------- reading a panel ----------

type Source = { kind: 'ydoc'; doc: Y.Doc } | { kind: 'json'; json: unknown } | { kind: 'markdown'; markdown: string; column: 'content_markdown' | 'generated_content' }

function roomOf(panelId: string): string {
  return `summary:${YDOC_ROOM_VERSION}:${panelId}`
}

/** The room's merged document, or null when it has no content. Bad rows are skipped (load quarantines them). */
function loadRoom(s: StoreCtx, panelId: string): Y.Doc | null {
  const rows = s.db.prepare(`SELECT data FROM ydocs WHERE room_id = ? ORDER BY seq ASC`).all(roomOf(panelId)) as { data: Uint8Array }[]
  if (rows.length === 0) return null
  const doc = new Y.Doc()
  for (const r of rows) {
    try {
      Y.applyUpdate(doc, r.data)
    } catch {
      // skipped
    }
  }
  if (doc.getXmlFragment(YDOC_FRAGMENT).length === 0) {
    doc.destroy()
    return null
  }
  return doc
}

function sourceOf(s: StoreCtx, panel: Row): Source | null {
  const doc = loadRoom(s, String(panel['id']))
  if (doc) return { kind: 'ydoc', doc }
  const json = parseJson<unknown>(panel['content'], null)
  if (json && fromJson(json)) return { kind: 'json', json }
  const md = typeof panel['content_markdown'] === 'string' && panel['content_markdown'] ? panel['content_markdown'] : null
  if (md) return { kind: 'markdown', markdown: md, column: 'content_markdown' }
  const orig = typeof panel['generated_content'] === 'string' && panel['generated_content'] ? panel['generated_content'] : null
  return orig ? { kind: 'markdown', markdown: orig, column: 'generated_content' } : null
}

function treeOf(src: Source): TNode[] {
  switch (src.kind) {
    case 'ydoc':
      return fromY(src.doc.getXmlFragment(YDOC_FRAGMENT))
    case 'json':
      return fromJson(src.json)?.children ?? []
    case 'markdown':
      return fromMarkdown(src.markdown)
  }
}

function itemsOf(s: StoreCtx, documentId: string, panel: Row): TaskItem[] {
  const src = sourceOf(s, panel)
  if (!src) return []
  try {
    const tree = treeOf(src)
    const items: TaskItem[] = []
    for (const f of findTasks(tree, [], 0, [])) {
      const text = blockText(f.node).replace(/\s+/g, ' ').trim()
      if (!text) continue
      const around = [tree[f.top - 1], tree[f.top + 1]].map((b) => (b ? blockText(b).trim() : '')).filter(Boolean)
      const description = f.node.attrs['description']
      items.push({
        documentId,
        panelId: String(panel['id']),
        nodePath: f.path,
        text,
        checked: f.node.attrs['checked'] === true || f.node.attrs['checked'] === 'true',
        description: typeof description === 'string' && description ? description : null,
        context: around.join('\n')
      })
    }
    return items
  } finally {
    if (src.kind === 'ydoc') src.doc.destroy()
  }
}

// ---------- queries ----------

const NOTE_COLS = `d.id, d.title, d.created_at, d.sort_epoch AS meeting_unix`
const OWN_NOTES = `d.owner_id = ? AND d.deleted_at IS NULL AND d.is_scratchpad = 0 AND d.id NOT LIKE '${DEMO_MEETING_PREFIX}%'`

function newestPanel(s: StoreCtx, documentId: string): Row | null {
  return (
    (s.db
      .prepare(
        `SELECT id, content, content_markdown, generated_content FROM note_panels
         WHERE document_id = ? AND deleted_at IS NULL
         ORDER BY coalesce(last_opened_at, created_at) DESC, created_at DESC LIMIT 1`
      )
      .get(documentId) as Row | undefined) ?? null
  )
}

function groupOf(s: StoreCtx, note: Row): TaskGroup | null {
  const panel = newestPanel(s, String(note['id']))
  if (!panel) return null
  const items = itemsOf(s, String(note['id']), panel)
  if (items.length === 0) return null
  return {
    documentId: String(note['id']),
    title: typeof note['title'] === 'string' && note['title'] ? note['title'] : null,
    meetingAt: new Date(Number(note['meeting_unix']) * 1000).toISOString(),
    items
  }
}

const byMeeting = (a: TaskGroup, b: TaskGroup): number => (a.meetingAt < b.meetingAt ? 1 : a.meetingAt > b.meetingAt ? -1 : 0)

function visible(g: TaskGroup, showCompleted: boolean): TaskGroup | null {
  const items = showCompleted ? g.items : g.items.filter((i) => !i.checked)
  return items.length ? { ...g, items } : null
}

function toManual(r: Row): ManualTask {
  return { id: String(r['id']), text: String(r['text']), checked: r['checked'] === 1, created_at: String(r['created_at']) }
}

export function listTasks(s: StoreCtx, q: { since: IsoTime; showCompleted: boolean; includeOlder: boolean }): TasksList {
  const owner = s.identity.ownerId
  const recent = s.db.prepare(`SELECT ${NOTE_COLS} FROM documents d WHERE ${OWN_NOTES} AND d.created_at >= ?`).all(owner, q.since) as Row[]
  const older = s.db
    .prepare(`SELECT ${NOTE_COLS} FROM documents d WHERE ${OWN_NOTES} AND d.created_at < ? ORDER BY d.created_at DESC LIMIT ${OLDER_NOTES_MAX}`)
    .all(owner, q.since) as Row[]
  const recentGroups = recent.map((n) => groupOf(s, n)).filter((g): g is TaskGroup => g !== null)
  const olderGroups = older.map((n) => groupOf(s, n)).filter((g): g is TaskGroup => g !== null)
  const shownRecent = recentGroups.map((g) => visible(g, q.showCompleted)).filter((g): g is TaskGroup => g !== null)
  const shownOlder = olderGroups.map((g) => visible(g, q.showCompleted)).filter((g): g is TaskGroup => g !== null)
  const groups = (q.includeOlder ? [...shownRecent, ...shownOlder] : shownRecent).sort(byMeeting)
  const manualRows = s.db
    .prepare(`SELECT * FROM manual_tasks WHERE owner_id = ? ${q.showCompleted ? '' : 'AND checked = 0'} ORDER BY created_at DESC, rid DESC`)
    .all(owner) as Row[]
  return {
    manual: manualRows.map(toManual),
    groups,
    olderCount: q.includeOlder ? 0 : shownOlder.length,
    openCount: taskBadge(s, new Date(Date.parse(q.since)).toISOString())
  }
}

export function taskBadge(s: StoreCtx, since: IsoTime): number {
  const sinceUnix = Math.floor(Date.parse(since) / 1000)
  const notes = s.db.prepare(`SELECT ${NOTE_COLS} FROM documents d WHERE ${OWN_NOTES} AND d.sort_epoch >= ?`).all(s.identity.ownerId, sinceUnix) as Row[]
  let n = 0
  for (const note of notes) {
    const g = groupOf(s, note)
    if (g) n += g.items.filter((i) => !i.checked).length
  }
  return n
}

// ---------- writes ----------

export function toggleTaskItem(s: StoreCtx, t: { panelId: string; nodePath: number[]; checked: boolean }): { roomId: string; update: Uint8Array } | null {
  const panel = s.db
    .prepare(`SELECT id, content, content_markdown, generated_content FROM note_panels WHERE id = ? AND deleted_at IS NULL AND owner_id = ?`)
    .get(t.panelId, s.identity.ownerId) as Row | undefined
  if (!panel) return null
  const src = sourceOf(s, panel)
  if (!src) return null
  if (src.kind === 'ydoc') {
    try {
      let el: Y.XmlElement | Y.XmlFragment = src.doc.getXmlFragment(YDOC_FRAGMENT)
      for (const i of t.nodePath) {
        const next: unknown = el.get(i)
        if (!(next instanceof Y.XmlElement)) return null
        el = next
      }
      if (!(el instanceof Y.XmlElement) || el.nodeName !== 'taskItem') return null
      const target = el
      if ((target.getAttribute('checked') as unknown) === t.checked) return null
      const before = Y.encodeStateVector(src.doc)
      // y-prosemirror keeps node attributes as their JSON values.
      src.doc.transact(() => target.setAttribute('checked', t.checked as unknown as string))
      return { roomId: roomOf(t.panelId), update: Y.encodeStateAsUpdate(src.doc, before) }
    } finally {
      src.doc.destroy()
    }
  }
  const now = nowIso()
  if (src.kind === 'json') {
    const json = src.json as { content?: unknown[] }
    let cur: { type?: unknown; attrs?: Record<string, unknown>; content?: unknown[] } | undefined = json
    for (const i of t.nodePath) cur = cur?.content?.[i] as typeof cur
    if (!cur || cur.type !== 'taskItem') return null
    cur.attrs = { ...(cur.attrs ?? {}), checked: t.checked }
    s.db.prepare(`UPDATE note_panels SET content = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(json), now, t.panelId)
    s.touch('note_panels', t.panelId)
    return null
  }
  const node = nodeAt(fromMarkdown(src.markdown), t.nodePath)
  if (!node || node.type !== 'taskItem' || node.line === undefined) return null
  const lines = src.markdown.split(/\r?\n/)
  const m = TASK_LINE.exec(lines[node.line] ?? '')
  if (!m) return null
  lines[node.line] = lines[node.line]!.replace(/\[([ xX])\]/, t.checked ? '[x]' : '[ ]')
  s.db.prepare(`UPDATE note_panels SET ${src.column} = ?, updated_at = ? WHERE id = ?`).run(lines.join('\n'), now, t.panelId)
  s.touch('note_panels', t.panelId)
  return null
}

export function addManualTask(s: StoreCtx, text: string): ManualTask {
  const clean = text.replace(/\s+/g, ' ').trim()
  if (!clean) throw invalid('A task needs some text.')
  if (clean.length > TASKS_LIMITS.textMax) throw invalid(`A task is at most ${TASKS_LIMITS.textMax} characters.`)
  const row = { id: randomUUID(), text: clean, checked: 0, created_at: nowIso() }
  inTransaction(s.db, () =>
    s.db
      .prepare(`INSERT INTO manual_tasks (id, workspace_id, owner_id, text, checked, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)`)
      .run(row.id, s.identity.workspaceId, s.identity.ownerId, row.text, row.created_at, row.created_at)
  )
  s.touch('manual_tasks', row.id)
  return { id: row.id, text: row.text, checked: false, created_at: row.created_at }
}

export function setManualTask(s: StoreCtx, id: string, checked: boolean): void {
  const r = s.db.prepare(`UPDATE manual_tasks SET checked = ?, updated_at = ? WHERE id = ? AND owner_id = ?`).run(checked ? 1 : 0, nowIso(), id, s.identity.ownerId)
  if (r.changes) s.touch('manual_tasks', id)
}

export function deleteManualTask(s: StoreCtx, id: string): void {
  const r = s.db.prepare(`DELETE FROM manual_tasks WHERE id = ? AND owner_id = ?`).run(id, s.identity.ownerId)
  if (r.changes) s.touch('manual_tasks', id)
}
