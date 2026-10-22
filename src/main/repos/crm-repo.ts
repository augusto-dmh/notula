// SPDX-License-Identifier: Apache-2.0
// Customer calls: the storage-worker side of their StorageApi group. Worker-safe: no Electron imports.
//
// - The backlog: notes from `since` classified `sales` / `account_care`, not
//   sensitive, not in Trash, not already in the folder, with no excluded attendee.
// - Sync status: the latest delivery per note and provider from `integration_deliveries`; a note
//   with no row since the folder binding (`since`) is `not-synced`.

import type { IsoTime } from '@shared/types/common'
import { CUSTOMER_CALLS, type CustomerCallsBacklogNote, type CustomerCallsSyncStatus } from '@shared/types/customer-calls'
import type { IntegrationProvider } from '@shared/types/integrations'
import type { CalendarEvent, DocumentTag, NotePeople } from '@shared/types/notes'
import { parseJson } from '../storage/rows'
import { invalid, type StoreCtx } from '../storage/store'

type Row = Record<string, unknown>

function attendeeEmails(event: CalendarEvent | null, people: NotePeople | null): string[] {
  const out: string[] = []
  for (const a of Array.isArray(event?.attendees) ? event.attendees : []) if (typeof a.email === 'string') out.push(a.email.trim().toLowerCase())
  const org = event?.['organizer'] as { email?: unknown } | undefined
  if (typeof org?.email === 'string') out.push(org.email.trim().toLowerCase())
  for (const p of people?.attendees ?? []) if (typeof p.email === 'string') out.push(p.email.trim().toLowerCase())
  return out.filter((e) => e.includes('@'))
}

/** True when an attendee email is excluded, or its domain equals or is under an excluded domain. */
export function isExcluded(emails: string[], excludedEmails: string[], excludedDomains: string[]): boolean {
  const ex = new Set(excludedEmails.map((e) => e.toLowerCase()))
  const doms = excludedDomains.map((d) => d.toLowerCase())
  return emails.some((e) => {
    if (ex.has(e)) return true
    const d = e.slice(e.lastIndexOf('@') + 1)
    return doms.some((x) => d === x || d.endsWith(`.${x}`))
  })
}

export function customerCallsBacklog(
  s: StoreCtx,
  q: { folderId: string; since: IsoTime; excludedEmails: string[]; excludedDomains: string[] }
): CustomerCallsBacklogNote[] {
  if (typeof q?.folderId !== 'string' || !q.folderId) throw invalid('folderId is required')
  const types = CUSTOMER_CALLS.meetingTypes as readonly string[]
  const rows = s.db
    .prepare(
      `SELECT d.id, d.title, d.created_at, d.sort_epoch, d.linked_event, d.people, d.tags
       FROM documents d
       WHERE d.owner_id = ? AND d.workspace_id = ? AND d.deleted_at IS NULL AND d.is_shared = 0
         AND d.created_at >= ?
         AND EXISTS (SELECT 1 FROM document_tags t WHERE t.document_id = d.id AND t.category = 'meeting_kind' AND t.value IN (${types.map(() => '?').join(', ')}))
         AND NOT EXISTS (SELECT 1 FROM document_tags t WHERE t.document_id = d.id AND t.category = 'is_sensitive' AND t.value = 'true')
         AND NOT EXISTS (SELECT 1 FROM folder_notes f WHERE f.folder_id = ? AND f.note_id = d.id)
       ORDER BY d.sort_epoch DESC
       LIMIT 500`
    )
    .all(s.identity.ownerId, s.identity.workspaceId, q.since, ...types, q.folderId) as Row[]
  const out: CustomerCallsBacklogNote[] = []
  for (const r of rows) {
    const emails = attendeeEmails(parseJson<CalendarEvent | null>(r['linked_event'], null), parseJson<NotePeople | null>(r['people'], null))
    if (isExcluded(emails, q.excludedEmails ?? [], q.excludedDomains ?? [])) continue
    const tag = parseJson<DocumentTag[]>(r['tags'], []).find((t) => t?.category === 'meeting_kind')
    const secs = Number(r['sort_epoch'])
    out.push({
      noteId: String(r['id']),
      title: typeof r['title'] === 'string' && r['title'] ? r['title'] : null,
      meetingAt: Number.isFinite(secs) && secs > 0 ? new Date(secs * 1000).toISOString() : String(r['created_at']),
      meetingType: String(tag?.value ?? CUSTOMER_CALLS.meetingTypes[0])
    })
  }
  return out
}

function stateOf(status: string): CustomerCallsSyncStatus['state'] {
  if (status === 'sent') return 'synced'
  if (status === 'scheduled' || status === 'pending' || status === 'sending') return 'sending'
  if (status === 'failed') return 'failed'
  if (status === 'uncertain') return 'check'
  return null
}

export function customerCallsSyncStatus(s: StoreCtx, q: { noteIds: string[]; providers: IntegrationProvider[]; since: IsoTime | null }): CustomerCallsSyncStatus[] {
  const noteIds = Array.isArray(q?.noteIds) ? [...new Set(q.noteIds.filter((x) => typeof x === 'string' && x))].slice(0, 500) : []
  const providers = Array.isArray(q?.providers) ? [...new Set(q.providers)].slice(0, 20) : []
  const latest = s.db.prepare(
    `SELECT id, status, error_message, created_at FROM integration_deliveries
     WHERE owner_id = ? AND workspace_id = ? AND note_id = ? AND provider = ? AND status <> 'cancelled'
     ORDER BY created_at DESC, rid DESC LIMIT 1`
  )
  const out: CustomerCallsSyncStatus[] = []
  for (const noteId of noteIds) {
    for (const provider of providers) {
      const r = latest.get(s.identity.ownerId, s.identity.workspaceId, noteId, provider) as Row | undefined
      const fresh = r && (q.since === null || String(r['created_at']) >= q.since)
      if (!r || !fresh) {
        out.push({ noteId, provider, state: q.since !== null ? 'not-synced' : null, error: null, deliveryId: null })
        continue
      }
      const state = stateOf(String(r['status']))
      out.push({ noteId, provider, state, error: state === 'failed' || state === 'check' ? (typeof r['error_message'] === 'string' ? r['error_message'] : null) : null, deliveryId: String(r['id']) })
    }
  }
  return out
}
