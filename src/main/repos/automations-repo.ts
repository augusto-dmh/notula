// SPDX-License-Identifier: Apache-2.0
// Automations: the storage-worker side of their StorageApi group. Worker-safe: no Electron imports.
//
// - Rules are validated in main; the repo checks the envelope and stamps `enabled_at` whenever a
//   rule is created enabled or turned back on ("only meetings that end after a rule was created or
//   enabled count"). Listed rules carry `enabled_at` as an extra field for the scheduler.
// - `automation_runs` is unique on (rule_id, note_id): `claimAutomationRunOnce` is the once-only guard.
// - `endedMeetingNotes` is "a meeting ended": the note's capture stopped (no session open),
//   then its summary generation finished, or `noSummaryWaitMs` passed with none started.

import { randomUUID } from 'node:crypto'
import type { AutomationAction, AutomationPredicate, AutomationRule, AutomationRuleInput, AutomationRun, AutomationRunStatus } from '@shared/types/automations'
import type { IsoTime } from '@shared/types/common'
import type { CalendarEvent, DocumentTag, NotePeople } from '@shared/types/notes'
import { nowIso, parseJson } from '../storage/rows'
import { inTransaction, invalid, notFound, type StoreCtx } from '../storage/store'

type Row = Record<string, unknown>

const RUN_STATUSES: readonly AutomationRunStatus[] = ['matched', 'no_match', 'needs_confirmation', 'executed', 'dismissed', 'failed']
const str = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

export type StoredAutomationRule = AutomationRule & { enabled_at: IsoTime | null }

function toRule(r: Row): StoredAutomationRule {
  const actions = parseJson<AutomationAction[]>(r['actions'], [])
  return {
    id: String(r['id']),
    name: String(r['name']),
    description: str(r['description']),
    enabled: r['enabled'] === 1,
    trigger: 'meeting_ended',
    predicates: parseJson<AutomationPredicate[]>(r['predicates'], []),
    actions: (actions.length ? [actions[0]] : [{ type: 'file_in_folder', folder_id: '' }]) as [AutomationAction],
    confirm_sends: r['confirm_sends'] === 1,
    created_at: String(r['created_at']),
    updated_at: String(r['updated_at']),
    enabled_at: str(r['enabled_at'])
  }
}

function toRun(r: Row): AutomationRun {
  return {
    id: String(r['id']),
    rule_id: String(r['rule_id']),
    note_id: String(r['note_id']),
    note_title: str(r['note_title']),
    status: String(r['status']) as AutomationRunStatus,
    reason: str(r['reason']),
    delivery_id: str(r['delivery_id']),
    evaluated_at: String(r['evaluated_at']),
    executed_at: str(r['executed_at'])
  }
}

const RUN_SELECT = `SELECT r.*, d.title AS note_title FROM automation_runs r LEFT JOIN documents d ON d.id = r.note_id`

function getRun(s: StoreCtx, where: string, ...args: unknown[]): AutomationRun | null {
  const r = s.db.prepare(`${RUN_SELECT} WHERE r.owner_id = ? AND r.workspace_id = ? AND ${where}`).get(s.identity.ownerId, s.identity.workspaceId, ...args) as Row | undefined
  return r ? toRun(r) : null
}

export function listAutomationRules(s: StoreCtx): AutomationRule[] {
  const rows = s.db
    .prepare('SELECT * FROM automation_rules WHERE owner_id = ? AND workspace_id = ? ORDER BY created_at, rid')
    .all(s.identity.ownerId, s.identity.workspaceId) as Row[]
  return rows.map(toRule)
}

export function upsertAutomationRule(s: StoreCtx, r: AutomationRuleInput): AutomationRule {
  if (!r || typeof r.name !== 'string' || !Array.isArray(r.predicates) || !Array.isArray(r.actions) || r.actions.length !== 1) throw invalid('Invalid automation')
  const now = nowIso()
  const out = inTransaction(s.db, () => {
    const id = typeof r.id === 'string' && r.id ? r.id : randomUUID()
    const prev = s.db.prepare('SELECT * FROM automation_rules WHERE id = ?').get(id) as Row | undefined
    if (prev && (prev['owner_id'] !== s.identity.ownerId || prev['workspace_id'] !== s.identity.workspaceId)) throw notFound('automation', id)
    const enabled = r.enabled ? 1 : 0
    const enabledAt = enabled ? (prev && prev['enabled'] === 1 ? str(prev['enabled_at']) ?? now : now) : prev ? str(prev['enabled_at']) : null
    const params = {
      id,
      workspace: s.identity.workspaceId,
      owner: s.identity.ownerId,
      name: r.name,
      description: r.description ?? null,
      enabled,
      enabledAt,
      predicates: JSON.stringify(r.predicates),
      actions: JSON.stringify(r.actions),
      confirm: r.confirm_sends ? 1 : 0,
      now
    }
    if (prev) {
      s.db
        .prepare(
          `UPDATE automation_rules SET name = @name, description = @description, enabled = @enabled, enabled_at = @enabledAt,
           predicates = @predicates, actions = @actions, confirm_sends = @confirm, updated_at = @now WHERE id = @id`
        )
        .run(params)
    } else {
      s.db
        .prepare(
          `INSERT INTO automation_rules (id, workspace_id, owner_id, name, description, enabled, enabled_at, "trigger", predicates, actions, confirm_sends, created_at, updated_at)
           VALUES (@id, @workspace, @owner, @name, @description, @enabled, @enabledAt, 'meeting_ended', @predicates, @actions, @confirm, @now, @now)`
        )
        .run(params)
    }
    return toRule(s.db.prepare('SELECT * FROM automation_rules WHERE id = ?').get(id) as Row)
  })
  s.touch('automation_rules', out.id)
  return out
}

/** Its runs go with it (ON DELETE CASCADE); the notes it filed stay where they are. */
export function deleteAutomationRule(s: StoreCtx, id: string): void {
  if (typeof id !== 'string' || !id) throw invalid('id is required')
  const n = s.db.prepare('DELETE FROM automation_rules WHERE id = ? AND owner_id = ? AND workspace_id = ?').run(id, s.identity.ownerId, s.identity.workspaceId).changes
  if (n) s.touch('automation_rules', id)
}

export function claimAutomationRunOnce(
  s: StoreCtx,
  ruleId: string,
  noteId: string,
  run: { status: AutomationRunStatus; reason: string | null }
): { created: boolean; run: AutomationRun } {
  if (!RUN_STATUSES.includes(run?.status)) throw invalid('Unknown run status')
  const res = inTransaction(s.db, () => {
    const prev = getRun(s, 'r.rule_id = ? AND r.note_id = ?', ruleId, noteId)
    if (prev) return { created: false, run: prev }
    const id = randomUUID()
    s.db
      .prepare(
        `INSERT INTO automation_runs (id, workspace_id, owner_id, rule_id, note_id, status, reason, delivery_id, evaluated_at, executed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)`
      )
      .run(id, s.identity.workspaceId, s.identity.ownerId, ruleId, noteId, run.status, run.reason, nowIso())
    return { created: true, run: getRun(s, 'r.id = ?', id) as AutomationRun }
  })
  if (res.created) s.touch('automation_runs', res.run.id)
  return res
}

export function updateAutomationRun(
  s: StoreCtx,
  id: string,
  patch: { status?: AutomationRunStatus; reason?: string | null; delivery_id?: string | null; executed_at?: IsoTime | null }
): AutomationRun {
  const prev = getRun(s, 'r.id = ?', id)
  if (!prev) throw notFound('automation run', id)
  if (patch.status !== undefined && !RUN_STATUSES.includes(patch.status)) throw invalid('Unknown run status')
  s.db
    .prepare('UPDATE automation_runs SET status = ?, reason = ?, delivery_id = ?, executed_at = ? WHERE id = ?')
    .run(
      patch.status ?? prev.status,
      patch.reason !== undefined ? patch.reason : prev.reason,
      patch.delivery_id !== undefined ? patch.delivery_id : prev.delivery_id,
      patch.executed_at !== undefined ? patch.executed_at : prev.executed_at,
      id
    )
  s.touch('automation_runs', id)
  return getRun(s, 'r.id = ?', id) as AutomationRun
}

export function listAutomationRuns(s: StoreCtx, q: { ruleId?: string; noteId?: string; status?: AutomationRunStatus; limit: number }): AutomationRun[] {
  const where: string[] = ['r.owner_id = ?', 'r.workspace_id = ?']
  const args: unknown[] = [s.identity.ownerId, s.identity.workspaceId]
  if (typeof q?.ruleId === 'string' && q.ruleId) {
    where.push('r.rule_id = ?')
    args.push(q.ruleId)
  }
  if (typeof q?.noteId === 'string' && q.noteId) {
    where.push('r.note_id = ?')
    args.push(q.noteId)
  }
  if (q?.status !== undefined) {
    if (!RUN_STATUSES.includes(q.status)) throw invalid('Unknown run status')
    where.push('r.status = ?')
    args.push(q.status)
  }
  const limit = Math.max(1, Math.min(500, Math.floor(Number(q?.limit) || 50)))
  const rows = s.db.prepare(`${RUN_SELECT} WHERE ${where.join(' AND ')} ORDER BY r.evaluated_at DESC, r.rid DESC LIMIT ${limit}`).all(...args) as Row[]
  return rows.map(toRun)
}

export function endedMeetingNotes(s: StoreCtx, q: { since: IsoTime; noSummaryWaitMs: number; now: IsoTime }): { noteId: string; endedAt: IsoTime }[] {
  const waitMs = Math.max(0, Number(q?.noSummaryWaitMs) || 0)
  const nowMs = Date.parse(q?.now) || Date.now()
  const rows = s.db
    .prepare(
      `SELECT t.document_id AS note_id, MAX(t.ended_at) AS ended_at,
              SUM(CASE WHEN t.ended_at IS NULL THEN 1 ELSE 0 END) AS open_sessions
       FROM transcription_sessions t JOIN documents d ON d.id = t.document_id
       WHERE t.owner_id = ? AND t.workspace_id = ? AND d.deleted_at IS NULL
       GROUP BY t.document_id
       HAVING open_sessions = 0 AND MAX(t.ended_at) >= ?
       ORDER BY ended_at
       LIMIT 500`
    )
    .all(s.identity.ownerId, s.identity.workspaceId, q.since) as Row[]
  const panels = s.db.prepare(
    `SELECT enhance_started_at, content_edited_at, enhance_failed_at FROM note_panels
     WHERE document_id = ? AND deleted_at IS NULL`
  )
  const out: { noteId: string; endedAt: IsoTime }[] = []
  for (const r of rows) {
    const noteId = String(r['note_id'])
    const endedAt = String(r['ended_at'])
    const after = (v: unknown): boolean => typeof v === 'string' && v >= endedAt
    const list = panels.all(noteId) as Row[]
    const finished = list.some((p) => after(p['content_edited_at']) || after(p['enhance_failed_at']))
    const started = list.some((p) => after(p['enhance_started_at']))
    const waited = nowMs - Date.parse(endedAt) >= waitMs
    if (finished || (!started && waited)) out.push({ noteId, endedAt })
  }
  return out
}

function emailsOf(event: CalendarEvent | null, people: NotePeople | null): { email: string; name: string }[] {
  const seen = new Set<string>()
  const out: { email: string; name: string }[] = []
  const add = (email: unknown, name: unknown, resource?: unknown, declined?: boolean): void => {
    if (typeof email !== 'string' || resource === true || declined) return
    const e = email.trim().toLowerCase()
    if (!e.includes('@') || seen.has(e)) return
    seen.add(e)
    out.push({ email: e, name: typeof name === 'string' ? name : '' })
  }
  for (const a of Array.isArray(event?.attendees) ? event.attendees : []) add(a.email, a.displayName, a.resource, a.responseStatus === 'declined')
  const org = event?.['organizer'] as { email?: unknown; displayName?: unknown } | undefined
  if (org) add(org.email, org.displayName)
  if (!event) for (const p of people?.attendees ?? []) add(p.email, p.name)
  return out
}

export function automationFacts(
  s: StoreCtx,
  noteId: string
): { attendees: { email: string; name: string }[]; recurringEventId: string | null; meetingType: string | null; isSensitive: boolean | null; hasSummary: boolean } {
  const d = s.db.prepare('SELECT linked_event, people, tags FROM documents WHERE id = ? AND owner_id = ?').get(noteId, s.identity.ownerId) as Row | undefined
  if (!d) throw notFound('note', noteId)
  const event = parseJson<CalendarEvent | null>(d['linked_event'], null)
  const people = parseJson<NotePeople | null>(d['people'], null)
  const tags = parseJson<DocumentTag[]>(d['tags'], [])
  const type = tags.find((t) => t?.category === 'meeting_kind')
  const sens = tags.find((t) => t?.category === 'is_sensitive')
  const summary = s.db
    .prepare(
      `SELECT 1 FROM note_panels WHERE document_id = ? AND deleted_at IS NULL AND content_edited_at IS NOT NULL
       AND enhance_failed_at IS NULL AND COALESCE(content_markdown, generated_content, '') <> '' LIMIT 1`
    )
    .get(noteId)
  const recurring = event?.['recurringEventId']
  return {
    attendees: emailsOf(event, people),
    recurringEventId: typeof recurring === 'string' && recurring ? recurring : null,
    meetingType: typeof type?.value === 'string' && type.value ? type.value : null,
    isSensitive: sens ? sens.value === 'true' : null,
    hasSummary: !!summary
  }
}
