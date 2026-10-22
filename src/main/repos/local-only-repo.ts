// SPDX-License-Identifier: Apache-2.0
// Local-only held sends: the storage-worker side of their StorageApi group. Worker-safe: no
// Electron imports.
//
// A held send is an `integration_deliveries` row whose `held_at` is set. The outbox's due query skips held
// rows, so nothing held goes out until the user releases it.

import type { IsoTime } from '@shared/types/common'
import type { IntegrationDelivery, IntegrationDeliveryStatus, IntegrationProvider } from '@shared/types/integrations'
import { nowIso } from '../storage/rows'
import { inTransaction, invalid, notFound, type StoreCtx } from '../storage/store'

type Row = Record<string, unknown>

/** The statuses that would still go out on their own. */
const OPEN_STATUSES = `('scheduled', 'pending', 'failed')`
const STATUSES: readonly IntegrationDeliveryStatus[] = ['scheduled', 'pending', 'sending', 'sent', 'failed', 'uncertain', 'cancelled']
const ISO = /^\d{4}-\d{2}-\d{2}T/

// Same projection as the integration outbox (integrations-repo.ts), read-only here.
const COLS = `d.id, d.provider, d.destination_id, d.automation_id, d.note_id, d.panel_id, d.target_key, d."trigger", d.status,
  d.attempts, d.next_attempt_at, d.external_id, d.external_url, d.error_code, d.error_message, d.sent_at, d.created_at, d.updated_at,
  doc.title AS note_title, doc.deleted_at AS note_deleted_at`
const FROM = `integration_deliveries d LEFT JOIN documents doc ON doc.id = d.note_id`

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

function toDelivery(r: Row): IntegrationDelivery {
  const trigger = r['trigger']
  const deleted = r['note_deleted_at'] !== null && r['note_deleted_at'] !== undefined
  return {
    id: String(r['id']),
    provider: r['provider'] as IntegrationProvider,
    destinationId: str(r['destination_id']),
    automationId: str(r['automation_id']),
    noteId: String(r['note_id']),
    noteTitle: deleted ? null : str(r['note_title']),
    panelId: str(r['panel_id']),
    targetKey: String(r['target_key'] ?? ''),
    trigger: trigger === 'folder' || trigger === 'test' ? trigger : 'manual',
    status: STATUSES.includes(r['status'] as IntegrationDeliveryStatus) ? (r['status'] as IntegrationDeliveryStatus) : 'failed',
    attempts: Number(r['attempts'] ?? 0),
    nextAttemptAt: str(r['next_attempt_at']),
    externalId: str(r['external_id']),
    externalUrl: str(r['external_url']),
    errorCode: str(r['error_code']),
    errorMessage: deleted ? null : str(r['error_message']),
    sentAt: str(r['sent_at']),
    createdAt: String(r['created_at']),
    updatedAt: String(r['updated_at'])
  }
}

/** Marks every open delivery that is due by `now` as held. Returns how many were held. */
export function holdDueIntegrationDeliveries(s: StoreCtx, now: IsoTime): number {
  const at = typeof now === 'string' && ISO.test(now) ? now : nowIso()
  const r = s.db
    .prepare(
      `UPDATE integration_deliveries SET held_at = ?, updated_at = ?
       WHERE held_at IS NULL AND status IN ${OPEN_STATUSES} AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?`
    )
    .run(at, nowIso(), at)
  if (r.changes) s.touch('integration_deliveries')
  return r.changes
}

export function listHeldIntegrationDeliveries(s: StoreCtx): IntegrationDelivery[] {
  const rows = s.db
    .prepare(`SELECT ${COLS} FROM ${FROM} WHERE d.held_at IS NOT NULL AND d.status IN ${OPEN_STATUSES} ORDER BY d.held_at, d.rid LIMIT 500`)
    .all() as Row[]
  return rows.map(toDelivery)
}

/** Send: clears `held_at` and makes the row due now. Discard: cancels it. */
export function releaseHeldIntegrationDelivery(s: StoreCtx, id: string, action: 'send' | 'discard'): IntegrationDelivery {
  if (typeof id !== 'string' || !id) throw invalid('id is required')
  if (action !== 'send' && action !== 'discard') throw invalid('action must be send or discard')
  return inTransaction(s.db, () => {
    const held = s.db
      .prepare(`SELECT 1 FROM integration_deliveries WHERE id = ? AND held_at IS NOT NULL AND status IN ${OPEN_STATUSES}`)
      .get(id)
    if (!held) throw notFound('held delivery', id)
    const now = nowIso()
    if (action === 'send') {
      s.db.prepare(`UPDATE integration_deliveries SET held_at = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ?`).run(now, now, id)
    } else {
      s.db.prepare(`UPDATE integration_deliveries SET held_at = NULL, status = 'cancelled', next_attempt_at = NULL, updated_at = ? WHERE id = ?`).run(now, id)
    }
    s.touch('integration_deliveries', id)
    const r = s.db.prepare(`SELECT ${COLS} FROM ${FROM} WHERE d.id = ?`).get(id) as Row | undefined
    if (!r) throw notFound('delivery', id)
    return toDelivery(r)
  })
}
