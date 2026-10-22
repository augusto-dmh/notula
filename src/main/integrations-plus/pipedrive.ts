// SPDX-License-Identifier: Apache-2.0
// The Pipedrive plug-in (Labs `integrations.pipedriveAshby.enabled`).
// A personal API token in the `x-api-token` header, against `https://<company>.pipedrive.com/api/…`.
// Saves a `meeting` activity (done per `integrations.pipedrive.activityDone`), falling back to a note
// when the account has no Meeting activity type. 5 requests per second. Secret `integration.pipedrive`
// {token, companyDomain}; the token never reaches a log or the renderer.

import { notulaError } from '@shared/errors'
import { PIPEDRIVE, type IntegrationSearchResult } from '@shared/types/integrations'
import { exchange, providerHttp, type Exchange } from '../calendar-write/http'
import type { MainContext } from '../context'
import type { IntegrationPlugin, IntegrationSendOutcome } from '../integration-plugins'
import { matchSet } from '../integrations/attendees'
import { latestSummaryPanel } from '../integrations/content'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { crmHtml, encodeSecret, folderRow, hhmm, manualRow, noteContent, pace, parseTargets, readSecret, targetKey } from './common'

interface Cred {
  token: string
  companyDomain: string
}

const KINDS = ['person', 'organization', 'deal'] as const
const NUM = /^\d{1,20}$/

export const PD_COPY = {
  invalid: 'Pipedrive didn’t accept this token.',
  token: 'Your Pipedrive token isn’t working. Update it in Settings.',
  plan: 'Your Pipedrive plan or permissions don’t allow this.',
  gone: 'One of the selected records no longer exists in Pipedrive.',
  busy: 'Pipedrive is busy. Try again in a minute.',
  generic: 'Couldn’t save to Pipedrive. Try again.',
  noteFallback: 'Saved as a Pipedrive note (no Meeting activity type).'
} as const

/** "Company address": `https://<x>.pipedrive.com` or `<x>.pipedrive.com`, stored as `<x>`. */
export function companyOf(raw: unknown): string | null {
  const v = typeof raw === 'string' ? raw.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '') : ''
  const m = /^([a-z0-9][a-z0-9-]{0,62})(\.pipedrive\.com)?$/.exec(v)
  return m?.[1] ?? null
}

function copyFor(x: Exchange): string {
  if (x.ok) return ''
  if (x.kind === 'local-only') return 'local-only mode'
  if (x.kind !== 'http') return PD_COPY.generic
  if (x.status === 401) return PD_COPY.token
  if (x.status === 402 || x.status === 403) return PD_COPY.plan
  if (x.status === 404) return PD_COPY.gone
  if (x.status === 429) return PD_COPY.busy
  return PD_COPY.generic
}

export function pipedrivePlugin(): IntegrationPlugin {
  const cred = (ctx: MainContext): Promise<Cred | null> => readSecret<Cred>(ctx, 'integration.pipedrive')

  async function call(ctx: MainContext, c: Cred, run: (http: ReturnType<typeof providerHttp>, init: { params: Record<string, string>; headers: Record<string, string> }) => Promise<Response>): Promise<Exchange> {
    await pace(`pipedrive:${c.companyDomain}`, PIPEDRIVE.ratePerSec)
    const http = providerHttp(ctx, 'integration', 'pipedrive')
    return exchange(() => run(http, { params: { company: c.companyDomain }, headers: { 'x-api-token': c.token, accept: 'application/json' } }))
  }

  async function searchPersons(ctx: MainContext, c: Cred, term: string, exact: boolean, limit: number): Promise<Exchange> {
    return call(ctx, c, (http, init) =>
      http.fetch('https://{company}.pipedrive.com/api/v2/persons/search', { ...init, query: { term, limit: String(limit), ...(exact ? { fields: 'email', exact_match: 'true' } : {}) } })
    )
  }

  type Item = { id?: number; name?: string; title?: string; emails?: { value?: string }[]; organization?: { id?: number; name?: string } | null }
  const items = (x: Exchange): Item[] => {
    if (!x.ok) return []
    const d = x.body['data'] as { items?: { item?: Item }[] } | undefined
    return (d?.items ?? []).map((i) => i.item ?? {}).filter((i) => typeof i.id === 'number')
  }

  async function suggestions(ctx: MainContext, c: Cred, noteId: string): Promise<IntegrationSearchResult[]> {
    const note = await ctx.storage.getNote(noteId)
    if (!note) return []
    const out: IntegrationSearchResult[] = []
    const orgs = new Set<number>()
    for (const email of (await matchSet(ctx, note)).emails.slice(0, 20)) {
      const x = await searchPersons(ctx, c, email, true, 1)
      if (!x.ok && x.kind === 'http' && x.status === 401) throw new Error(PD_COPY.token)
      for (const p of items(x)) {
        out.push({ provider: 'pipedrive', kind: 'person', id: String(p.id), label: p.name ?? email, subtitle: email, suggested: true })
        const o = p.organization
        if (o?.id && !orgs.has(o.id)) {
          orgs.add(o.id)
          out.push({ provider: 'pipedrive', kind: 'organization', id: String(o.id), label: o.name ?? 'Organization', subtitle: null, suggested: true })
        }
      }
    }
    return out
  }

  async function typed(ctx: MainContext, c: Cred, term: string): Promise<IntegrationSearchResult[]> {
    const [p, o, d] = await Promise.all([
      searchPersons(ctx, c, term, false, 10),
      call(ctx, c, (http, init) => http.fetch('https://{company}.pipedrive.com/api/v2/organizations/search', { ...init, query: { term, limit: '10' } })),
      call(ctx, c, (http, init) => http.fetch('https://{company}.pipedrive.com/api/v2/deals/search', { ...init, query: { term, limit: '10' } }))
    ])
    if (!p.ok && p.kind === 'http' && p.status === 401) throw new Error(PD_COPY.token)
    return [
      ...items(p).map((i) => ({ provider: 'pipedrive' as const, kind: 'person' as const, id: String(i.id), label: i.name ?? '', subtitle: i.emails?.[0]?.value ?? i.organization?.name ?? null, suggested: false })),
      ...items(o).map((i) => ({ provider: 'pipedrive' as const, kind: 'organization' as const, id: String(i.id), label: i.name ?? '', subtitle: null, suggested: false })),
      ...items(d).map((i) => ({ provider: 'pipedrive' as const, kind: 'deal' as const, id: String(i.id), label: i.title ?? '', subtitle: i.organization?.name ?? null, suggested: false }))
    ]
  }

  async function save(ctx: MainContext, noteId: string, panelId: string | null, key: string): Promise<IntegrationSendOutcome> {
    const c = await cred(ctx)
    if (!c) return { status: 'failed', retryable: false, errorCode: 'not_connected', errorMessage: PD_COPY.token }
    const content = await noteContent(ctx, noteId, panelId)
    if (!content) return { status: 'failed', retryable: false, errorCode: 'no_content', errorMessage: 'This note has no summary to send.' }
    const t = parseTargets(key)
    const ids = (k: string): number[] => t.filter((x) => x.kind === k && NUM.test(x.id)).map((x) => Number(x.id))
    const persons = ids('person')
    const org = ids('organization')[0]
    const deal = ids('deal')[0]
    const start = new Date(content.start)
    const html = crmHtml(content.html, content.lead)
    const body: Record<string, unknown> = {
      subject: content.title,
      type: 'meeting',
      due_date: start.toISOString().slice(0, 10),
      due_time: start.toISOString().slice(11, 16),
      duration: hhmm(content.end ? Date.parse(content.end) - start.getTime() : 30 * 60_000),
      done: await ctx.settings.get('integrations.pipedrive.activityDone'),
      note: html,
      ...(persons.length ? { participants: persons.map((id, i) => ({ person_id: id, primary: i === 0 })) } : {}),
      ...(org !== undefined ? { org_id: org } : {}),
      ...(deal !== undefined ? { deal_id: deal } : {})
    }
    const x = await call(ctx, c, (http, init) => http.fetch('https://{company}.pipedrive.com/api/v2/activities', { ...init, method: 'POST', headers: { ...init.headers, 'content-type': 'application/json' }, body: JSON.stringify(body) }))
    const okId = (r: Exchange): string | null => {
      if (!r.ok || r.body['success'] !== true) return null
      const d = r.body['data'] as { id?: unknown } | undefined
      return d?.id !== undefined ? String(d.id) : null
    }
    const id = okId(x)
    if (id) {
      log('info', 'pipedrive:saved', { kind: 'activity' })
      return { status: 'sent', externalId: id, externalUrl: `https://${c.companyDomain}.pipedrive.com/activities/${id}` }
    }
    // The account has no `meeting` activity type: a note instead.
    const typeError = !x.ok && x.kind === 'http' && x.status === 400 && /type/i.test(JSON.stringify(x.body).slice(0, 2_000))
    if (typeError) {
      const n = await call(ctx, c, (http, init) =>
        http.fetch('https://{company}.pipedrive.com/api/v1/notes', {
          ...init,
          method: 'POST',
          headers: { ...init.headers, 'content-type': 'application/json' },
          body: JSON.stringify({ content: html, ...(persons[0] !== undefined ? { person_id: persons[0] } : {}), ...(org !== undefined ? { org_id: org } : {}), ...(deal !== undefined ? { deal_id: deal } : {}) })
        })
      )
      const nid = okId(n)
      if (nid) {
        log('info', 'pipedrive:saved', { kind: 'note' })
        return { status: 'sent', externalId: nid, warnings: [PD_COPY.noteFallback] }
      }
      return failure(n)
    }
    return failure(x)
  }

  function failure(x: Exchange): IntegrationSendOutcome {
    if (!x.ok && x.kind === 'uncertain') return { status: 'uncertain', errorMessage: 'Check Pipedrive before trying again.' }
    const retryable = !x.ok && (x.kind === 'network' || (x.kind === 'http' && (x.status === 429 || x.status >= 500)))
    return { status: 'failed', retryable, errorCode: !x.ok && x.kind === 'http' ? `http_${x.status}` : 'error', errorMessage: copyFor(x) }
  }

  return {
    provider: 'pipedrive',
    credentialKinds: ['pipedrive-token'],
    async validate(ctx) {
      const c = await cred(ctx)
      if (!c) return { state: 'not_configured', accountLabel: null, detail: null }
      const x = await call(ctx, c, (http, init) => http.fetch('https://{company}.pipedrive.com/api/v1/users/me', init))
      if (x.ok) {
        const d = (x.body['data'] ?? {}) as { email?: string; company_domain?: string; company_name?: string }
        return { state: 'connected', accountLabel: [d.email, d.company_domain ? `${d.company_domain}.pipedrive.com` : `${c.companyDomain}.pipedrive.com`].filter(Boolean).join(' · '), detail: null }
      }
      if (x.kind === 'http' && x.status === 401) return { state: 'invalid', accountLabel: null, detail: PD_COPY.invalid }
      return { state: 'unreachable', accountLabel: null, detail: null }
    },
    async setCredential(ctx, input) {
      const token = typeof input.value === 'string' ? input.value.trim() : ''
      const company = companyOf(input.label)
      if (!company) throw expected(notulaError('invalid-input', 'Enter your company address, like yourcompany.pipedrive.com.'))
      if (!/^[A-Za-z0-9]{20,80}$/.test(token)) throw expected(notulaError('invalid-input', 'Paste your personal API token from Pipedrive.'))
      await ctx.secrets.set('integration.pipedrive', encodeSecret({ token, companyDomain: company } satisfies Cred))
    },
    async search(ctx, q) {
      const c = await cred(ctx)
      if (!c) throw expected(notulaError('missing-key', 'Connect Pipedrive in Settings first.'))
      const text = q.query?.trim() ?? ''
      try {
        if (text.length >= 2) return await typed(ctx, c, text)
        if (!text && q.noteId) return await suggestions(ctx, c, q.noteId)
        return []
      } catch (err) {
        throw expected(notulaError('provider-error', err instanceof Error && err.message ? err.message : 'Couldn’t search Pipedrive right now.'))
      }
    },
    async share(_ctx, req) {
      const key = targetKey(req.targets, KINDS, NUM)
      if (!key) throw expected(notulaError('invalid-input', 'Pick Pipedrive records to save to.'))
      return [manualRow('pipedrive', req, key)]
    },
    async send(ctx, d) {
      return save(ctx, d.noteId, d.panelId, d.targetKey)
    },
    async folderTargets(ctx, noteId) {
      const c = await cred(ctx)
      if (!c) return []
      const s = await suggestions(ctx, c, noteId).catch(() => [] as IntegrationSearchResult[])
      const persons = s.filter((r) => r.kind === 'person')
      if (!persons.length) return []
      const key = [...persons.slice(0, 10), ...s.filter((r) => r.kind === 'organization').slice(0, 1)].map((r) => `${r.kind}:${r.id}`).join(',')
      return [folderRow('pipedrive', noteId, latestSummaryPanel(await ctx.storage.listPanels(noteId))?.id ?? null, key)]
    },
    async disconnect(ctx) {
      await ctx.secrets.clear('integration.pipedrive')
      log('info', 'pipedrive:disconnected', {})
    }
  }
}
