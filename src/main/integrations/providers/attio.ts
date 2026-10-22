// SPDX-License-Identifier: Apache-2.0
// Attio: a workspace token, record search and
// suggestions, one note per selected record, and attendee matching for folder sync.

import type { AttioObjectType, IntegrationResultKind, IntegrationSearchResult } from '@shared/types/integrations'
import type { Note } from '@shared/types/notes'
import type { MainContext } from '../../context'
import { matchSet } from '../attendees'
import { meetingStart, noteTitle } from '../content'
import { integrationsHttp, parseBody, type HttpInit } from '../http'
import { asString, failure, type ProviderClient, type SendOutcome } from './types'

const COPY = {
  network: 'Couldn’t reach Attio.',
  busy: 'Attio is busy. Try again in a minute.',
  other: 'Couldn’t save to Attio. Try again in a minute.',
  status: {
    400: 'Attio couldn’t accept this note.',
    401: 'Your Attio token isn’t working. Update it in Settings.',
    403: 'Your Attio token is missing a permission.',
    404: 'That Attio record no longer exists.',
    413: 'This note is too long for Attio.'
  }
}

const READ: HttpInit['pace'] = { key: 'attio:read', intervalMs: 20 }
const WRITE: HttpInit['pace'] = { key: 'attio:write', intervalMs: 100, concurrency: 5 }
const UNNAMED = new Set(['unnamed person', 'unknown person', 'unnamed contact', 'unknown contact', 'unnamed company', 'unknown company'])
const SINGULAR: Record<AttioObjectType, IntegrationResultKind> = { people: 'person', companies: 'company', deals: 'deal' }
const OBJECTS: readonly AttioObjectType[] = ['people', 'companies', 'deals']
/** A workspace without deals drops them for the session. */
let noDeals = false

function auth(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` }
}

function firstValue(v: unknown): Record<string, unknown> | null {
  return Array.isArray(v) && v[0] && typeof v[0] === 'object' ? (v[0] as Record<string, unknown>) : null
}

/** Step 8 label rules. */
function labelOf(values: Record<string, unknown>, recordText: string | null, object: AttioObjectType): { label: string; subtitle: string | null } | null {
  let name = recordText ?? ''
  const n = values['name']
  if (!name) {
    if (typeof n === 'string') name = n
    else {
      const f = firstValue(n)
      name = asString(f?.['full_name']) ?? [asString(f?.['first_name']), asString(f?.['last_name'])].filter(Boolean).join(' ') ?? ''
      if (!name) name = asString(f?.['value']) ?? asString(f?.['email_address']) ?? asString(f?.['root_domain']) ?? ''
    }
  }
  if (UNNAMED.has(name.trim().toLowerCase())) name = ''
  const subtitle =
    object === 'people'
      ? asString(firstValue(values['email_addresses'])?.['email_address'])
      : object === 'companies'
        ? asString(firstValue(values['domains'])?.['domain']) ?? asString(firstValue(values['domains'])?.['root_domain'])
        : null
  const label = name.trim() || subtitle
  return label ? { label, subtitle } : null
}

function toResult(object: AttioObjectType, id: string, values: Record<string, unknown>, recordText: string | null, suggested: boolean): IntegrationSearchResult | null {
  const l = labelOf(values, recordText, object)
  if (!l) return null
  return { provider: 'attio', kind: SINGULAR[object], id: `${object}:${id}`, label: l.label, subtitle: l.subtitle, suggested, extra: { object } }
}

async function query(token: string, object: AttioObjectType, filter: Record<string, unknown>, limit: number): Promise<{ id: string; values: Record<string, unknown> }[]> {
  const r = await integrationsHttp.fetch('https://api.attio.com/v2/objects/{object}/records/query', {
    kind: 'read',
    method: 'POST',
    params: { object },
    headers: auth(token),
    json: { filter, limit },
    pace: READ
  })
  if (!r.ok) {
    if (object === 'deals' && r.kind === 'http' && r.status === 404) {
      noDeals = true
      return []
    }
    throw new Error(r.kind === 'http' ? `http_${r.status}` : r.kind)
  }
  const body = parseBody(r.text)
  const data = Array.isArray(body['data']) ? (body['data'] as Record<string, unknown>[]) : []
  return data
    .map((d) => ({ id: asString((d['id'] as Record<string, unknown> | undefined)?.['record_id']) ?? '', values: (d['values'] ?? {}) as Record<string, unknown> }))
    .filter((d) => d.id)
}

/** Folder-sync filters: people by email, companies by root domain, deals by their company or people. */
export async function matchRecords(ctx: MainContext, note: Note, token: string, types: readonly AttioObjectType[], limit: number): Promise<IntegrationSearchResult[]> {
  const m = await matchSet(ctx, note)
  const creator = note.people?.creator?.email?.trim().toLowerCase()
  const mine = new Set((await ctx.calendar.myEmails().catch(() => [] as string[])).map((e) => e.toLowerCase()))
  const emails = [...new Set([...m.emails, ...(creator && !mine.has(creator) ? [creator] : [])])].slice(0, 50)
  const out: IntegrationSearchResult[] = []
  const people = emails.length ? await query(token, 'people', { $or: emails.map((e) => ({ email_addresses: { email_address: { $eq: e } } })) }, limit) : []
  const companies = m.domains.length ? await query(token, 'companies', { $or: m.domains.slice(0, 50).map((d) => ({ domains: { root_domain: { $eq: d } } })) }, limit) : []
  if (types.includes('people')) for (const p of people) out.push(...[toResult('people', p.id, p.values, null, true)].filter((x): x is IntegrationSearchResult => !!x))
  if (types.includes('companies')) for (const c of companies) out.push(...[toResult('companies', c.id, c.values, null, true)].filter((x): x is IntegrationSearchResult => !!x))
  if (types.includes('deals') && !noDeals && (people.length || companies.length)) {
    const or: Record<string, unknown>[] = []
    if (companies.length) or.push({ associated_company: { target_record_id: { $in: companies.map((c) => c.id) } } })
    if (people.length) or.push({ associated_people: { target_record_id: { $in: people.map((p) => p.id) } } })
    // A workspace without these attributes rejects the filter; deals then come from search only.
    const deals = await query(token, 'deals', { $or: or }, limit).catch(() => [])
    for (const d of deals) out.push(...[toResult('deals', d.id, d.values, null, true)].filter((x): x is IntegrationSearchResult => !!x))
  }
  return out
}

export const attio: ProviderClient = {
  id: 'attio',

  async validate(_ctx, token) {
    const r = await integrationsHttp.fetch('https://api.attio.com/v2/self', { kind: 'read', headers: auth(token), pace: READ })
    if (!r.ok) {
      if (r.kind === 'http' && (r.status === 401 || r.status === 403)) return { state: 'invalid', accountLabel: null, detail: 'Attio didn’t accept this token.' }
      return { state: 'unreachable', accountLabel: null, detail: 'Couldn’t reach Attio.' }
    }
    const body = parseBody(r.text)
    if (body['active'] !== true) return { state: 'invalid', accountLabel: null, detail: 'Attio didn’t accept this token.' }
    const scope = asString(body['scope']) ?? ''
    if (scope && !scope.split(/\s+/).includes('note:read-write')) {
      return { state: 'invalid', accountLabel: asString(body['workspace_name']), detail: 'This token is missing a permission. Allow note:read-write, record_permission:read and object_configuration:read.' }
    }
    return { state: 'connected', accountLabel: asString(body['workspace_name']) ?? 'Attio', detail: null }
  },

  async search(ctx, q, token): Promise<IntegrationSearchResult[]> {
    const text = (q.query ?? '').trim()
    if (!text && q.noteId) {
      const note = await ctx.storage.getNote(q.noteId)
      const suggested = note ? await matchRecords(ctx, note, token, OBJECTS, 2).catch(() => []) : []
      const list = await searchRecords(token, '')
      const seen = new Set(suggested.map((s) => s.id))
      return [...suggested, ...list.filter((r) => !seen.has(r.id))]
    }
    return searchRecords(token, text)
  },

  async send(_ctx, job): Promise<SendOutcome> {
    if (!job.credential) return { ok: false, retry: 'never', code: 'unauthorized', message: COPY.status[401] }
    const [object, recordId] = job.delivery.targetKey.split(':')
    if (!object || !recordId || !(OBJECTS as readonly string[]).includes(object)) return { ok: false, retry: 'never', code: 'bad_target', message: COPY.status[404] }
    const start = meetingStart(job.note)
    const r = await integrationsHttp.fetch('https://api.attio.com/v2/notes', {
      kind: 'write',
      method: 'POST',
      headers: auth(job.credential),
      json: {
        data: {
          parent_object: object,
          parent_record_id: recordId,
          title: noteTitle(job.note),
          format: 'markdown',
          content: job.content.markdown || job.content.text,
          ...(Date.parse(start) <= Date.now() ? { created_at: start } : {})
        }
      },
      pace: WRITE
    })
    if (!r.ok) return failure(r, COPY)
    const data = (parseBody(r.text)['data'] ?? {}) as Record<string, unknown>
    return { ok: true, externalId: asString((data['id'] as Record<string, unknown> | undefined)?.['note_id']), externalUrl: null }
  }
}

async function searchRecords(token: string, text: string): Promise<IntegrationSearchResult[]> {
  const objects = OBJECTS.filter((o) => o !== 'deals' || !noDeals)
  const r = await integrationsHttp.fetch('https://api.attio.com/v2/objects/records/search', {
    kind: 'read',
    method: 'POST',
    headers: auth(token),
    json: { query: text.slice(0, 256), objects, request_as: { type: 'workspace' }, limit: 25 },
    pace: READ
  })
  if (!r.ok) {
    if (!noDeals && r.kind === 'http' && r.status === 404 && /deals/.test(r.text)) {
      noDeals = true
      return searchRecords(token, text)
    }
    throw new Error(r.kind === 'http' ? `http_${r.status}` : r.kind)
  }
  const body = parseBody(r.text)
  const out: IntegrationSearchResult[] = []
  for (const item of Array.isArray(body['data']) ? (body['data'] as Record<string, unknown>[]) : []) {
    const idObj = (item['id'] ?? {}) as Record<string, unknown>
    const id = asString(idObj['record_id'])
    const object = asString(item['object_slug']) as AttioObjectType | null
    if (!id || !object || !OBJECTS.includes(object)) continue
    const values: Record<string, unknown> = {}
    const emails = item['email_addresses']
    const domains = item['domains']
    if (Array.isArray(emails)) values['email_addresses'] = emails.map((e) => (typeof e === 'string' ? { email_address: e } : e))
    if (Array.isArray(domains)) values['domains'] = domains.map((d) => (typeof d === 'string' ? { domain: d } : d))
    const x = toResult(object, id, values, asString(item['record_text']), false)
    if (x) out.push(x)
  }
  return out
}
