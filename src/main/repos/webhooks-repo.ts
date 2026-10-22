// SPDX-License-Identifier: Apache-2.0
// Webhooks: the storage-worker side of their StorageApi group. Worker-safe: no Electron imports.
//
// The URL and the signing secret live in `secrets`; this table holds only their ids and the
// scheme + host label. `last_delivery` is read from the endpoint's latest outbox row (provider
// `webhook`, `destination_id` = the endpoint id). Auto-disable: 20 consecutive failures,
// or failures for 72 h.

import type { WebhookEndpointRow } from '../storage/api'
import { nowIso, parseJson } from '../storage/rows'
import { inTransaction, invalid, notFound, type StoreCtx } from '../storage/store'
import type { IsoTime } from '@shared/types/common'
import type { IntegrationDeliveryStatus } from '@shared/types/integrations'
import { WEBHOOK_LIMITS, type WebhookEndpoint, type WebhookEvent } from '@shared/types/webhooks'

type Row = Record<string, unknown>

const EVENTS: readonly WebhookEvent[] = ['note.summarized', 'note.updated', 'note.access_added']
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

function lastDelivery(s: StoreCtx, id: string): WebhookEndpoint['last_delivery'] {
  const r = s.db
    .prepare(
      `SELECT status, updated_at, sent_at, error_code FROM integration_deliveries
       WHERE owner_id = ? AND provider = 'webhook' AND destination_id = ? ORDER BY created_at DESC, rid DESC LIMIT 1`
    )
    .get(s.identity.ownerId, id) as Row | undefined
  if (!r) return null
  const m = /^http_(\d{3})$/.exec(String(r['error_code'] ?? ''))
  return {
    status: String(r['status']) as IntegrationDeliveryStatus,
    at: String(r['sent_at'] ?? r['updated_at']),
    httpStatus: r['status'] === 'sent' ? 200 : m ? Number(m[1]) : null
  }
}

function toEndpoint(s: StoreCtx, r: Row): WebhookEndpoint & { url_secret_id: string; signing_secret_id: string } {
  const id = String(r['id'])
  return {
    id,
    url_label: String(r['url_label']),
    scope: r['scope'] === 'one_folder' ? 'one_folder' : 'my_notes_only',
    folder_id: str(r['folder_id']),
    events: parseJson<WebhookEvent[]>(r['events'], []).filter((e) => EVENTS.includes(e)),
    enabled: r['enabled'] === 1,
    disabled_reason: (str(r['disabled_reason']) as WebhookEndpoint['disabled_reason']) ?? null,
    include_transcript: r['include_transcript'] === 1,
    last_delivery: lastDelivery(s, id),
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at']),
    url_secret_id: String(r['url_secret_id']),
    signing_secret_id: String(r['signing_secret_id'])
  }
}

function getRow(s: StoreCtx, id: string): Row | undefined {
  return s.db.prepare('SELECT * FROM webhook_endpoints WHERE id = ? AND owner_id = ? AND workspace_id = ?').get(id, s.identity.ownerId, s.identity.workspaceId) as Row | undefined
}

export function listWebhookEndpoints(s: StoreCtx): (WebhookEndpoint & { url_secret_id: string; signing_secret_id: string })[] {
  const rows = s.db
    .prepare('SELECT * FROM webhook_endpoints WHERE owner_id = ? AND workspace_id = ? ORDER BY created_at, rid')
    .all(s.identity.ownerId, s.identity.workspaceId) as Row[]
  return rows.map((r) => toEndpoint(s, r))
}

export function upsertWebhookEndpoint(s: StoreCtx, e: WebhookEndpointRow): WebhookEndpoint {
  if (!e || typeof e.id !== 'string' || !e.id || !e.url_secret_id || !e.signing_secret_id || !e.url_label) throw invalid('Invalid endpoint')
  if (e.scope !== 'my_notes_only' && e.scope !== 'one_folder') throw invalid('Invalid scope')
  const now = nowIso()
  const out = inTransaction(s.db, () => {
    const prev = getRow(s, e.id)
    if (!prev) {
      const n = (s.db.prepare('SELECT COUNT(*) AS n FROM webhook_endpoints WHERE owner_id = ?').get(s.identity.ownerId) as Row)['n']
      if (Number(n) >= WEBHOOK_LIMITS.maxEndpoints) throw invalid(`You can have up to ${WEBHOOK_LIMITS.maxEndpoints} webhooks.`)
    }
    const params = {
      id: e.id,
      workspace: s.identity.workspaceId,
      owner: s.identity.ownerId,
      urlSecret: e.url_secret_id,
      label: e.url_label.slice(0, 300),
      signing: e.signing_secret_id,
      scope: e.scope,
      folder: e.scope === 'one_folder' ? e.folder_id : null,
      events: JSON.stringify(e.events.filter((x) => EVENTS.includes(x))),
      enabled: e.enabled ? 1 : 0,
      reason: e.enabled ? null : (e.disabled_reason ?? 'user'),
      transcript: e.include_transcript ? 1 : 0,
      now
    }
    if (prev) {
      // Turning an endpoint back on clears the failure streak.
      const reset = e.enabled && prev['enabled'] !== 1
      s.db
        .prepare(
          `UPDATE webhook_endpoints SET url_secret_id = @urlSecret, url_label = @label, signing_secret_id = @signing, scope = @scope,
           folder_id = @folder, events = @events, enabled = @enabled, disabled_reason = @reason, include_transcript = @transcript,
           ${reset ? 'consecutive_failures = 0, first_failure_at = NULL,' : ''} updated_at = @now WHERE id = @id`
        )
        .run(params)
    } else {
      s.db
        .prepare(
          `INSERT INTO webhook_endpoints (id, workspace_id, owner_id, url_secret_id, url_label, signing_secret_id, scope, folder_id, events,
           enabled, disabled_reason, include_transcript, consecutive_failures, first_failure_at, created_at, updated_at)
           VALUES (@id, @workspace, @owner, @urlSecret, @label, @signing, @scope, @folder, @events, @enabled, @reason, @transcript, 0, NULL, @now, @now)`
        )
        .run(params)
    }
    return toEndpoint(s, getRow(s, e.id) as Row)
  })
  s.touch('webhook_endpoints', out.id)
  const { url_secret_id: _u, signing_secret_id: _s, ...pub } = out
  return pub
}

export function deleteWebhookEndpoint(s: StoreCtx, id: string): void {
  if (typeof id !== 'string' || !id) throw invalid('id is required')
  const n = s.db.prepare('DELETE FROM webhook_endpoints WHERE id = ? AND owner_id = ? AND workspace_id = ?').run(id, s.identity.ownerId, s.identity.workspaceId).changes
  if (n) s.touch('webhook_endpoints', id)
}

export function recordWebhookResult(s: StoreCtx, id: string, ok: boolean, at: IsoTime): { autoDisabled: boolean } {
  const res = inTransaction(s.db, () => {
    const r = getRow(s, id)
    if (!r) throw notFound('webhook endpoint', id)
    if (ok) {
      s.db.prepare('UPDATE webhook_endpoints SET consecutive_failures = 0, first_failure_at = NULL WHERE id = ?').run(id)
      return { autoDisabled: false }
    }
    const failures = Number(r['consecutive_failures'] ?? 0) + 1
    const first = str(r['first_failure_at']) ?? at
    const off =
      r['enabled'] === 1 && (failures >= WEBHOOK_LIMITS.autoDisableFailures || Date.parse(at) - Date.parse(first) >= WEBHOOK_LIMITS.autoDisableMs)
    s.db
      .prepare(
        `UPDATE webhook_endpoints SET consecutive_failures = ?, first_failure_at = ?
         ${off ? ", enabled = 0, disabled_reason = 'failures', updated_at = ?" : ''} WHERE id = ?`
      )
      .run(...(off ? [failures, first, nowIso(), id] : [failures, first, id]))
    return { autoDisabled: off }
  })
  s.touch('webhook_endpoints', id)
  return res
}
