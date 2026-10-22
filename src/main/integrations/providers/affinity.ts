// SPDX-License-Identifier: Apache-2.0
// Affinity: an API key over HTTP Basic, people and
// organization search with attendee suggestions, and one HTML note per save.

import type { IntegrationSearchResult } from '@shared/types/integrations'
import { matchSet } from '../attendees'
import { integrationsHttp, parseBody, type HttpInit, type HttpResult } from '../http'
import { asString, failure, type ProviderClient, type SendOutcome } from './types'

const COPY = {
  network: 'Couldn’t reach Affinity.',
  busy: 'Affinity is busy. Try again in a minute.',
  other: 'Couldn’t save to Affinity. Try again.',
  status: {
    400: 'Affinity couldn’t accept this note.',
    401: 'Affinity key rejected. Update it in Settings.',
    404: 'One of the selected people or organizations no longer exists in Affinity.',
    422: 'Affinity couldn’t accept this note.'
  }
}

const PACE: HttpInit['pace'] = { key: 'affinity', intervalMs: 200, concurrency: 3 }

function auth(key: string): Record<string, string> {
  return { Authorization: `Basic ${Buffer.from(`:${key}`).toString('base64')}` }
}

function orgCapped(r: HttpResult): boolean {
  return 'headers' in r && r.headers.get('x-ratelimit-limit-org-remaining')?.trim() === '0'
}

async function getList(key: string, path: 'persons' | 'organizations', term: string): Promise<Record<string, unknown>[]> {
  const init: HttpInit = { kind: 'read', headers: auth(key), pace: PACE }
  const r =
    path === 'persons'
      ? await integrationsHttp.fetch('https://api.affinity.co/persons', { ...init, query: { term, with_current_organizations: true } })
      : await integrationsHttp.fetch('https://api.affinity.co/organizations', { ...init, query: { term } })
  if (!r.ok) throw new Error(orgCapped(r) ? 'org_cap' : r.kind === 'http' ? `http_${r.status}` : r.kind)
  const body = parseBody(r.text)
  const list = body[path]
  return Array.isArray(list) ? (list as Record<string, unknown>[]) : []
}

function person(p: Record<string, unknown>, suggested: boolean): IntegrationSearchResult | null {
  const id = asString(p['id'])
  if (!id) return null
  const name = `${asString(p['first_name']) ?? ''} ${asString(p['last_name']) ?? ''}`.trim()
  const email = asString(p['primary_email']) ?? (Array.isArray(p['emails']) ? asString(p['emails'][0]) : null)
  const orgs = Array.isArray(p['current_organization_ids']) ? (p['current_organization_ids'] as unknown[]).map(String).join(',') : ''
  return { provider: 'affinity', kind: 'person', id, label: name || email || 'Unnamed person', subtitle: email, suggested, extra: { organizationIds: orgs } }
}

function org(o: Record<string, unknown>, suggested: boolean): IntegrationSearchResult | null {
  const id = asString(o['id'])
  if (!id) return null
  return { provider: 'affinity', kind: 'organization', id, label: asString(o['name']) ?? asString(o['domain']) ?? 'Unnamed organization', subtitle: asString(o['domain']), suggested }
}

export const affinity: ProviderClient = {
  id: 'affinity',

  async validate(_ctx, key) {
    const r = await integrationsHttp.fetch('https://api.affinity.co/auth/whoami', { kind: 'read', headers: auth(key), pace: PACE })
    if (!r.ok) {
      if (r.kind === 'http' && (r.status === 401 || r.status === 403)) return { state: 'invalid', accountLabel: null, detail: 'Affinity rejected this key. Paste a new one.' }
      return { state: 'unreachable', accountLabel: null, detail: 'Couldn’t reach Affinity. Try again, or check your connection.' }
    }
    const tenant = (parseBody(r.text)['tenant'] ?? {}) as Record<string, unknown>
    const sub = asString(tenant['subdomain'])?.toLowerCase().replace(/[^a-z0-9-]/g, '') ?? ''
    const domain = sub ? `${sub}.affinity.co` : ''
    return { state: 'connected', accountLabel: domain || 'Affinity', detail: null, meta: { domain } }
  },

  async search(ctx, q, key): Promise<IntegrationSearchResult[]> {
    const text = (q.query ?? '').trim()
    const out: IntegrationSearchResult[] = []
    if (text) {
      for (const p of (await getList(key, 'persons', text)).slice(0, 20)) out.push(...[person(p, false)].filter((x): x is IntegrationSearchResult => !!x))
      for (const o of (await getList(key, 'organizations', text)).slice(0, 20)) out.push(...[org(o, false)].filter((x): x is IntegrationSearchResult => !!x))
      return out
    }
    if (!q.noteId) return out
    const note = await ctx.storage.getNote(q.noteId)
    if (!note) return out
    const m = await matchSet(ctx, note)
    const orgIds = new Set<string>()
    for (const email of m.emails.slice(0, 10)) {
      for (const p of await getList(key, 'persons', email)) {
        const x = person(p, true)
        if (!x || out.some((o) => o.kind === 'person' && o.id === x.id)) continue
        out.push(x)
        for (const id of String(x.extra?.['organizationIds'] ?? '').split(',').filter(Boolean)) orgIds.add(id)
      }
    }
    for (const domain of m.domains.slice(0, 10)) {
      for (const o of await getList(key, 'organizations', domain)) {
        const x = org(o, true)
        if (x && !out.some((r) => r.kind === 'organization' && r.id === x.id)) out.push(x)
      }
    }
    // Attendees' current organizations (step 6), at most 10.
    for (const id of [...orgIds].slice(0, 10)) {
      if (out.some((r) => r.kind === 'organization' && r.id === id)) continue
      const r = await integrationsHttp.fetch('https://api.affinity.co/organizations/{id}', { kind: 'read', params: { id }, headers: auth(key), pace: PACE })
      if (!r.ok) continue
      const x = org(parseBody(r.text), true)
      if (x) out.push(x)
    }
    return out.slice(0, 40)
  },

  async send(ctx, job): Promise<SendOutcome> {
    if (!job.credential) return { ok: false, retry: 'never', code: 'unauthorized', message: COPY.status[401] }
    const persons: number[] = []
    const orgs: number[] = []
    for (const part of job.delivery.targetKey.split(',')) {
      const [kind, id] = part.split(':')
      if (!id || !/^\d{1,18}$/.test(id)) continue
      if (kind === 'person') persons.push(Number(id))
      if (kind === 'organization') orgs.push(Number(id))
    }
    if (!persons.length && !orgs.length) return { ok: false, retry: 'never', code: 'no_targets', message: 'Choose a person or an organization in Affinity first' }
    const created = job.note.created_at
    const r = await integrationsHttp.fetch('https://api.affinity.co/notes', {
      kind: 'write',
      method: 'POST',
      headers: auth(job.credential),
      json: {
        person_ids: persons,
        organization_ids: orgs,
        content: job.content.html,
        type: 2,
        ...(Date.parse(created) <= Date.now() ? { created_at: created } : {})
      },
      pace: PACE
    })
    if (!r.ok) {
      if (orgCapped(r)) return { ok: false, retry: 'never', code: 'org_cap', message: 'Your Affinity account has reached its monthly API limit.' }
      if (r.kind === 'http' && r.status === 429) {
        const reset = Number(r.headers.get('x-ratelimit-limit-user-reset'))
        return { ok: false, retry: 'auto', code: 'rate_limited', message: COPY.busy, ...(Number.isFinite(reset) && reset > 0 ? { retryAfterMs: reset * 1000 } : {}) }
      }
      return failure(r, COPY)
    }
    const id = asString(parseBody(r.text)['id'])
    const domain = (await ctx.settings.get('integrations.affinity.domain')).trim()
    return { ok: true, externalId: id, externalUrl: id && /^[a-z0-9-]+\.affinity\.co$/.test(domain) ? `https://${domain}/notes/${id}` : null }
  }
}
