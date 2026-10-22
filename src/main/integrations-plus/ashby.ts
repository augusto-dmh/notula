// SPDX-License-Identifier: Apache-2.0
// The Ashby plug-in (Labs `integrations.pipedriveAshby.enabled`).
// POSTs to `https://api.ashbyhq.com/<endpoint>` with HTTP Basic auth (the key as user name, an empty
// password). Candidates are found by attendee email or typed name; a save adds one HTML note per
// selected candidate with `sendNotifications: false`. Secret `integration.ashby` (the key).

import { notulaError } from '@shared/errors'
import type { IntegrationSearchResult } from '@shared/types/integrations'
import { exchange, providerHttp, type Exchange } from '../calendar-write/http'
import type { MainContext } from '../context'
import type { IntegrationPlugin, IntegrationSendOutcome } from '../integration-plugins'
import { matchSet } from '../integrations/attendees'
import { latestSummaryPanel } from '../integrations/content'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { crmHtml, folderRow, manualRow, noteContent, pace } from './common'

const ID = /^[A-Za-z0-9-]{8,64}$/

export const ASHBY_COPY = {
  key: 'Your Ashby key isn’t working. Update it in Settings.',
  permission: 'Your Ashby key is missing a permission. Check it has Candidates read and write.',
  generic: 'Error saving to Ashby'
} as const

function copyFor(x: Exchange): string {
  if (x.ok) return ''
  if (x.kind === 'local-only') return 'local-only mode'
  if (x.kind === 'http' && x.status === 401) return ASHBY_COPY.key
  if (x.kind === 'http' && x.status === 403) return ASHBY_COPY.permission
  return ASHBY_COPY.generic
}

export function ashbyPlugin(): IntegrationPlugin {
  const key = (ctx: MainContext): Promise<string | null> => ctx.secrets.get('integration.ashby')

  async function post(ctx: MainContext, k: string, endpoint: 'search' | 'note', body: unknown): Promise<Exchange> {
    await pace('ashby', 5)
    const http = providerHttp(ctx, 'integration', 'ashby')
    const init = {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${k}:`, 'utf8').toString('base64')}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(body)
    }
    if (endpoint === 'search') return exchange(() => http.fetch('https://api.ashbyhq.com/candidate.search', init))
    return exchange(() => http.fetch('https://api.ashbyhq.com/candidate.createNote', init))
  }

  type Candidate = { id?: string; name?: string; primaryEmailAddress?: { value?: string } | null }
  const results = (x: Exchange): Candidate[] => (x.ok && x.body['success'] === true && Array.isArray(x.body['results']) ? (x.body['results'] as Candidate[]) : []).filter((c) => typeof c.id === 'string')
  const toResult = (c: Candidate, suggested: boolean): IntegrationSearchResult => ({ provider: 'ashby', kind: 'candidate', id: String(c.id), label: c.name ?? 'Candidate', subtitle: c.primaryEmailAddress?.value ?? null, suggested })

  async function suggestions(ctx: MainContext, k: string, noteId: string): Promise<IntegrationSearchResult[]> {
    const note = await ctx.storage.getNote(noteId)
    if (!note) return []
    const out = new Map<string, IntegrationSearchResult>()
    for (const email of (await matchSet(ctx, note)).emails.slice(0, 20)) {
      const x = await post(ctx, k, 'search', { email, limit: 5 })
      if (!x.ok && x.kind === 'http' && (x.status === 401 || x.status === 403)) throw new Error(copyFor(x))
      for (const c of results(x)) out.set(String(c.id), toResult(c, true))
    }
    return [...out.values()]
  }

  async function createNote(ctx: MainContext, k: string, candidateId: string, html: string): Promise<IntegrationSendOutcome> {
    const x = await post(ctx, k, 'note', { candidateId, note: { type: 'text/html', value: html }, sendNotifications: false })
    if (x.ok && x.body['success'] === true) {
      const r = x.body['results'] as { id?: unknown } | undefined
      return { status: 'sent', ...(r?.id !== undefined ? { externalId: String(r.id) } : {}) }
    }
    if (x.ok) {
      const errs = x.body['errors'] as ({ message?: string } | string)[] | undefined
      const first = errs?.[0]
      const msg = typeof first === 'string' ? first : first?.message
      return { status: 'failed', retryable: false, errorCode: 'ashby_error', errorMessage: (msg ?? ASHBY_COPY.generic).slice(0, 300) }
    }
    if (x.kind === 'uncertain') return { status: 'uncertain', errorMessage: 'Check Ashby before trying again.' }
    const retryable = x.kind === 'network' || (x.kind === 'http' && (x.status === 429 || x.status >= 500))
    return { status: 'failed', retryable, errorCode: x.kind === 'http' ? `http_${x.status}` : x.kind, errorMessage: copyFor(x) }
  }

  return {
    provider: 'ashby',
    credentialKinds: ['ashby-key'],
    async validate(ctx) {
      const k = await key(ctx)
      if (!k) return { state: 'not_configured', accountLabel: null, detail: null }
      const x = await post(ctx, k, 'search', { email: 'notula-check@example.invalid', limit: 1 })
      if (x.ok && x.body['success'] === true) return { state: 'connected', accountLabel: 'Ashby', detail: null }
      if (!x.ok && x.kind === 'http' && (x.status === 401 || x.status === 403)) return { state: 'invalid', accountLabel: null, detail: copyFor(x) }
      if (x.ok) return { state: 'invalid', accountLabel: null, detail: ASHBY_COPY.permission }
      return { state: 'unreachable', accountLabel: null, detail: null }
    },
    async setCredential(ctx, input) {
      const v = typeof input.value === 'string' ? input.value.trim() : ''
      if (!/^[A-Za-z0-9._-]{16,200}$/.test(v)) throw expected(notulaError('invalid-input', 'Paste the API key you created in Ashby.'))
      await ctx.secrets.set('integration.ashby', v)
    },
    async search(ctx, q) {
      const k = await key(ctx)
      if (!k) throw expected(notulaError('missing-key', 'Connect Ashby in Settings first.'))
      const text = q.query?.trim() ?? ''
      try {
        if (text.length >= 3) return results(await post(ctx, k, 'search', text.includes('@') ? { email: text, limit: 10 } : { name: text, limit: 10 })).map((c) => toResult(c, false))
        if (!text && q.noteId) return await suggestions(ctx, k, q.noteId)
        return []
      } catch (err) {
        throw expected(notulaError('provider-error', err instanceof Error && err.message ? err.message : 'Couldn’t search Ashby right now.'))
      }
    },
    async share(_ctx, req) {
      const ids = [...new Set((req.targets ?? []).filter((t) => t?.kind === 'candidate' && ID.test(t.id)).map((t) => t.id))].slice(0, 20)
      if (!ids.length) throw expected(notulaError('invalid-input', 'Pick Ashby candidates to save to.'))
      // One delivery per candidate (as Attio does for several records).
      return ids.map((id) => manualRow('ashby', req, id))
    },
    async send(ctx, d) {
      const k = await key(ctx)
      if (!k) return { status: 'failed', retryable: false, errorCode: 'not_connected', errorMessage: ASHBY_COPY.key }
      const c = await noteContent(ctx, d.noteId, d.panelId)
      if (!c) return { status: 'failed', retryable: false, errorCode: 'no_content', errorMessage: 'This note has no summary to send.' }
      if (!ID.test(d.targetKey)) return { status: 'failed', retryable: false, errorCode: 'no_targets', errorMessage: 'No Ashby candidate was selected.' }
      const out = await createNote(ctx, k, d.targetKey, crmHtml(c.html, c.lead))
      log('info', 'ashby:saved', { status: out.status })
      return out
    },
    async folderTargets(ctx, noteId) {
      const k = await key(ctx)
      if (!k) return []
      const s = await suggestions(ctx, k, noteId).catch(() => [] as IntegrationSearchResult[])
      const panelId = latestSummaryPanel(await ctx.storage.listPanels(noteId))?.id ?? null
      return s.slice(0, 10).map((r) => folderRow('ashby', noteId, panelId, r.id))
    },
    async disconnect(ctx) {
      await ctx.secrets.clear('integration.ashby')
      log('info', 'ashby:disconnected', {})
    }
  }
}
