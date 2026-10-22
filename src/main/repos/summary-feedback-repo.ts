// SPDX-License-Identifier: Apache-2.0
// Summary feedback: the storage-worker side of its StorageApi group. Worker-safe: no Electron imports.
//
// One `summary_feedback` row per panel, upserted: the rating, then the comment, are two writes
// on the same row; a dismissal stamps `dismissed_at`. Rows cascade with the note.

import { randomUUID } from 'node:crypto'
import { DEMO_MEETING_PREFIX } from '@shared/types/notes'
import type { SummaryFeedback, SummaryFeedbackDirection, SummaryFeedbackList } from '@shared/types/summary-feedback'
import type { SummaryFeedbackUpsert } from '../storage/api'
import { nowIso } from '../storage/rows'
import { inTransaction, notFound, type StoreCtx } from '../storage/store'

type Row = Record<string, unknown>

const LIST_MAX = 200

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function toFeedback(r: Row): SummaryFeedback {
  const d = r['direction']
  return {
    id: String(r['id']),
    panel_id: String(r['panel_id']),
    document_id: String(r['document_id']),
    template_key: String(r['template_key'] ?? ''),
    direction: d === 'positive' || d === 'negative' ? (d as SummaryFeedbackDirection) : null,
    comment: str(r['comment']),
    dismissed_at: str(r['dismissed_at']),
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at'])
  }
}

const isDemoId = (id: string): boolean => id.startsWith(DEMO_MEETING_PREFIX)

export function summaryFeedbackFacts(
  s: StoreCtx,
  panelId: string
): { ownNotes: number; isLatestWithContent: boolean; isDemo: boolean; dismissed: boolean; templateSlug: string; documentId: string } | null {
  const owner = s.identity.ownerId
  const panel = s.db
    .prepare(
      `SELECT p.id, p.document_id, p.template_key, d.event_id FROM note_panels p JOIN documents d ON d.id = p.document_id
       WHERE p.id = ? AND p.deleted_at IS NULL AND d.deleted_at IS NULL AND d.owner_id = ?`
    )
    .get(panelId, owner) as Row | undefined
  if (!panel) return null
  const documentId = String(panel['document_id'])
  const latest = s.db
    .prepare(
      `SELECT id FROM note_panels WHERE document_id = ? AND deleted_at IS NULL
       AND trim(coalesce(content_markdown, generated_content, '')) <> ''
       ORDER BY created_at DESC, rid DESC LIMIT 1`
    )
    .get(documentId) as Row | undefined
  const ownNotes = (
    s.db
      .prepare(
        `SELECT count(*) AS n FROM documents WHERE owner_id = ? AND deleted_at IS NULL AND is_shared = 0 AND is_scratchpad = 0
         AND id NOT LIKE '${DEMO_MEETING_PREFIX}%'`
      )
      .get(owner) as { n: number }
  ).n
  const fb = s.db.prepare(`SELECT dismissed_at FROM summary_feedback WHERE panel_id = ?`).get(panelId) as Row | undefined
  return {
    ownNotes,
    isLatestWithContent: latest?.['id'] === panelId,
    isDemo: isDemoId(documentId) || isDemoId(String(panel['event_id'] ?? '')),
    dismissed: !!str(fb?.['dismissed_at']),
    templateSlug: String(panel['template_key'] ?? ''),
    documentId
  }
}

export function upsertSummaryFeedback(s: StoreCtx, f: SummaryFeedbackUpsert): SummaryFeedback {
  const now = nowIso()
  const row = inTransaction(s.db, () => {
    const doc = s.db.prepare(`SELECT id FROM documents WHERE id = ?`).get(f.document_id)
    if (!doc) throw notFound('Note', f.document_id)
    const cur = s.db.prepare(`SELECT * FROM summary_feedback WHERE panel_id = ?`).get(f.panel_id) as Row | undefined
    if (!cur) {
      const id = randomUUID()
      s.db
        .prepare(
          `INSERT INTO summary_feedback (id, workspace_id, owner_id, panel_id, document_id, template_key, direction, comment, dismissed_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, s.identity.workspaceId, s.identity.ownerId, f.panel_id, f.document_id, f.template_key, f.direction ?? null, f.comment ?? null, f.dismissed_at ?? null, now, now)
    } else {
      s.db
        .prepare(`UPDATE summary_feedback SET template_key = ?, direction = ?, comment = ?, dismissed_at = ?, updated_at = ? WHERE panel_id = ?`)
        .run(
          f.template_key,
          f.direction !== undefined ? f.direction : (cur['direction'] ?? null),
          f.comment !== undefined ? f.comment : (cur['comment'] ?? null),
          f.dismissed_at !== undefined ? f.dismissed_at : (cur['dismissed_at'] ?? null),
          now,
          f.panel_id
        )
    }
    return s.db.prepare(`SELECT * FROM summary_feedback WHERE panel_id = ?`).get(f.panel_id) as Row
  })
  s.touch('summary_feedback', String(row['id']))
  return toFeedback(row)
}

export function listSummaryFeedback(s: StoreCtx, templateSlug: string): SummaryFeedbackList {
  const rows = s.db
    .prepare(
      `SELECT f.*, d.title AS note_title FROM summary_feedback f JOIN documents d ON d.id = f.document_id
       WHERE f.owner_id = ? AND f.template_key = ? AND f.direction IS NOT NULL AND d.deleted_at IS NULL
       ORDER BY f.updated_at DESC, f.rid DESC LIMIT ${LIST_MAX}`
    )
    .all(s.identity.ownerId, templateSlug) as Row[]
  const counts = { positive: 0, negative: 0 }
  const items = rows.map((r) => {
    const f = toFeedback(r)
    if (f.direction) counts[f.direction]++
    return { ...f, note_title: str(r['note_title']) }
  })
  return { counts, items }
}
