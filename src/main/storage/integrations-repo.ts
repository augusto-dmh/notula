// SPDX-License-Identifier: Apache-2.0
// The integration outbox:
// `integration_destinations`, `integration_automations`, `integration_automation_runs`
// (the once-only guard) and `integration_deliveries`. Secrets are referenced by id only:
// no column ever holds a credential, a webhook URL or note content.

import { randomUUID } from 'node:crypto'
import type { IsoTime } from '@shared/types/common'
import type {
  AttioObjectType,
  IntegrationAutomation,
  IntegrationAutomationInput,
  IntegrationDelivery,
  IntegrationDeliveryStatus,
  IntegrationDestinationOptions,
  IntegrationProvider
} from '@shared/types/integrations'
import type { IntegrationDeliveryPatch, IntegrationDestinationRow, NewIntegrationDelivery } from './api'
import { nowIso, parseJson } from './rows'
import { inTransaction, invalid, notFound, type StoreCtx } from './store'

type Row = Record<string, unknown>

// Plug-in providers use the same outbox, so they must pass the provider check too.
const PROVIDERS: readonly IntegrationProvider[] = [
  'slack',
  'notion',
  'hubspot',
  'attio',
  'affinity',
  'zapier',
  'salesforce',
  'pipedrive',
  'ashby',
  'dropbox',
  'webhook',
  'gmail',
  'outlook'
]
const DEST_KINDS = ['slack-channel', 'slack-webhook', 'notion-target', 'zapier-hook'] as const
const STATUSES: readonly IntegrationDeliveryStatus[] = ['scheduled', 'pending', 'sending', 'sent', 'failed', 'uncertain', 'cancelled']
const OBJECT_TYPES: readonly AttioObjectType[] = ['companies', 'people', 'deals']
const ISO = /^\d{4}-\d{2}-\d{2}T/
const MAX_TEXT = 2_000

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

function provider(v: unknown): IntegrationProvider {
  if (typeof v !== 'string' || !(PROVIDERS as readonly string[]).includes(v)) throw invalid('unknown integration provider')
  return v as IntegrationProvider
}

function clip(v: string | null | undefined, max = MAX_TEXT): string | null {
  if (typeof v !== 'string') return null
  return v.length > max ? v.slice(0, max) : v
}

function isoOrNull(v: unknown, what: string): string | null {
  if (v === null || v === undefined) return null
  if (typeof v !== 'string' || !ISO.test(v)) throw invalid(`${what} must be an ISO time`)
  return v
}

// ---------- destinations ----------

const DEST_COLS = `id, provider, kind, label, external_id, secret_id, "trigger", options, status, last_error, created_at, updated_at`

function toDestination(r: Row): IntegrationDestinationRow {
  const trigger = r['trigger']
  const status = r['status']
  return {
    id: String(r['id']),
    provider: r['provider'] as IntegrationProvider,
    kind: r['kind'] as IntegrationDestinationRow['kind'],
    label: String(r['label'] ?? ''),
    externalId: str(r['external_id']),
    trigger: trigger === 'share' || trigger === 'folder' ? trigger : null,
    status: status === 'disconnected' || status === 'disabled' ? status : 'ok',
    lastError: str(r['last_error']),
    options: parseJson<IntegrationDestinationOptions>(r['options'], {}),
    maskedSecret: null,
    secret_id: str(r['secret_id']),
    createdAt: String(r['created_at']),
    updatedAt: String(r['updated_at'])
  }
}

export function listIntegrationDestinations(s: StoreCtx, q?: { provider?: IntegrationProvider; ids?: string[] }): IntegrationDestinationRow[] {
  const where: string[] = []
  const vals: unknown[] = []
  if (q?.provider) {
    where.push('provider = ?')
    vals.push(provider(q.provider))
  }
  if (q?.ids) {
    if (!q.ids.length) return []
    where.push(`id IN (${q.ids.map(() => '?').join(', ')})`)
    vals.push(...q.ids.map(String))
  }
  const rows = s.db
    .prepare(`SELECT ${DEST_COLS} FROM integration_destinations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, rid`)
    .all(...vals) as Row[]
  return rows.map(toDestination)
}

export function upsertIntegrationDestination(s: StoreCtx, d: IntegrationDestinationRow): IntegrationDestinationRow {
  if (!d || typeof d.id !== 'string' || !d.id) throw invalid('destination id is required')
  const p = provider(d.provider)
  if (!(DEST_KINDS as readonly string[]).includes(d.kind)) throw invalid('unknown destination kind')
  const label = typeof d.label === 'string' ? d.label.trim().slice(0, 200) : ''
  if (!label) throw invalid('destination label is required')
  const trigger = d.trigger === 'share' || d.trigger === 'folder' ? d.trigger : null
  const status = d.status === 'disconnected' || d.status === 'disabled' ? d.status : 'ok'
  const now = nowIso()
  const options = JSON.stringify(d.options && typeof d.options === 'object' ? d.options : {})
  const existing = s.db.prepare(`SELECT created_at FROM integration_destinations WHERE id = ?`).get(d.id) as Row | undefined
  if (existing) {
    s.db
      .prepare(
        `UPDATE integration_destinations SET provider = ?, kind = ?, label = ?, external_id = ?, secret_id = ?, "trigger" = ?,
           options = ?, status = ?, last_error = ?, updated_at = ? WHERE id = ?`
      )
      .run(p, d.kind, label, d.externalId ?? null, d.secret_id ?? null, trigger, options, status, clip(d.lastError), now, d.id)
  } else {
    s.db
      .prepare(
        `INSERT INTO integration_destinations (id, workspace_id, owner_id, provider, kind, label, external_id, secret_id, "trigger",
           options, status, last_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(d.id, s.identity.workspaceId, s.identity.ownerId, p, d.kind, label, d.externalId ?? null, d.secret_id ?? null, trigger, options, status, clip(d.lastError), now, now)
  }
  s.touch('integration_destinations', d.id)
  return toDestination(s.db.prepare(`SELECT ${DEST_COLS} FROM integration_destinations WHERE id = ?`).get(d.id) as Row)
}

export function deleteIntegrationDestinations(s: StoreCtx, q: { provider: IntegrationProvider; id?: string }): { deleted: IntegrationDestinationRow[] } {
  const p = provider(q?.provider)
  return inTransaction(s.db, () => {
    const rows = (
      q.id
        ? s.db.prepare(`SELECT ${DEST_COLS} FROM integration_destinations WHERE provider = ? AND id = ?`).all(p, q.id)
        : s.db.prepare(`SELECT ${DEST_COLS} FROM integration_destinations WHERE provider = ?`).all(p)
    ) as Row[]
    const deleted = rows.map(toDestination)
    for (const d of deleted) {
      s.db.prepare(`DELETE FROM integration_destinations WHERE id = ?`).run(d.id)
      // A rule bound to a removed destination can never run again.
      s.db.prepare(`DELETE FROM integration_automations WHERE destination_id = ?`).run(d.id)
      s.touch('integration_destinations', d.id)
    }
    if (deleted.length) s.touch('integration_automations')
    return { deleted }
  })
}

// ---------- automations ----------

const AUTO_COLS = 'id, provider, folder_id, destination_id, options, enabled, created_at, updated_at'

function toAutomation(r: Row): IntegrationAutomation {
  const o = parseJson<{ objectTypes?: unknown }>(r['options'], {})
  const objectTypes = Array.isArray(o.objectTypes) ? o.objectTypes.filter((t): t is AttioObjectType => OBJECT_TYPES.includes(t as AttioObjectType)) : undefined
  return {
    id: String(r['id']),
    provider: r['provider'] as IntegrationProvider,
    folderId: String(r['folder_id']),
    destinationId: str(r['destination_id']),
    options: objectTypes ? { objectTypes } : {},
    enabled: Number(r['enabled']) === 1,
    createdAt: String(r['created_at']),
    updatedAt: String(r['updated_at'])
  }
}

export function listIntegrationAutomations(s: StoreCtx, q: { folderId?: string; provider?: IntegrationProvider; enabledOnly?: boolean }): IntegrationAutomation[] {
  const where: string[] = []
  const vals: unknown[] = []
  if (q?.folderId) {
    where.push('folder_id = ?')
    vals.push(String(q.folderId))
  }
  if (q?.provider) {
    where.push('provider = ?')
    vals.push(provider(q.provider))
  }
  if (q?.enabledOnly) where.push('enabled = 1')
  const rows = s.db
    .prepare(`SELECT ${AUTO_COLS} FROM integration_automations ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at, rid`)
    .all(...vals) as Row[]
  return rows.map(toAutomation)
}

export function upsertIntegrationAutomation(s: StoreCtx, a: IntegrationAutomationInput & { id?: string }): IntegrationAutomation {
  const p = provider(a?.provider)
  if (typeof a.folderId !== 'string' || !a.folderId) throw invalid('folderId is required')
  if (!s.db.prepare(`SELECT 1 FROM folders WHERE id = ?`).get(a.folderId)) throw notFound('folder', a.folderId)
  const destinationId = typeof a.destinationId === 'string' && a.destinationId ? a.destinationId : null
  if (destinationId && !s.db.prepare(`SELECT 1 FROM integration_destinations WHERE id = ? AND provider = ?`).get(destinationId, p)) {
    throw notFound('destination', destinationId)
  }
  const objectTypes = Array.isArray(a.options?.objectTypes) ? a.options.objectTypes.filter((t) => OBJECT_TYPES.includes(t)) : undefined
  const options = JSON.stringify(objectTypes ? { objectTypes } : {})
  const enabled = a.enabled === true
  const now = nowIso()
  return inTransaction(s.db, () => {
    // Slack and Attio bind one rule per folder (destination optional); Zapier one per (folder, workflow).
    const existing = (
      a.id
        ? s.db.prepare(`SELECT id, enabled, enabled_at FROM integration_automations WHERE id = ?`).get(a.id)
        : p === 'zapier'
          ? s.db.prepare(`SELECT id, enabled, enabled_at FROM integration_automations WHERE folder_id = ? AND provider = ? AND destination_id IS ?`).get(a.folderId, p, destinationId)
          : s.db.prepare(`SELECT id, enabled, enabled_at FROM integration_automations WHERE folder_id = ? AND provider = ?`).get(a.folderId, p)
    ) as Row | undefined
    let id: string
    if (existing) {
      id = String(existing['id'])
      const wasEnabled = Number(existing['enabled']) === 1
      const enabledAt = enabled ? (wasEnabled ? str(existing['enabled_at']) ?? now : now) : str(existing['enabled_at'])
      s.db
        .prepare(`UPDATE integration_automations SET destination_id = ?, options = ?, enabled = ?, enabled_at = ?, updated_at = ? WHERE id = ?`)
        .run(destinationId, options, enabled ? 1 : 0, enabledAt, now, id)
    } else {
      id = a.id ?? randomUUID()
      s.db
        .prepare(
          `INSERT INTO integration_automations (id, workspace_id, owner_id, provider, folder_id, destination_id, options, enabled, enabled_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(id, s.identity.workspaceId, s.identity.ownerId, p, a.folderId, destinationId, options, enabled ? 1 : 0, enabled ? now : null, now, now)
    }
    s.touch('integration_automations', id)
    return toAutomation(s.db.prepare(`SELECT ${AUTO_COLS} FROM integration_automations WHERE id = ?`).get(id) as Row)
  })
}

export function setIntegrationAutomationsEnabled(s: StoreCtx, provider_: IntegrationProvider, enabled: boolean): number {
  const p = provider(provider_)
  const now = nowIso()
  const r = enabled
    ? s.db.prepare(`UPDATE integration_automations SET enabled = 1, enabled_at = ?, updated_at = ? WHERE provider = ? AND enabled = 0`).run(now, now, p)
    : s.db.prepare(`UPDATE integration_automations SET enabled = 0, updated_at = ? WHERE provider = ? AND enabled = 1`).run(now, p)
  if (r.changes) s.touch('integration_automations')
  return r.changes
}

// ---------- deliveries ----------

const DEL_COLS = `d.id, d.provider, d.destination_id, d.automation_id, d.note_id, d.panel_id, d.target_key, d."trigger", d.status,
  d.attempts, d.next_attempt_at, d.external_id, d.external_url, d.error_code, d.error_message, d.sent_at, d.created_at, d.updated_at,
  doc.title AS note_title, doc.deleted_at AS note_deleted_at`
const DEL_FROM = `integration_deliveries d LEFT JOIN documents doc ON doc.id = d.note_id`

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
    // A deleted note keeps its rows without the content-derived message.
    errorMessage: deleted ? null : str(r['error_message']),
    sentAt: str(r['sent_at']),
    createdAt: String(r['created_at']),
    updatedAt: String(r['updated_at'])
  }
}

function getDelivery(s: StoreCtx, id: string): IntegrationDelivery {
  const r = s.db.prepare(`SELECT ${DEL_COLS} FROM ${DEL_FROM} WHERE d.id = ?`).get(id) as Row | undefined
  if (!r) throw notFound('delivery', id)
  return toDelivery(r)
}

function insertDelivery(s: StoreCtx, d: NewIntegrationDelivery, now: string): string {
  const p = provider(d?.provider)
  if (typeof d.noteId !== 'string' || !d.noteId) throw invalid('noteId is required')
  if (!['manual', 'folder', 'test'].includes(d.trigger)) throw invalid('unknown delivery trigger')
  if (!['scheduled', 'pending'].includes(d.status)) throw invalid('a new delivery is scheduled or pending')
  const id = randomUUID()
  s.db
    .prepare(
      `INSERT INTO integration_deliveries (id, workspace_id, owner_id, provider, destination_id, automation_id, note_id, panel_id,
         target_key, "trigger", status, attempts, next_attempt_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`
    )
    .run(
      id,
      s.identity.workspaceId,
      s.identity.ownerId,
      p,
      d.destinationId ?? null,
      d.automationId ?? null,
      d.noteId,
      d.panelId ?? null,
      String(d.targetKey ?? '').slice(0, 2_000),
      d.trigger,
      d.status,
      isoOrNull(d.nextAttemptAt, 'nextAttemptAt') ?? now,
      now,
      now
    )
  s.touch('integration_deliveries', id, d.noteId)
  return id
}

export function claimAutomationRun(
  s: StoreCtx,
  automationId: string,
  noteId: string,
  result: 'queued' | 'no_targets',
  deliveries: NewIntegrationDelivery[]
): { created: boolean; deliveries: IntegrationDelivery[] } {
  if (typeof automationId !== 'string' || !automationId || typeof noteId !== 'string' || !noteId) throw invalid('automationId and noteId are required')
  if (result !== 'queued' && result !== 'no_targets') throw invalid('unknown run result')
  return inTransaction(s.db, () => {
    const now = nowIso()
    const r = s.db
      .prepare(`INSERT OR IGNORE INTO integration_automation_runs (automation_id, note_id, ran_at, result) VALUES (?, ?, ?, ?)`)
      .run(automationId, noteId, now, result)
    if (!r.changes) return { created: false, deliveries: [] }
    const ids = (deliveries ?? []).map((d) => insertDelivery(s, { ...d, automationId }, now))
    return { created: true, deliveries: ids.map((id) => getDelivery(s, id)) }
  })
}

export function createIntegrationDeliveries(s: StoreCtx, ds: NewIntegrationDelivery[]): IntegrationDelivery[] {
  if (!Array.isArray(ds) || !ds.length) return []
  if (ds.length > 200) throw invalid('too many deliveries at once')
  return inTransaction(s.db, () => {
    const now = nowIso()
    for (const d of ds) if (!s.db.prepare(`SELECT 1 FROM documents WHERE id = ?`).get(d.noteId)) throw notFound('note', d.noteId)
    const ids = ds.map((d) => insertDelivery(s, d, now))
    return ids.map((id) => getDelivery(s, id))
  })
}

export function updateIntegrationDelivery(s: StoreCtx, id: string, patch: IntegrationDeliveryPatch): IntegrationDelivery {
  if (typeof id !== 'string' || !id) throw invalid('id is required')
  const sets: string[] = []
  const vals: unknown[] = []
  if (patch?.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw invalid('unknown delivery status')
    sets.push('status = ?')
    vals.push(patch.status)
  }
  if (patch?.attempts !== undefined) {
    if (!Number.isInteger(patch.attempts) || patch.attempts < 0) throw invalid('attempts must be a non-negative integer')
    sets.push('attempts = ?')
    vals.push(patch.attempts)
  }
  if (patch?.nextAttemptAt !== undefined) {
    sets.push('next_attempt_at = ?')
    vals.push(isoOrNull(patch.nextAttemptAt, 'nextAttemptAt'))
  }
  if (patch?.sentAt !== undefined) {
    sets.push('sent_at = ?')
    vals.push(isoOrNull(patch.sentAt, 'sentAt'))
  }
  for (const [k, col] of [
    ['externalId', 'external_id'],
    ['externalUrl', 'external_url'],
    ['errorCode', 'error_code'],
    ['errorMessage', 'error_message']
  ] as const) {
    const v = patch?.[k]
    if (v === undefined) continue
    sets.push(`${col} = ?`)
    vals.push(v === null ? null : clip(String(v)))
  }
  if (!s.db.prepare(`SELECT 1 FROM integration_deliveries WHERE id = ?`).get(id)) throw notFound('delivery', id)
  if (sets.length) {
    sets.push('updated_at = ?')
    vals.push(nowIso())
    s.db.prepare(`UPDATE integration_deliveries SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
    s.touch('integration_deliveries', id)
  }
  return getDelivery(s, id)
}

export function listIntegrationDeliveries(
  s: StoreCtx,
  q: { provider?: IntegrationProvider; noteId?: string; statuses?: IntegrationDelivery['status'][]; limit: number }
): IntegrationDelivery[] {
  const where: string[] = []
  const vals: unknown[] = []
  if (q?.provider) {
    where.push('d.provider = ?')
    vals.push(provider(q.provider))
  }
  if (q?.noteId) {
    where.push('d.note_id = ?')
    vals.push(String(q.noteId))
  }
  if (q?.statuses?.length) {
    const st = q.statuses.filter((x) => STATUSES.includes(x))
    if (!st.length) return []
    where.push(`d.status IN (${st.map(() => '?').join(', ')})`)
    vals.push(...st)
  }
  const limit = Math.max(1, Math.min(500, Math.floor(Number(q?.limit) || 20)))
  const rows = s.db
    .prepare(`SELECT ${DEL_COLS} FROM ${DEL_FROM} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY d.updated_at DESC, d.rid DESC LIMIT ?`)
    .all(...vals, limit) as Row[]
  return rows.map(toDelivery)
}

/** Due work: scheduled and pending rows, and failed rows with an automatic retry, whose time has come. */
export function dueIntegrationDeliveries(s: StoreCtx, now: IsoTime, limit: number): IntegrationDelivery[] {
  const at = isoOrNull(now, 'now') ?? nowIso()
  const rows = s.db
    .prepare(
      `SELECT ${DEL_COLS} FROM ${DEL_FROM}
       WHERE d.status IN ('scheduled', 'pending', 'failed') AND d.next_attempt_at IS NOT NULL AND d.next_attempt_at <= ?
         AND d.held_at IS NULL
       ORDER BY d.next_attempt_at, d.rid LIMIT ?`
    )
    .all(at, Math.max(1, Math.min(500, Math.floor(limit) || 50))) as Row[]
  return rows.map(toDelivery)
}

/**
 * Enabled rules × notes added to the rule's folder after the rule was enabled and after
 * `since`, not trashed, whose latest summary completed with content, without a run row.
 */
export function pendingAutomationNotes(s: StoreCtx, since: IsoTime): { automationId: string; noteId: string }[] {
  const at = isoOrNull(since, 'since') ?? nowIso()
  const rows = s.db
    .prepare(
      `SELECT a.id AS automation_id, fn.note_id AS note_id
       FROM integration_automations a
       JOIN folder_notes fn ON fn.folder_id = a.folder_id
       JOIN documents doc ON doc.id = fn.note_id AND doc.deleted_at IS NULL
       WHERE a.enabled = 1 AND a.enabled_at IS NOT NULL AND fn.created_at >= a.enabled_at AND fn.created_at >= ?
         AND EXISTS (
           SELECT 1 FROM note_panels p
           WHERE p.document_id = fn.note_id AND p.deleted_at IS NULL AND p.content_edited_at IS NOT NULL
             AND p.enhance_failed_at IS NULL AND TRIM(COALESCE(p.content_markdown, p.generated_content, '')) <> ''
         )
         AND NOT EXISTS (SELECT 1 FROM integration_automation_runs r WHERE r.automation_id = a.id AND r.note_id = fn.note_id)
       ORDER BY fn.created_at
       LIMIT 200`
    )
    .all(at) as Row[]
  return rows.map((r) => ({ automationId: String(r['automation_id']), noteId: String(r['note_id']) }))
}

/** Catch-up limit: due work older than `before` ends as `failed` / `expired`. */
export function expireIntegrationDeliveries(s: StoreCtx, before: IsoTime): number {
  const at = isoOrNull(before, 'before') ?? nowIso()
  const now = nowIso()
  const r = s.db
    .prepare(
      `UPDATE integration_deliveries SET status = 'failed', next_attempt_at = NULL, error_code = 'expired',
         error_message = 'This was not sent within 7 days, so Notula stopped trying.', updated_at = ?
       WHERE created_at < ? AND (status IN ('scheduled', 'pending', 'sending') OR (status = 'failed' AND next_attempt_at IS NOT NULL))`
    )
    .run(now, at)
  if (r.changes) s.touch('integration_deliveries')
  return r.changes
}
