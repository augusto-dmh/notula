// SPDX-License-Identifier: Apache-2.0
// The `note_panels` table (AI-enhanced notes). Generation fields are written
// by main only (enhance); the renderer's narrower PanelPatch is whitelisted in IPC.

import { randomUUID } from 'node:crypto'
import type { Panel } from '@shared/types/panels'
import type { NewPanel } from './api'
import { encodePanelValue, nowIso, PANEL_WRITABLE, toPanel } from './rows'
import { inTransaction, notFound, type StoreCtx } from './store'

const COLS = ['id', 'document_id', 'workspace_id', 'owner_id', 'created_at', 'updated_at', ...PANEL_WRITABLE].join(
  ', '
)

export function getPanel(s: StoreCtx, id: string): Panel | null {
  const row = s.db.prepare(`SELECT ${COLS} FROM note_panels WHERE id = ?`).get(id) as
    | Record<string, unknown>
    | undefined
  return row ? toPanel(row) : null
}

export function listPanels(s: StoreCtx, noteId: string, opts?: { includeDeleted?: boolean }): Panel[] {
  const rows = s.db
    .prepare(
      `SELECT ${COLS} FROM note_panels WHERE document_id = ? AND (deleted_at IS NULL OR ?)
       ORDER BY created_at ASC, id ASC`
    )
    .all(noteId, opts?.includeDeleted ? 1 : 0) as Record<string, unknown>[]
  return rows.map(toPanel)
}

export function createPanel(s: StoreCtx, p: NewPanel): Panel {
  const exists = s.db.prepare(`SELECT 1 FROM documents WHERE id = ?`).get(p.document_id)
  if (!exists) throw notFound('note', p.document_id)
  const id = p.id ?? randomUUID()
  const now = nowIso()
  const params: Record<string, unknown> = {
    id,
    document_id: p.document_id,
    workspace_id: s.identity.workspaceId,
    owner_id: s.identity.ownerId,
    created_at: now,
    updated_at: now
  }
  for (const c of PANEL_WRITABLE) params[c] = encodePanelValue(c, p[c])
  if (params['crdt_version'] === null) params['crdt_version'] = 1
  const names = Object.keys(params)
  inTransaction(s.db, () =>
    s.db
      .prepare(`INSERT INTO note_panels (${names.join(', ')}) VALUES (${names.map((n) => `@${n}`).join(', ')})`)
      .run(params)
  )
  s.touch('note_panels', id, p.document_id)
  return getPanel(s, id) as Panel
}

/** The full internal patch; identity and creation columns are never changed. */
export function updatePanel(s: StoreCtx, id: string, patch: Partial<Panel>): Panel {
  const current = getPanel(s, id)
  if (!current) throw notFound('panel', id)
  const sets: string[] = []
  const params: Record<string, unknown> = { id, now: nowIso() }
  for (const c of PANEL_WRITABLE) {
    if (!Object.hasOwn(patch, c) || patch[c] === undefined) continue
    sets.push(`${c} = @${c}`)
    params[c] = encodePanelValue(c, patch[c])
  }
  if (sets.length === 0) return current
  inTransaction(s.db, () =>
    s.db.prepare(`UPDATE note_panels SET ${sets.join(', ')}, updated_at = @now WHERE id = @id`).run(params)
  )
  s.touch('note_panels', id, current.document_id)
  return getPanel(s, id) as Panel
}

/**
 * Panels whose generation started and neither failed nor produced content since
 * (enhance marks the ones left over at startup as `interrupted`).
 */
export function listGeneratingPanels(s: StoreCtx): Panel[] {
  const rows = s.db
    .prepare(
      `SELECT ${COLS} FROM note_panels
       WHERE deleted_at IS NULL AND enhance_started_at IS NOT NULL
         AND (enhance_failed_at IS NULL OR enhance_failed_at < enhance_started_at)
         AND (content_edited_at IS NULL OR content_edited_at < enhance_started_at)
       ORDER BY enhance_started_at ASC`
    )
    .all() as Record<string, unknown>[]
  return rows.map(toPanel)
}
