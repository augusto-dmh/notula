// SPDX-License-Identifier: Apache-2.0
// The `note_templates` table. Rows only:
// built-ins are shared constants that main merges into list results, so `is_builtin`
// is never stored and every row reads back with it false.

import { randomUUID } from 'node:crypto'
import type { IsoTime } from '@shared/types/common'
import type { NoteTemplate, NoteTemplateCreate, NoteTemplatePatch, TemplateIcon, TemplateSection } from '@shared/types/templates'
import { nowIso, parseJson } from './rows'
import { inTransaction, invalid, notFound, type StoreCtx } from './store'

const COLS = [
  'id',
  'workspace_id',
  'owner_id',
  'created_at',
  'updated_at',
  'deleted_at',
  'title',
  'description',
  'sections',
  'category',
  'icon',
  'copied_from'
].join(', ')

type Row = Record<string, unknown>

const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)

function toTemplate(r: Row): NoteTemplate {
  return {
    id: String(r['id']),
    workspace_id: strOrNull(r['workspace_id']),
    owner_id: strOrNull(r['owner_id']),
    title: typeof r['title'] === 'string' ? r['title'] : '',
    description: typeof r['description'] === 'string' ? r['description'] : '',
    sections: parseJson<TemplateSection[]>(r['sections'], []),
    category: strOrNull(r['category']),
    icon: parseJson<TemplateIcon | null>(r['icon'], null),
    is_builtin: false,
    shared_with: null,
    copied_from: strOrNull(r['copied_from']),
    created_at: String(r['created_at']),
    updated_at: strOrNull(r['updated_at']),
    deleted_at: strOrNull(r['deleted_at'])
  }
}

/** The owner's templates that are not deleted, by title. */
export function listTemplates(s: StoreCtx): NoteTemplate[] {
  const rows = s.db
    .prepare(`SELECT ${COLS} FROM note_templates WHERE owner_id = ? AND deleted_at IS NULL ORDER BY title COLLATE NOCASE, created_at`)
    .all(s.identity.ownerId) as Row[]
  return rows.map(toTemplate)
}

/** A row by id, deleted ones included (a panel may still name it). */
export function getTemplate(s: StoreCtx, id: string): NoteTemplate | null {
  const row = s.db.prepare(`SELECT ${COLS} FROM note_templates WHERE id = ?`).get(id) as Row | undefined
  return row ? toTemplate(row) : null
}

/** A fresh template: no `updated_at` yet, never shared. */
export function createTemplate(s: StoreCtx, t: NoteTemplateCreate): NoteTemplate {
  const id = t.id ?? randomUUID()
  if (s.db.prepare(`SELECT 1 FROM note_templates WHERE id = ?`).get(id)) throw invalid(`template ${id} already exists`)
  const params = {
    id,
    workspace_id: s.identity.workspaceId,
    owner_id: s.identity.ownerId,
    created_at: nowIso(),
    title: t.title,
    description: t.description,
    sections: JSON.stringify(t.sections),
    category: t.category,
    icon: t.icon === null ? null : JSON.stringify(t.icon),
    copied_from: t.copied_from
  }
  inTransaction(s.db, () =>
    s.db
      .prepare(
        `INSERT INTO note_templates (id, workspace_id, owner_id, created_at, updated_at, deleted_at, title, description,
           sections, category, icon, shared_with, copied_from)
         VALUES (@id, @workspace_id, @owner_id, @created_at, NULL, NULL, @title, @description, @sections, @category,
           @icon, NULL, @copied_from)`
      )
      .run(params)
  )
  s.touch('note_templates', id)
  return getTemplate(s, id) as NoteTemplate
}

/** Every write stamps `updated_at`; `deleted_at` soft-deletes (and null restores). */
export function updateTemplate(
  s: StoreCtx,
  id: string,
  patch: NoteTemplatePatch & { deleted_at?: IsoTime | null }
): NoteTemplate {
  const current = getTemplate(s, id)
  if (!current || current.owner_id !== s.identity.ownerId) throw notFound('template', id)
  const sets: string[] = []
  const params: Record<string, unknown> = { id, now: nowIso() }
  const put = (column: string, value: unknown): void => {
    sets.push(`${column} = @${column}`)
    params[column] = value
  }
  if (patch.title !== undefined) put('title', patch.title)
  if (patch.description !== undefined) put('description', patch.description)
  if (patch.sections !== undefined) put('sections', JSON.stringify(patch.sections))
  if (patch.icon !== undefined) put('icon', patch.icon === null ? null : JSON.stringify(patch.icon))
  if (patch.deleted_at !== undefined) put('deleted_at', patch.deleted_at)
  if (sets.length === 0) return current
  inTransaction(s.db, () =>
    s.db.prepare(`UPDATE note_templates SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params)
  )
  s.touch('note_templates', id)
  return getTemplate(s, id) as NoteTemplate
}
