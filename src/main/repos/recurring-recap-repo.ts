// SPDX-License-Identifier: Apache-2.0
// Recurring recap: the storage-worker side of its StorageApi group. Worker-safe: no Electron imports.
//
// - The previous instance: up to `candidates` live notes of the same series (`recurringEventId`),
//   another event, earlier display time, newest first. The first with content wins: its newest
//   summary panel's Markdown (not the suggested-actions template), else the note's own Markdown.
// - The cache keeps the newest 2 content versions per note; rows cascade with the note.

import { randomUUID } from 'node:crypto'
import type { IsoTime } from '@shared/types/common'
import { RECAP_LIMITS } from '@shared/types/notify'
import type { RecurringRecapRow } from '../storage/api'
import { nowIso, parseJson } from '../storage/rows'
import { inTransaction, invalid, type StoreCtx } from '../storage/store'

type Row = Record<string, unknown>

const SUGGESTED_ACTIONS = 'recap-next-steps'

const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

export function previousSeriesNote(
  s: StoreCtx,
  q: { eventId: string; recurringEventId: string; before: IsoTime; candidates: number }
): { noteId: string; title: string | null; meetingAt: IsoTime; markdown: string; contentVersion: string } | null {
  if (typeof q?.recurringEventId !== 'string' || !q.recurringEventId) return null
  const beforeMs = typeof q.before === 'string' ? Date.parse(q.before) : NaN
  if (Number.isNaN(beforeMs)) throw invalid('before is not a valid time')
  const limit = Math.max(1, Math.min(RECAP_LIMITS.candidates, Math.floor(Number(q.candidates) || RECAP_LIMITS.candidates)))
  const notes = s.db
    .prepare(
      `SELECT id, title, updated_at, notes_md, sort_epoch AS t FROM documents
       WHERE owner_id = @owner AND workspace_id = @workspace AND deleted_at IS NULL
         AND json_valid(linked_event)
         AND json_extract(linked_event, '$.recurringEventId') = @series
         AND (event_id IS NULL OR event_id = '' OR event_id <> @eventId)
         AND sort_epoch < @before
       ORDER BY sort_epoch DESC, id
       LIMIT ${limit}`
    )
    .all({
      owner: s.identity.ownerId,
      workspace: s.identity.workspaceId,
      series: q.recurringEventId,
      eventId: typeof q.eventId === 'string' ? q.eventId : '',
      before: Math.floor(beforeMs / 1000)
    }) as Row[]
  const panelsOf = s.db.prepare(
    `SELECT content_markdown, updated_at, content_edited_at, last_opened_at, created_at FROM note_panels
     WHERE document_id = ? AND deleted_at IS NULL AND (template_key IS NULL OR template_key = '' OR template_key <> ?)
     ORDER BY coalesce(last_opened_at, created_at) DESC, rid DESC`
  )
  for (const n of notes) {
    const t = Number(n['t'])
    const meetingAt = Number.isFinite(t) ? new Date(t * 1000).toISOString() : null
    let markdown = ''
    let version: string | null = null
    const panel = (panelsOf.all(String(n['id']), SUGGESTED_ACTIONS) as Row[])[0]
    const panelMd = panel ? (str(panel['content_markdown']) ?? '').trim() : ''
    if (panelMd) {
      markdown = panelMd
      version = str(panel?.['updated_at']) ?? str(panel?.['content_edited_at']) ?? str(n['updated_at'])
    } else {
      markdown = (str(n['notes_md']) ?? '').trim()
      version = str(n['updated_at'])
    }
    if (!markdown) continue
    return {
      noteId: String(n['id']),
      title: str(n['title']),
      meetingAt: meetingAt ?? '',
      markdown,
      contentVersion: version ?? `${meetingAt ?? 'unknown'}:${markdown.length}`
    }
  }
  return null
}

export function getRecurringRecap(s: StoreCtx, documentId: string, contentVersion: string): RecurringRecapRow | null {
  if (typeof documentId !== 'string' || typeof contentVersion !== 'string') return null
  const r = s.db
    .prepare(`SELECT document_id, content_version, title, bullets, created_at FROM recurring_recaps WHERE document_id = ? AND content_version = ? AND owner_id = ?`)
    .get(documentId, contentVersion, s.identity.ownerId) as Row | undefined
  if (!r) return null
  const bullets = parseJson<unknown>(r['bullets'], [])
  return {
    document_id: String(r['document_id']),
    content_version: String(r['content_version']),
    title: String(r['title']),
    bullets: Array.isArray(bullets) ? bullets.filter((b): b is string => typeof b === 'string') : [],
    created_at: String(r['created_at'])
  }
}

/** Upserts one version, then keeps the newest RECAP_LIMITS.keepVersions per note. */
export function putRecurringRecap(s: StoreCtx, r: RecurringRecapRow): void {
  if (typeof r?.document_id !== 'string' || !r.document_id || typeof r.content_version !== 'string' || !r.content_version) {
    throw invalid('document_id and content_version are required')
  }
  if (typeof r.title !== 'string' || !Array.isArray(r.bullets)) throw invalid('title and bullets are required')
  const bullets = r.bullets.filter((b) => typeof b === 'string')
  inTransaction(s.db, () => {
    s.db
      .prepare(
        `INSERT INTO recurring_recaps (id, workspace_id, owner_id, document_id, content_version, title, bullets, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (document_id, content_version) DO UPDATE SET title = excluded.title, bullets = excluded.bullets,
           created_at = excluded.created_at`
      )
      .run(randomUUID(), s.identity.workspaceId, s.identity.ownerId, r.document_id, r.content_version, r.title, JSON.stringify(bullets), str(r.created_at) ?? nowIso())
    s.db
      .prepare(
        `DELETE FROM recurring_recaps WHERE document_id = @doc AND owner_id = @owner AND rid NOT IN (
           SELECT rid FROM recurring_recaps WHERE document_id = @doc AND owner_id = @owner
           ORDER BY created_at DESC, rid DESC LIMIT ${RECAP_LIMITS.keepVersions})`
      )
      .run({ doc: r.document_id, owner: s.identity.ownerId })
  })
  s.touch('recurring_recaps', r.document_id)
}
