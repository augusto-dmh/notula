// SPDX-License-Identifier: Apache-2.0
// Reminders: the storage-worker side of their StorageApi group. Worker-safe: no Electron imports.
//
// - One row per `<kind>:<event identity>` key, so one event never raises the same kind twice.
// - A stored row that fails validation is set aside (left in place, skipped) and logged, never
//   silently dropped: Notula never wipes user data.
// - Resolved and dismissed rows are derived data: `pruneReminders` deletes the old ones.

import { randomUUID } from 'node:crypto'
import type { IsoTime } from '@shared/types/common'
import type {
  Reminder,
  ReminderAction,
  ReminderKind,
  ReminderResolvedReason,
  ReminderStatus,
  ReminderVariant
} from '@shared/types/reminder-cards'
import { nowIso, parseJson } from '../storage/rows'
import { inTransaction, invalid, type StoreCtx } from '../storage/store'

type Row = Record<string, unknown>

const KINDS: readonly ReminderKind[] = ['missing_invite', 'no_meeting_link', 'attendees_absent', 'late_for_meeting', 'followup_drafts']
const STATUSES: readonly ReminderStatus[] = ['pending', 'active', 'dismissed', 'resolved']
const REASONS: readonly ReminderResolvedReason[] = [
  'cancelled',
  'expired',
  'rsvped',
  'ineligible',
  'details_added',
  'live',
  'joined',
  'not_transcribing',
  'session_ended',
  'draft_failed'
]
const VARIANTS: readonly ReminderVariant[] = ['default', 'focus_time', 'late_for_meeting']
const LIST_MAX = 500

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const strOrNull = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

function toReminder(r: Row): Reminder | null {
  const kind = r['kind'] as ReminderKind
  const status = r['status'] as ReminderStatus
  const presentation = parseJson<unknown>(r['presentation'], null)
  const actions = parseJson<unknown>(r['actions'], null)
  const context = parseJson<unknown>(r['context'], null)
  if (!KINDS.includes(kind) || !STATUSES.includes(status)) return null
  if (!isObject(presentation) || typeof presentation['title'] !== 'string' || !VARIANTS.includes(presentation['variant'] as ReminderVariant)) return null
  if (!Array.isArray(actions) || !actions.every((a) => isObject(a) && typeof a['id'] === 'string' && typeof a['kind'] === 'string')) return null
  if (!isObject(context)) return null
  const reason = r['resolved_reason'] as ReminderResolvedReason | null
  const clash = isObject(context['clash']) && typeof context['clash']['title'] === 'string' && typeof context['clash']['start'] === 'string'
    ? { title: context['clash']['title'], start: context['clash']['start'] }
    : null
  return {
    id: String(r['id']),
    key: String(r['reminder_key']),
    kind,
    status,
    resolvedReason: reason && REASONS.includes(reason) ? reason : null,
    dueAt: strOrNull(r['due_at']),
    expiresAt: strOrNull(r['expires_at']),
    presentation: {
      variant: presentation['variant'] as ReminderVariant,
      title: presentation['title'],
      summary: typeof presentation['summary'] === 'string' ? presentation['summary'] : null
    },
    actions: actions as unknown as ReminderAction[],
    threadId: strOrNull(r['thread_id']),
    context: { eventId: strOrNull(context['eventId']), noteId: strOrNull(context['noteId']), clash },
    createdAt: String(r['created_at']),
    updatedAt: String(r['updated_at'])
  }
}

/** Valid rows only; an invalid one is logged by id and left where it is. */
function parsed(s: StoreCtx, rows: Row[]): Reminder[] {
  const out: Reminder[] = []
  for (const r of rows) {
    const v = toReminder(r)
    if (v) out.push(v)
    else s.log('warn', 'reminders:invalid-row-set-aside', { id: String(r['id']), key: String(r['reminder_key']) })
  }
  return out
}

export function listReminders(s: StoreCtx, q: { statuses?: ReminderStatus[]; keys?: string[] }): Reminder[] {
  const where = ['owner_id = @owner']
  const params: Record<string, unknown> = { owner: s.identity.ownerId }
  if (Array.isArray(q?.statuses)) {
    const statuses = q.statuses.filter((x) => STATUSES.includes(x))
    if (statuses.length === 0) return []
    where.push(`status IN (${statuses.map((_, i) => `@st${i}`).join(', ')})`)
    statuses.forEach((x, i) => (params[`st${i}`] = x))
  }
  if (Array.isArray(q?.keys)) {
    const keys = q.keys.filter((k) => typeof k === 'string' && k !== '')
    if (keys.length === 0) return []
    where.push(`reminder_key IN (SELECT value FROM json_each(@keys))`)
    params['keys'] = JSON.stringify(keys)
  }
  const rows = s.db
    .prepare(`SELECT * FROM reminders WHERE ${where.join(' AND ')} ORDER BY coalesce(due_at, created_at), rid LIMIT ${LIST_MAX}`)
    .all(params) as Row[]
  return parsed(s, rows)
}

function check(r: Reminder): void {
  if (!isObject(r) || typeof r.key !== 'string' || !r.key) throw invalid('a reminder needs a key')
  if (!KINDS.includes(r.kind)) throw invalid(`unknown reminder kind ${String(r.kind)}`)
  if (!STATUSES.includes(r.status)) throw invalid(`unknown reminder status ${String(r.status)}`)
  if (r.resolvedReason !== null && !REASONS.includes(r.resolvedReason)) throw invalid('unknown resolve reason')
  if (!isObject(r.presentation) || typeof r.presentation.title !== 'string' || !VARIANTS.includes(r.presentation.variant)) {
    throw invalid('a reminder needs a presentation')
  }
  if (!Array.isArray(r.actions)) throw invalid('actions must be a list')
}

/** Inserts or updates by key (the stored id and creation time are kept). Returns the stored rows. */
export function upsertReminders(s: StoreCtx, rs: Reminder[]): Reminder[] {
  if (!Array.isArray(rs)) throw invalid('reminders must be a list')
  rs.forEach(check)
  if (rs.length === 0) return []
  const now = nowIso()
  const stmt = s.db.prepare(
    `INSERT INTO reminders (id, workspace_id, owner_id, reminder_key, kind, status, resolved_reason, due_at, expires_at,
       presentation, actions, thread_id, context, created_at, updated_at)
     VALUES (@id, @workspace, @owner, @key, @kind, @status, @reason, @due, @expires, @presentation, @actions, @thread, @context, @now, @now)
     ON CONFLICT (reminder_key) DO UPDATE SET kind = excluded.kind, status = excluded.status,
       resolved_reason = excluded.resolved_reason, due_at = excluded.due_at, expires_at = excluded.expires_at,
       presentation = excluded.presentation, actions = excluded.actions, thread_id = excluded.thread_id,
       context = excluded.context, updated_at = excluded.updated_at`
  )
  inTransaction(s.db, () => {
    for (const r of rs) {
      stmt.run({
        id: typeof r.id === 'string' && r.id ? r.id : randomUUID(),
        workspace: s.identity.workspaceId,
        owner: s.identity.ownerId,
        key: r.key,
        kind: r.kind,
        status: r.status,
        reason: r.resolvedReason,
        due: r.dueAt,
        expires: r.expiresAt,
        presentation: JSON.stringify(r.presentation),
        actions: JSON.stringify(r.actions),
        thread: r.threadId,
        context: JSON.stringify(r.context ?? {}),
        now
      })
    }
  })
  const stored = listReminders(s, { keys: rs.map((r) => r.key) })
  s.touch('reminders', ...stored.map((r) => r.id))
  return stored
}

/** Deletes resolved and dismissed rows last updated before `before`. Returns the count. */
export function pruneReminders(s: StoreCtx, before: IsoTime): number {
  const ms = typeof before === 'string' ? Date.parse(before) : NaN
  if (Number.isNaN(ms)) throw invalid('before is not a valid time')
  const res = s.db
    .prepare(`DELETE FROM reminders WHERE owner_id = ? AND status IN ('resolved', 'dismissed') AND updated_at < ?`)
    .run(s.identity.ownerId, new Date(ms).toISOString())
  if (res.changes > 0) s.touch('reminders')
  return res.changes
}
