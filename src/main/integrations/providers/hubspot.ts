// SPDX-License-Identifier: Apache-2.0
// HubSpot: a private-app token, attendee suggestions,
// typed search over contacts, companies and deals, and one note per save.

import type { IntegrationResultKind, IntegrationSearchResult } from '@shared/types/integrations'
import { matchSet } from '../attendees'
import { escapeHtml, meetingStart, noteTitle, previewDate } from '../content'
import { integrationsHttp, parseBody, type HttpInit } from '../http'
import { asString, failure, type ProviderClient, type SendOutcome } from './types'

const COPY = {
  network: 'Couldn’t reach HubSpot.',
  busy: 'HubSpot is busy. Try again in a minute.',
  other: 'Couldn’t save to HubSpot. Try again.',
  status: {
    400: 'HubSpot couldn’t accept this note.',
    401: 'Your HubSpot token isn’t working. Update it in Settings.',
    403: 'Your HubSpot app is missing a permission. Check its scopes in Settings.',
    404: 'One of the selected records no longer exists in HubSpot.'
  }
}

const SEARCH_PACE: HttpInit['pace'] = { key: 'hubspot:search', intervalMs: 250 }
const WRITE_PACE: HttpInit['pace'] = { key: 'hubspot', intervalMs: 125 }
const ASSOCIATION: Record<string, number> = { contact: 202, company: 190, deal: 214 }
const BODY_LIMIT = 65_536

type Obj = 'contacts' | 'companies' | 'deals'

async function search(token: string, obj: Obj, json: Record<string, unknown>): Promise<Record<string, unknown>[]> {
  const init: HttpInit = { kind: 'read', method: 'POST', headers: { Authorization: `Bearer ${token}` }, json, pace: SEARCH_PACE }
  const r =
    obj === 'contacts'
      ? await integrationsHttp.fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', init)
      : obj === 'companies'
        ? await integrationsHttp.fetch('https://api.hubapi.com/crm/v3/objects/companies/search', init)
        : await integrationsHttp.fetch('https://api.hubapi.com/crm/v3/objects/deals/search', init)
  if (!r.ok) throw new Error(r.kind === 'http' ? `http_${r.status}` : r.kind)
  const body = parseBody(r.text)
  return Array.isArray(body['results']) ? (body['results'] as Record<string, unknown>[]) : []
}

function toResult(obj: Obj, r: Record<string, unknown>, suggested: boolean): IntegrationSearchResult | null {
  const id = asString(r['id'])
  if (!id) return null
  const p = (r['properties'] ?? {}) as Record<string, unknown>
  const kind: IntegrationResultKind = obj === 'contacts' ? 'contact' : obj === 'companies' ? 'company' : 'deal'
  const label =
    obj === 'contacts'
      ? `${asString(p['firstname']) ?? ''} ${asString(p['lastname']) ?? ''}`.trim() || asString(p['email']) || 'Unnamed contact'
      : obj === 'companies'
        ? asString(p['name']) ?? asString(p['domain']) ?? 'Unnamed company'
        : asString(p['dealname']) ?? 'Unnamed deal'
  const subtitle = obj === 'contacts' ? asString(p['email']) : obj === 'companies' ? asString(p['domain']) : null
  return { provider: 'hubspot', kind, id, label, subtitle, suggested }
}

const PROPS: Record<Obj, string[]> = { contacts: ['firstname', 'lastname', 'email'], companies: ['name', 'domain'], deals: ['dealname'] }

export const hubspot: ProviderClient = {
  id: 'hubspot',

  async validate(_ctx, token) {
    // A one-result contact search.
    const r = await integrationsHttp.fetch('https://api.hubapi.com/crm/v3/objects/contacts/search', {
      kind: 'read',
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
      json: { limit: 1 },
      pace: SEARCH_PACE
    })
    if (r.ok) return { state: 'connected', accountLabel: null, detail: null }
    if (r.kind === 'http' && r.status === 401) return { state: 'invalid', accountLabel: null, detail: 'HubSpot didn’t accept this token.' }
    if (r.kind === 'http' && r.status === 403) return { state: 'invalid', accountLabel: null, detail: 'Your HubSpot app is missing a permission. Check the scopes above.' }
    return { state: 'unreachable', accountLabel: null, detail: 'Couldn’t reach HubSpot.' }
  },

  async search(ctx, q, token): Promise<IntegrationSearchResult[]> {
    const text = q.query?.trim() ?? ''
    if (text) {
      const out: IntegrationSearchResult[] = []
      for (const obj of ['contacts', 'companies', 'deals'] as const) {
        const rows = await search(token, obj, { query: text.slice(0, 200), limit: 10, properties: PROPS[obj] })
        for (const r of rows) {
          const x = toResult(obj, r, false)
          if (x) out.push(x)
        }
      }
      return out
    }
    if (!q.noteId) return []
    const note = await ctx.storage.getNote(q.noteId)
    if (!note) return []
    const m = await matchSet(ctx, note)
    const out: IntegrationSearchResult[] = []
    if (m.emails.length) {
      const rows = await search(token, 'contacts', {
        filterGroups: [{ filters: [{ propertyName: 'email', operator: 'IN', values: m.emails.slice(0, 100) }] }],
        properties: PROPS.contacts,
        limit: 100
      })
      for (const r of rows) {
        const x = toResult('contacts', r, true)
        if (x) out.push(x)
      }
    }
    if (m.domains.length) {
      const rows = await search(token, 'companies', {
        filterGroups: [{ filters: [{ propertyName: 'domain', operator: 'IN', values: m.domains.slice(0, 100) }] }],
        properties: PROPS.companies,
        limit: 100
      })
      for (const r of rows) {
        const x = toResult('companies', r, true)
        if (x) out.push(x)
      }
    }
    return out
  },

  async send(_ctx, job): Promise<SendOutcome> {
    if (!job.credential) return { ok: false, retry: 'never', code: 'unauthorized', message: COPY.status[401] }
    const targets = parseTargets(job.delivery.targetKey)
    const lead = `<p><strong>${escapeHtml(noteTitle(job.note))}</strong> · ${escapeHtml(previewDate(meetingStart(job.note)))}</p>`
    let body = `${lead}${job.content.html}`
    if (body.length > BODY_LIMIT) {
      const plain = `${noteTitle(job.note)} · ${previewDate(meetingStart(job.note))}\n\n${job.content.text}`
      body = plain.length > 65_500 ? `${plain.slice(0, 65_500)}…` : plain
    }
    const r = await integrationsHttp.fetch('https://api.hubapi.com/crm/v3/objects/notes', {
      kind: 'write',
      method: 'POST',
      headers: { Authorization: `Bearer ${job.credential}` },
      json: {
        properties: { hs_timestamp: meetingStart(job.note), hs_note_body: body },
        associations: targets.map((t) => ({ to: { id: t.id }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION[t.kind] }] }))
      },
      pace: WRITE_PACE
    })
    if (!r.ok) return failure(r, COPY)
    return { ok: true, externalId: asString(parseBody(r.text)['id']), externalUrl: null }
  }
}

/** `contact:1,company:2` → targets (the delivery's `target_key` for a multi-association note). */
export function parseTargets(key: string): { kind: 'contact' | 'company' | 'deal'; id: string }[] {
  return key
    .split(',')
    .map((p) => p.split(':'))
    .filter((p): p is ['contact' | 'company' | 'deal', string] => p.length === 2 && ['contact', 'company', 'deal'].includes(p[0] ?? '') && /^\d{1,30}$/.test(p[1] ?? ''))
    .map(([kind, id]) => ({ kind, id }))
}
