// SPDX-License-Identifier: Apache-2.0
// The folder tables: `folders`, `folder_notes`
// and `folder_rules`. Main's rules: no third level, no cycles, the favourite cascade, and
// a delete that lifts subfolders and never touches notes. A permanent note
// delete removes memberships through the `folder_notes.note_id` cascade.
//
// Every write touches its tables with **folder ids only**, so main forwards a change as
// `folders:changed { folderIds }` without telling note ids apart.

import { randomUUID } from 'node:crypto'
import type {
  Folder,
  FolderCreate,
  FolderNoteSource,
  FolderPatch,
  FolderPresetId,
  FolderRule,
  FolderRuleInput,
  FolderRuleTarget,
  FoldersState
} from '@shared/types/folders'
import type { TemplateIcon } from '@shared/types/templates'
import { nowIso, parseJson } from './rows'
import { inTransaction, invalid, notFound, type StoreCtx } from './store'

type Row = Record<string, unknown>

const PRESETS: readonly FolderPresetId[] = [
  'interviews',
  'standups',
  'projects',
  'sales_pipeline',
  'team_syncs',
  'coaching',
  'demos',
  'client_meetings'
]
const SOURCES: readonly FolderNoteSource[] = [
  'manual',
  'palette',
  'dragged',
  'add_notes',
  'suggestion',
  'series_rule'
]

const COLS =
  'id, workspace_id, owner_id, parent_id, title, description, icon, preset, is_favourite, visibility, sort_order, created_at, updated_at'
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TITLE = 500
const MAX_DESCRIPTION = 10_000
const MAX_NOTES_PER_ADD = 10_000
const MAX_SKIPPED_EVENTS = 10_000
const MAX_TEXT_ID = 1_024

const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function toFolder(r: Row): Folder {
  const preset = str(r['preset'])
  return {
    id: String(r['id']),
    workspace_id: String(r['workspace_id']),
    owner_id: String(r['owner_id']),
    parent_id: str(r['parent_id']),
    title: str(r['title']) ?? '',
    description: str(r['description']),
    icon: iconOrNull(parseJson<unknown>(r['icon'], null)),
    preset: PRESETS.includes(preset as FolderPresetId) ? (preset as FolderPresetId) : null,
    is_favourite: r['is_favourite'] === 1,
    visibility: r['visibility'] === 'workspace' ? 'workspace' : 'private',
    sort_order: Number(r['sort_order']) || 0,
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at'])
  }
}

function toRule(r: Row): FolderRule | null {
  const target = targetOrNull(parseJson<unknown>(r['target'], null))
  if (!target) return null
  return {
    id: String(r['id']),
    folder_id: String(r['folder_id']),
    recurring_event_id: String(r['recurring_event_id']),
    target,
    created_at: String(r['created_at'])
  }
}

// ---------- shape checks (main validates IPC payloads too; these guard every caller) ----------

function iconOrNull(v: unknown): TemplateIcon | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (o['type'] === 'icon' && typeof o['value'] === 'string' && typeof o['color'] === 'string') {
    return { type: 'icon', value: o['value'], color: o['color'] }
  }
  if (o['type'] === 'emoji' && typeof o['value'] === 'string' && typeof o['hexcode'] === 'string') {
    return { type: 'emoji', value: o['value'], hexcode: o['hexcode'] }
  }
  return null
}

function icon(v: unknown): TemplateIcon | null {
  if (v === null || v === undefined) return null
  const parsed = iconOrNull(v)
  if (!parsed || parsed.value.length > 64 || ('color' in parsed ? parsed.color : parsed.hexcode).length > 64) {
    throw invalid('icon must be { type: "icon", value, color } or { type: "emoji", value, hexcode }')
  }
  return parsed
}

function targetOrNull(v: unknown): FolderRuleTarget | null {
  if (typeof v !== 'object' || v === null) return null
  const o = v as Record<string, unknown>
  if (o['type'] === 'single' && typeof o['event_id'] === 'string' && o['event_id']) {
    return { type: 'single', event_id: o['event_id'] }
  }
  if (o['type'] === 'all' && Array.isArray(o['excluded_event_ids'])) {
    return { type: 'all', excluded_event_ids: o['excluded_event_ids'].filter((x): x is string => typeof x === 'string') }
  }
  return null
}

function target(v: unknown): FolderRuleTarget {
  const t = targetOrNull(v)
  if (!t) throw invalid('target must be { type: "single", event_id } or { type: "all", excluded_event_ids }')
  if (t.type === 'single' && t.event_id.length > MAX_TEXT_ID) throw invalid('event_id is too long')
  if (t.type === 'all') {
    if (t.excluded_event_ids.length > MAX_SKIPPED_EVENTS) throw invalid('too many skipped events')
    t.excluded_event_ids = [...new Set(t.excluded_event_ids.filter((e) => e && e.length <= MAX_TEXT_ID))]
  }
  return t
}

function title(v: unknown): string {
  if (typeof v !== 'string') throw invalid('title must be a string')
  const t = v.trim()
  if (t.length > MAX_TITLE) throw invalid(`title must be at most ${MAX_TITLE} characters`)
  return t
}

function description(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string') throw invalid('description must be a string or null')
  if (v.length > MAX_DESCRIPTION) throw invalid(`description must be at most ${MAX_DESCRIPTION} characters`)
  return v.trim() ? v : null
}

// ---------- reads ----------

function scope(s: StoreCtx): { owner: string; workspace: string } {
  return { owner: s.identity.ownerId, workspace: s.identity.workspaceId }
}

function getFolder(s: StoreCtx, id: string): Folder | null {
  const row = s.db
    .prepare(`SELECT ${COLS} FROM folders WHERE id = @id AND owner_id = @owner AND workspace_id = @workspace`)
    .get({ id, ...scope(s) }) as Row | undefined
  return row ? toFolder(row) : null
}

function requireFolder(s: StoreCtx, id: unknown): Folder {
  if (typeof id !== 'string' || !id) throw invalid('folderId is required')
  const folder = getFolder(s, id)
  if (!folder) throw notFound('folder', id)
  return folder
}

function childIds(s: StoreCtx, id: string): string[] {
  return (
    s.db.prepare(`SELECT id FROM folders WHERE parent_id = ? ORDER BY id`).all(id) as { id: string }[]
  ).map((r) => r.id)
}

/** The folder and everything below it (cycle-safe: a recursive CTE with UNION). */
function subtreeIds(s: StoreCtx, id: string): string[] {
  return (
    s.db
      .prepare(
        `WITH RECURSIVE tree(id) AS (
           SELECT ? UNION SELECT f.id FROM folders f JOIN tree t ON f.parent_id = t.id
         )
         SELECT id FROM tree`
      )
      .all(id) as { id: string }[]
  ).map((r) => r.id)
}

/**
 * `folders:list`: the user's folders, the membership map (non-deleted notes only, newest
 * addition first; an entry for every folder) and the auto-add rules.
 */
export function listFolders(s: StoreCtx): FoldersState {
  const folders = (
    s.db
      .prepare(`SELECT ${COLS} FROM folders WHERE owner_id = @owner AND workspace_id = @workspace ORDER BY created_at, id`)
      .all(scope(s)) as Row[]
  ).map(toFolder)
  const membership: Record<string, string[]> = {}
  for (const f of folders) membership[f.id] = []
  const rows = s.db
    .prepare(
      `SELECT fn.folder_id, fn.note_id FROM folder_notes fn
       JOIN folders f ON f.id = fn.folder_id
       JOIN documents d ON d.id = fn.note_id
       WHERE f.owner_id = @owner AND f.workspace_id = @workspace AND d.deleted_at IS NULL
       ORDER BY fn.created_at DESC, fn.note_id`
    )
    .all(scope(s)) as { folder_id: string; note_id: string }[]
  for (const r of rows) membership[r.folder_id]?.push(r.note_id)
  const rules = (
    s.db
      .prepare(
        `SELECT id, folder_id, recurring_event_id, target, created_at FROM folder_rules
         WHERE owner_id = @owner AND workspace_id = @workspace ORDER BY created_at, id`
      )
      .all(scope(s)) as Row[]
  )
    .map(toRule)
    .filter((r): r is FolderRule => r !== null)
  return { folders, membership, rules }
}

// ---------- folders ----------

/** A parent must be a top-level folder: a third level is refused. */
export function createFolder(s: StoreCtx, f: FolderCreate): Folder {
  if (typeof f !== 'object' || f === null) throw invalid('folder must be an object')
  let id: string
  if (f.id !== undefined) {
    if (typeof f.id !== 'string' || !UUID.test(f.id)) throw invalid('id must be a UUID')
    id = f.id.toLowerCase()
  } else {
    id = randomUUID()
  }
  const name = title(f.title)
  const desc = description(f.description)
  const ico = icon(f.icon)
  const preset = f.preset ?? null
  if (preset !== null && !PRESETS.includes(preset)) throw invalid('unknown preset')
  const parentId = f.parentId ?? null
  const now = nowIso()
  inTransaction(s.db, () => {
    if (s.db.prepare(`SELECT 1 FROM folders WHERE id = ?`).get(id)) throw invalid('a folder with this id already exists')
    let visibility: Folder['visibility'] = 'private'
    if (parentId !== null) {
      const parent = requireFolder(s, parentId)
      if (parent.parent_id !== null) throw invalid('Folders can be nested only one level deep')
      // A subfolder takes its parent's visibility.
      visibility = parent.visibility
    }
    s.db
      .prepare(
        `INSERT INTO folders (id, workspace_id, owner_id, parent_id, title, description, icon, preset,
           is_favourite, visibility, sort_order, created_at, updated_at)
         VALUES (@id, @workspace, @owner, @parent, @title, @description, @icon, @preset, 0, @visibility, 0, @now, @now)`
      )
      .run({
        id,
        ...scope(s),
        parent: parentId,
        title: name,
        description: desc,
        icon: ico ? JSON.stringify(ico) : null,
        preset,
        visibility,
        now
      })
  })
  s.touch('folders', id)
  s.log('info', 'folder-created', { id, nested: parentId !== null, preset })
  return getFolder(s, id) as Folder
}

/**
 * Title, description and icon move `updated_at`. `is_favourite` cascades to every
 * descendant and is not activity. A `parent_id` change is never the folder itself, never
 * a folder with subfolders, and only under a top-level folder (`null` = top level).
 */
export function updateFolder(s: StoreCtx, id: string, patch: FolderPatch): Folder {
  if (typeof patch !== 'object' || patch === null) throw invalid('patch must be an object')
  const touched = inTransaction(s.db, () => {
    const folder = requireFolder(s, id)
    const sets: string[] = []
    const params: Record<string, unknown> = { id: folder.id, now: nowIso() }
    if (patch.title !== undefined) {
      sets.push('title = @title')
      params['title'] = title(patch.title)
    }
    if (patch.description !== undefined) {
      sets.push('description = @description')
      params['description'] = description(patch.description)
    }
    if (patch.icon !== undefined) {
      sets.push('icon = @icon')
      const ico = icon(patch.icon)
      params['icon'] = ico ? JSON.stringify(ico) : null
    }
    if (patch.parent_id !== undefined && patch.parent_id !== folder.parent_id) {
      const parentId = patch.parent_id
      if (parentId !== null) {
        if (parentId === folder.id) throw invalid('A folder cannot contain itself')
        const parent = requireFolder(s, parentId)
        if (parent.parent_id !== null) throw invalid('Folders can be nested only one level deep')
        if (childIds(s, folder.id).length > 0) throw invalid('A folder with subfolders cannot be nested')
        // Cycle guard: the new parent must not sit below this folder.
        if (subtreeIds(s, folder.id).includes(parent.id)) throw invalid('A folder cannot move inside itself')
      }
      sets.push('parent_id = @parent')
      params['parent'] = parentId
    }
    const ids = [folder.id]
    if (sets.length) {
      s.db.prepare(`UPDATE folders SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params)
    }
    if (patch.is_favourite !== undefined) {
      if (typeof patch.is_favourite !== 'boolean') throw invalid('is_favourite must be a boolean')
      const tree = subtreeIds(s, folder.id)
      const stmt = s.db.prepare(`UPDATE folders SET is_favourite = ? WHERE id = ?`)
      for (const fid of tree) stmt.run(patch.is_favourite ? 1 : 0, fid)
      ids.push(...tree.filter((t) => t !== folder.id))
    }
    return ids
  })
  s.touch('folders', ...touched)
  return getFolder(s, id) as Folder
}

/**
 * One transaction lifts the subfolders to the deleted folder's parent (or the
 * top level), deletes its memberships and rules, then the folder. Notes are never touched.
 */
export function deleteFolder(s: StoreCtx, id: string): void {
  const res = inTransaction(s.db, () => {
    const folder = requireFolder(s, id)
    const lifted = (
      s.db.prepare(`UPDATE folders SET parent_id = ? WHERE parent_id = ? RETURNING id`).all(folder.parent_id, folder.id) as {
        id: string
      }[]
    ).map((r) => r.id)
    const memberships = s.db.prepare(`DELETE FROM folder_notes WHERE folder_id = ?`).run(folder.id).changes
    const rules = s.db.prepare(`DELETE FROM folder_rules WHERE folder_id = ?`).run(folder.id).changes
    s.db.prepare(`DELETE FROM folders WHERE id = ?`).run(folder.id)
    return { folder, lifted, memberships, rules }
  })
  s.touch('folders', res.folder.id, ...res.lifted)
  s.touch('folder_notes', res.folder.id)
  s.touch('folder_rules', res.folder.id)
  s.log('info', 'folder-deleted', {
    id: res.folder.id,
    liftedSubfolders: res.lifted.length,
    memberships: res.memberships,
    rules: res.rules
  })
}

// ---------- membership ----------

/** Adds notes to a folder and returns how many were newly added. Throws if a note isn’t the user’s own, is shared or is in Trash. */
export function addNotesToFolder(s: StoreCtx, folderId: string, noteIds: string[], source: FolderNoteSource): number {
  if (!SOURCES.includes(source)) throw invalid('unknown source')
  if (!Array.isArray(noteIds) || noteIds.some((n) => typeof n !== 'string' || !n)) throw invalid('noteIds must be ids')
  const ids = [...new Set(noteIds)]
  if (ids.length > MAX_NOTES_PER_ADD) throw invalid(`at most ${MAX_NOTES_PER_ADD} notes at once`)
  const added = inTransaction(s.db, () => {
    const folder = requireFolder(s, folderId)
    const check = s.db.prepare(`SELECT owner_id, workspace_id, is_shared, deleted_at FROM documents WHERE id = ?`)
    for (const noteId of ids) {
      const n = check.get(noteId) as Row | undefined
      if (!n) throw notFound('note', noteId)
      if (n['owner_id'] !== s.identity.ownerId || n['workspace_id'] !== s.identity.workspaceId || n['is_shared'] === 1) {
        throw invalid('Only notes you own can go in folders')
      }
      if (n['deleted_at'] !== null) throw invalid('A note in Trash cannot be added to a folder')
    }
    const now = nowIso()
    const insert = s.db.prepare(
      `INSERT OR IGNORE INTO folder_notes (folder_id, note_id, created_at, source) VALUES (?, ?, ?, ?)`
    )
    let n = 0
    for (const noteId of ids) n += insert.run(folder.id, noteId, now, source).changes
    if (n > 0) s.db.prepare(`UPDATE folders SET updated_at = ? WHERE id = ?`).run(now, folder.id)
    return n
  })
  if (added > 0) {
    s.touch('folder_notes', folderId)
    s.touch('folders', folderId)
  }
  return added
}

/** Moves the folder's `updated_at`. No suggestion history. */
export function removeNoteFromFolder(s: StoreCtx, folderId: string, noteId: string): void {
  if (typeof noteId !== 'string' || !noteId) throw invalid('noteId must be an id')
  const removed = inTransaction(s.db, () => {
    const folder = requireFolder(s, folderId)
    const n = s.db.prepare(`DELETE FROM folder_notes WHERE folder_id = ? AND note_id = ?`).run(folder.id, noteId).changes
    if (n > 0) s.db.prepare(`UPDATE folders SET updated_at = ? WHERE id = ?`).run(nowIso(), folder.id)
    return n
  })
  if (removed > 0) {
    s.touch('folder_notes', folderId)
    s.touch('folders', folderId)
  }
}

// ---------- auto-add rules ----------

/** Replaces any rule for the same series in that folder. */
export function setFolderRule(s: StoreCtx, r: FolderRuleInput): FolderRule {
  if (typeof r !== 'object' || r === null) throw invalid('rule must be an object')
  const series = r.recurringEventId
  if (typeof series !== 'string' || !series || series.length > MAX_TEXT_ID) throw invalid('recurringEventId is missing or too long')
  const t = target(r.target)
  const id = randomUUID()
  const createdAt = nowIso()
  const folderId = inTransaction(s.db, () => {
    const folder = requireFolder(s, r.folderId)
    s.db.prepare(`DELETE FROM folder_rules WHERE folder_id = ? AND recurring_event_id = ?`).run(folder.id, series)
    s.db
      .prepare(
        `INSERT INTO folder_rules (id, workspace_id, owner_id, folder_id, recurring_event_id, target, created_at)
         VALUES (@id, @workspace, @owner, @folder, @series, @target, @createdAt)`
      )
      .run({ id, ...scope(s), folder: folder.id, series, target: JSON.stringify(t), createdAt })
    return folder.id
  })
  s.touch('folder_rules', folderId)
  return { id, folder_id: folderId, recurring_event_id: series, target: t, created_at: createdAt }
}

/** Idempotent: an unknown id is a no-op. */
export function deleteFolderRule(s: StoreCtx, id: string): void {
  if (typeof id !== 'string' || !id) throw invalid('rule id is required')
  const row = inTransaction(
    s.db,
    () =>
      s.db
        .prepare(`DELETE FROM folder_rules WHERE id = @id AND owner_id = @owner AND workspace_id = @workspace RETURNING folder_id`)
        .get({ id, ...scope(s) }) as { folder_id: string } | undefined
  )
  if (row) s.touch('folder_rules', row.folder_id)
}
