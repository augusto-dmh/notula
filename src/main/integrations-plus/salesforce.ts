// SPDX-License-Identifier: Apache-2.0
// The Salesforce plug-in (Labs until verified on a Developer Edition
// org). OAuth 2.0 code + PKCE with the user's own External Client App, on the fixed
// loopback port 47615 (the callback URL must match exactly). Standard objects only: Event (with
// `match_else_create`), ContentNote + ContentDocumentLink, and EventRelation for further contacts.
//
// Secrets: `integration.salesforce.client` {key, secret?, myDomain} and `integration.salesforce.tokens`
// {accessToken, refreshToken, instanceUrl, identityUrl, apiVersion, accountLabel}. Nothing here logs
// a token, a URL query or a body. 5 requests per second per org.

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { app, shell } from 'electron'
import { notulaError } from '@shared/errors'
import { SALESFORCE, type IntegrationSearchResult, type SalesforceOptions } from '@shared/types/integrations'
import { devUrl, exchange, providerHttp, type Exchange } from '../calendar-write/http'
import type { MainContext } from '../context'
import type { IntegrationPlugin, IntegrationSendOutcome } from '../integration-plugins'
import { matchSet } from '../integrations/attendees'
import { latestSummaryPanel } from '../integrations/content'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { crmHtml, encodeSecret, folderRow, manualRow, noteContent, pace, parseTargets, readSecret, targetKey } from './common'

const REDIRECT = `http://localhost:${SALESFORCE.callbackPort}${SALESFORCE.callbackPath}`
const KINDS = ['contact', 'lead', 'account', 'opportunity'] as const
const SF_ID = /^[A-Za-z0-9]{15,18}$/

export const SF_COPY = {
  url: 'That isn’t a Salesforce address. Use your org’s own, such as https://acme.my.salesforce.com',
  expired: 'Your Salesforce connection expired. Reconnect in Settings.',
  tooOld: 'This Salesforce org’s API is too old for Notula.',
  port: `Another app is using port ${SALESFORCE.callbackPort}. Close it and try again.`,
  timeout: 'Sign-in timed out. Start the Salesforce connection again.',
  start: 'Couldn’t open the Salesforce sign-in. Try again.',
  generic: 'Couldn’t save to Salesforce. Try again.',
  oneContact: 'Only the first contact was linked to the Event.',
  nothing: 'Events and Notes are both off, so nothing is saved to Salesforce. Turn one on.',
  check: 'Check Salesforce before trying again.'
} as const

interface Client {
  key: string
  secret?: string
  myDomain: string
}
interface Tokens {
  accessToken: string
  refreshToken: string
  instanceUrl: string
  identityUrl: string
  apiVersion: string
  accountLabel: string | null
}

/** Step 4: an https `*.my.salesforce.com` or `*.lightning.force.com` host, as `https://<my domain host>`. */
export function normalizeSalesforceUrl(raw: unknown): { url: string; sandbox: boolean } {
  const v = typeof raw === 'string' ? raw.trim() : ''
  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(v) ? v : `https://${v}`)
  } catch {
    throw expected(notulaError('invalid-input', SF_COPY.url))
  }
  let host = u.hostname.toLowerCase()
  if (u.protocol !== 'https:' || u.username || u.password) throw expected(notulaError('invalid-input', SF_COPY.url))
  if (host.endsWith('.lightning.force.com')) host = host.replace(/\.lightning\.force\.com$/, '.my.salesforce.com')
  if (!host.endsWith('.my.salesforce.com') || host === '.my.salesforce.com') throw expected(notulaError('invalid-input', SF_COPY.url))
  const sandbox = host.endsWith('.sandbox.my.salesforce.com') || host.includes('--') || /^cs\d+\.salesforce\.com$/.test(host)
  return { url: `https://${host}`, sandbox }
}

const hostOf = (url: string): string => new URL(url).host

function soqlQuote(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}

function soslEscape(s: string): string {
  return s.replace(/[?&|!{}[\]()^~*:\\"'+-]/g, (c) => `\\${c}`)
}

function errorCodeOf(x: Exchange): string {
  if (x.ok || x.kind !== 'http') return ''
  const b = x.body as unknown
  const first = Array.isArray(b) ? (b[0] as Record<string, unknown> | undefined) : (x.body['value'] as Record<string, unknown>[] | undefined)?.[0]
  const code = (Array.isArray(b) ? first?.['errorCode'] : x.body['errorCode']) ?? first?.['errorCode']
  return typeof code === 'string' ? code : ''
}

function errorMessageOf(x: Exchange): string {
  if (x.ok || x.kind !== 'http') return ''
  const b = x.body['value'] as Record<string, unknown>[] | undefined
  const m = Array.isArray(b) ? b[0]?.['message'] : x.body['message']
  return typeof m === 'string' ? m.slice(0, 300) : ''
}

function copyFor(x: Exchange): string {
  if (x.ok) return ''
  if (x.kind === 'local-only') return 'local-only mode'
  if (x.kind !== 'http') return SF_COPY.generic
  const code = errorCodeOf(x)
  if (x.status === 401) return SF_COPY.expired
  if (x.status === 403 && code === 'API_DISABLED_FOR_ORG') return 'Your Salesforce edition doesn’t allow API access.'
  if (x.status === 403 && code.startsWith('INSUFFICIENT_ACCESS')) return 'Your Salesforce user can’t create this record.'
  if (x.status === 403 && code === 'REQUEST_LIMIT_EXCEEDED') return 'Salesforce’s API limit for today is used up.'
  if (x.status === 400 && code === 'FIELD_CUSTOM_VALIDATION_EXCEPTION') return `A Salesforce validation rule blocked this: ${errorMessageOf(x)}`
  if (x.status === 400) return 'Salesforce couldn’t accept this note.'
  return SF_COPY.generic
}

const page = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>body{font:15px/1.5 system-ui,'Segoe UI',sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#1b1b19;background:#fafaf9}main{text-align:center;max-width:28rem}h1{font-size:20px;margin:0 0 .5rem}p{margin:0;color:#5c5c57}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`

export function salesforcePlugin(): IntegrationPlugin {
  let pending: { server: Server; reject(e: Error): void } | null = null

  const client = (ctx: MainContext): Promise<Client | null> => readSecret<Client>(ctx, 'integration.salesforce.client')
  const tokens = (ctx: MainContext): Promise<Tokens | null> => readSecret<Tokens>(ctx, 'integration.salesforce.tokens')
  const saveTokens = (ctx: MainContext, t: Tokens): Promise<void> => ctx.secrets.set('integration.salesforce.tokens', encodeSecret(t))

  async function tokenCall(ctx: MainContext, myDomain: string, form: Record<string, string>): Promise<Exchange> {
    const http = providerHttp(ctx, 'integration', 'salesforce')
    return exchange(() =>
      http.fetch('https://{host}/services/oauth2/token', {
        method: 'POST',
        params: { host: hostOf(myDomain) },
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams(form).toString()
      })
    )
  }

  async function refresh(ctx: MainContext, t: Tokens): Promise<Tokens | null> {
    const c = await client(ctx)
    if (!c) return null
    const x = await tokenCall(ctx, c.myDomain, { grant_type: 'refresh_token', refresh_token: t.refreshToken, client_id: c.key, ...(c.secret ? { client_secret: c.secret } : {}) })
    if (!x.ok) {
      log('warn', 'salesforce:refresh-failed', { status: x.kind === 'http' ? x.status : x.kind })
      return null
    }
    const accessToken = typeof x.body['access_token'] === 'string' ? x.body['access_token'] : ''
    if (!accessToken) return null
    const next = { ...t, accessToken, instanceUrl: typeof x.body['instance_url'] === 'string' ? x.body['instance_url'] : t.instanceUrl }
    await saveTokens(ctx, next)
    return next
  }

  /** One API call with the bearer token; refreshes once on 401. */
  async function api(ctx: MainContext, path: string, init: { method?: string; body?: unknown; query?: Record<string, string> } = {}): Promise<Exchange> {
    let t = await tokens(ctx)
    if (!t) return { ok: false, kind: 'http', status: 401, body: {}, retryAfterMs: null }
    const http = providerHttp(ctx, 'integration', 'salesforce')
    const run = async (tok: Tokens): Promise<Exchange> => {
      await pace(`salesforce:${hostOf(tok.instanceUrl)}`, SALESFORCE.ratePerSec)
      const req = {
        method: init.method ?? 'GET',
        params: { host: hostOf(tok.instanceUrl), v: tok.apiVersion, path },
        ...(init.query ? { query: init.query } : {}),
        headers: { authorization: `Bearer ${tok.accessToken}`, accept: 'application/json', ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {})
      }
      // The four literal endpoint paths; `{path}` carries the object id.
      if (path === 'query') return exchange(() => http.fetch('https://{host}/services/data/v{v}/query', req))
      if (path === 'search') return exchange(() => http.fetch('https://{host}/services/data/v{v}/search', req))
      if (path === 'ContentNote') return exchange(() => http.fetch('https://{host}/services/data/v{v}/sobjects/ContentNote', req))
      if (path === 'ContentDocumentLink') return exchange(() => http.fetch('https://{host}/services/data/v{v}/sobjects/ContentDocumentLink', req))
      if (path === 'EventRelation') return exchange(() => http.fetch('https://{host}/services/data/v{v}/sobjects/EventRelation', req))
      if (path === 'Event') return exchange(() => http.fetch('https://{host}/services/data/v{v}/sobjects/Event', req))
      return exchange(() => http.fetch('https://{host}/services/data/v{v}/sobjects/Event/{path}', { ...req, params: { ...req.params, path: path.replace(/^Event\//, '') } }))
    }
    let x = await run(t)
    if (!x.ok && x.kind === 'http' && x.status === 401) {
      const next = await refresh(ctx, t)
      if (!next) return x
      t = next
      x = await run(t)
    }
    return x
  }

  async function query<T = Record<string, unknown>>(ctx: MainContext, soql: string): Promise<T[]> {
    const x = await api(ctx, 'query', { query: { q: soql } })
    if (!x.ok) throw new Error(copyFor(x))
    return (Array.isArray(x.body['records']) ? x.body['records'] : []) as T[]
  }

  async function suggestions(ctx: MainContext, noteId: string): Promise<IntegrationSearchResult[]> {
    const note = await ctx.storage.getNote(noteId)
    if (!note) return []
    const emails = (await matchSet(ctx, note)).emails.slice(0, 100)
    if (!emails.length) return []
    const list = emails.map(soqlQuote).join(', ')
    const out: IntegrationSearchResult[] = []
    const contacts = await query<{ Id: string; Name: string; Email: string; AccountId: string | null }>(ctx, `SELECT Id, Name, Email, AccountId FROM Contact WHERE Email IN (${list}) LIMIT 100`)
    for (const c of contacts) out.push({ provider: 'salesforce', kind: 'contact', id: c.Id, label: c.Name, subtitle: c.Email, suggested: true })
    const matched = new Set(contacts.map((c) => c.Email?.toLowerCase()))
    const rest = emails.filter((e) => !matched.has(e))
    if (rest.length) {
      const leads = await query<{ Id: string; Name: string; Email: string; Company: string | null }>(ctx, `SELECT Id, Name, Email, Company FROM Lead WHERE Email IN (${rest.map(soqlQuote).join(', ')}) LIMIT 100`)
      for (const l of leads) out.push({ provider: 'salesforce', kind: 'lead', id: l.Id, label: l.Name, subtitle: l.Email, suggested: true })
    }
    const accountIds = [...new Set(contacts.map((c) => c.AccountId).filter((x): x is string => !!x && SF_ID.test(x)))]
    if (accountIds.length) {
      const ids = accountIds.map(soqlQuote).join(', ')
      const accounts = await query<{ Id: string; Name: string }>(ctx, `SELECT Id, Name FROM Account WHERE Id IN (${ids})`)
      for (const a of accounts) out.push({ provider: 'salesforce', kind: 'account', id: a.Id, label: a.Name, subtitle: null, suggested: true })
      const opps = await query<{ Id: string; Name: string; AccountId: string }>(ctx, `SELECT Id, Name, AccountId FROM Opportunity WHERE AccountId IN (${ids}) AND IsClosed = false ORDER BY CloseDate DESC LIMIT 100`)
      const perAccount = new Map<string, number>()
      for (const o of opps) {
        const n = perAccount.get(o.AccountId) ?? 0
        if (n >= 5) continue
        perAccount.set(o.AccountId, n + 1)
        out.push({ provider: 'salesforce', kind: 'opportunity', id: o.Id, label: o.Name, subtitle: accounts.find((a) => a.Id === o.AccountId)?.Name ?? null, suggested: true })
      }
    }
    return out
  }

  async function typed(ctx: MainContext, text: string): Promise<IntegrationSearchResult[]> {
    const sosl = `FIND {${soslEscape(text)}*} IN NAME FIELDS RETURNING Contact(Id, Name, Email), Lead(Id, Name, Email), Account(Id, Name), Opportunity(Id, Name, AccountId) LIMIT 10`
    const x = await api(ctx, 'search', { query: { q: sosl } })
    if (!x.ok) throw new Error(copyFor(x))
    const rows = (Array.isArray(x.body['searchRecords']) ? x.body['searchRecords'] : []) as { attributes?: { type?: string }; Id: string; Name: string; Email?: string }[]
    const kind = (t: string | undefined): IntegrationSearchResult['kind'] | null => (t === 'Contact' ? 'contact' : t === 'Lead' ? 'lead' : t === 'Account' ? 'account' : t === 'Opportunity' ? 'opportunity' : null)
    return rows.flatMap((r) => {
      const k = kind(r.attributes?.type)
      return k ? [{ provider: 'salesforce' as const, kind: k, id: r.Id, label: r.Name, subtitle: r.Email ?? null, suggested: false }] : []
    })
  }

  async function save(ctx: MainContext, noteId: string, panelId: string | null, key: string): Promise<IntegrationSendOutcome> {
    const t = await tokens(ctx)
    if (!t) return { status: 'failed', retryable: false, errorCode: 'not_connected', errorMessage: SF_COPY.expired }
    const opts: SalesforceOptions = await ctx.settings.get('integrations.salesforce.options')
    if (opts.eventHandling === 'none' && !opts.contentNoteEnabled) return { status: 'failed', retryable: false, errorCode: 'nothing_configured', errorMessage: SF_COPY.nothing }
    const c = await noteContent(ctx, noteId, panelId)
    if (!c) return { status: 'failed', retryable: false, errorCode: 'no_content', errorMessage: 'This note has no summary to send.' }
    const targets = parseTargets(key)
    const of = (k: string): string[] => targets.filter((x) => x.kind === k && SF_ID.test(x.id)).map((x) => x.id)
    const contacts = of('contact')
    const leads = of('lead')
    const accounts = of('account')
    const opps = of('opportunity')
    const warnings: string[] = []
    let wrote = false
    const fail = (x: Exchange, code: string): IntegrationSendOutcome => {
      if (wrote) {
        warnings.push(copyFor(x))
        return { status: 'sent', warnings }
      }
      if (!x.ok && x.kind === 'uncertain') return { status: 'uncertain', errorMessage: SF_COPY.check }
      const retryable = !x.ok && (x.kind === 'network' || (x.kind === 'http' && (x.status === 429 || x.status >= 500)))
      return { status: 'failed', retryable, errorCode: !x.ok && x.kind === 'http' ? `http_${x.status}_${code}` : code, errorMessage: copyFor(x) }
    }

    let eventId: string | null = null
    if (opts.eventHandling !== 'none') {
      const startMs = Date.parse(c.start)
      const endMs = Math.min(c.end ? Date.parse(c.end) : startMs + 30 * 60_000, startMs + 14 * 86_400_000)
      const ev = c.note.linked_event
      const desc = opts.eventBodySource === 'event_description' && typeof ev?.['description'] === 'string' && ev['description'] ? String(ev['description']) : c.text
      const whatId = opts.eventWhatId === 'opportunity' ? (opps[0] ?? null) : opts.eventWhatId === 'account' ? (accounts[0] ?? null) : null
      const whoId = contacts[0] ?? leads[0] ?? null
      if (opts.eventHandling === 'match_else_create') {
        const conds = [`Subject = ${soqlQuote(c.title.slice(0, 255))}`, ...(contacts.length ? [`WhoId IN (${contacts.map(soqlQuote).join(', ')})`] : [])]
        try {
          const hits = await query<{ Id: string; WhatId: string | null }>(ctx, `SELECT Id, WhatId FROM Event WHERE StartDateTime = ${new Date(startMs).toISOString()} AND (${conds.join(' OR ')}) LIMIT 2`)
          if (hits.length === 1 && hits[0]) {
            const hit = hits[0]
            const x = await api(ctx, `Event/${hit.Id}`, { method: 'PATCH', body: { Description: desc.slice(0, 32_000), ...(whatId && !hit.WhatId ? { WhatId: whatId } : {}) } })
            if (!x.ok) return fail(x, 'event_update')
            eventId = hit.Id
            wrote = true
          }
        } catch {
          // No match query: create instead.
        }
      }
      if (!eventId) {
        const body: Record<string, unknown> = {
          Subject: c.title.slice(0, 255),
          StartDateTime: new Date(startMs).toISOString(),
          EndDateTime: new Date(endMs).toISOString(),
          Description: desc.slice(0, 32_000)
        }
        const loc = ev?.['location']
        if (typeof loc === 'string' && loc) body['Location'] = loc.slice(0, 255)
        if (whoId) body['WhoId'] = whoId
        if (whatId) body['WhatId'] = whatId
        const x = await api(ctx, 'Event', { method: 'POST', body })
        if (!x.ok) return fail(x, 'event')
        eventId = typeof x.body['id'] === 'string' ? x.body['id'] : null
        wrote = true
      }
      if (eventId) {
        for (const extra of contacts.slice(1)) {
          const x = await api(ctx, 'EventRelation', { method: 'POST', body: { EventId: eventId, RelationId: extra } })
          if (!x.ok) {
            warnings.push(SF_COPY.oneContact)
            break
          }
        }
      }
    }

    let docId: string | null = null
    if (opts.contentNoteEnabled) {
      const x = await api(ctx, 'ContentNote', { method: 'POST', body: { Title: c.title.slice(0, 255), Content: Buffer.from(crmHtml(c.html, c.lead), 'utf8').toString('base64') } })
      if (!x.ok) return fail(x, 'note')
      wrote = true
      docId = typeof x.body['id'] === 'string' ? x.body['id'] : null
      if (docId) {
        for (const rec of [...contacts, ...leads, ...accounts, ...opps]) {
          const l = await api(ctx, 'ContentDocumentLink', { method: 'POST', body: { ContentDocumentId: docId, LinkedEntityId: rec, ShareType: 'V', Visibility: 'AllUsers' } })
          if (!l.ok) warnings.push(copyFor(l))
        }
      }
    }
    const base = t.instanceUrl.replace(/\/$/, '')
    const externalId = eventId ?? docId ?? undefined
    const externalUrl = eventId ? `${base}/lightning/r/Event/${eventId}/view` : docId ? `${base}/lightning/r/ContentDocument/${docId}/view` : undefined
    log('info', 'salesforce:saved', { event: !!eventId, note: !!docId, warnings: warnings.length })
    return { status: 'sent', ...(externalId ? { externalId } : {}), ...(externalUrl ? { externalUrl } : {}), ...(warnings.length ? { warnings: [...new Set(warnings)] } : {}) }
  }

  return {
    provider: 'salesforce',
    credentialKinds: ['oauth-client'],
    async validate(ctx) {
      const t = await tokens(ctx)
      if (!t) return { state: 'not_configured', accountLabel: null, detail: (await client(ctx)) ? 'Consumer key saved. Connect to finish.' : null }
      const http = providerHttp(ctx, 'integration', 'salesforce')
      const get = (tok: Tokens): Promise<Exchange> => exchange(() => http.fetch('https://{host}/services/oauth2/userinfo', { params: { host: hostOf(tok.instanceUrl) }, headers: { authorization: `Bearer ${tok.accessToken}`, accept: 'application/json' } }))
      let x = await get(t)
      let tok = t
      if (!x.ok && x.kind === 'http' && x.status === 401) {
        const next = await refresh(ctx, t)
        if (!next) return { state: 'invalid', accountLabel: t.accountLabel, detail: SF_COPY.expired }
        tok = next
        x = await get(next)
      }
      if (!x.ok) return x.kind === 'http' && (x.status === 401 || x.status === 403) ? { state: 'invalid', accountLabel: t.accountLabel, detail: SF_COPY.expired } : { state: 'unreachable', accountLabel: t.accountLabel, detail: null }
      const email = typeof x.body['email'] === 'string' ? x.body['email'] : ''
      const label = [email, hostOf(tok.instanceUrl)].filter(Boolean).join(' · ') || null
      if (label !== tok.accountLabel) await saveTokens(ctx, { ...tok, accountLabel: label })
      return { state: 'connected', accountLabel: label, detail: null }
    },
    async setCredential(ctx, input) {
      const raw = typeof input.value === 'string' ? input.value.trim() : ''
      let key = raw
      let secret: string | undefined
      if (raw.startsWith('{')) {
        try {
          const o = JSON.parse(raw) as { key?: unknown; secret?: unknown }
          key = typeof o.key === 'string' ? o.key.trim() : ''
          secret = typeof o.secret === 'string' && o.secret.trim() ? o.secret.trim() : undefined
        } catch {
          key = ''
        }
      }
      if (!/^[A-Za-z0-9._]{20,256}$/.test(key)) throw expected(notulaError('invalid-input', 'Paste the Consumer Key from your External Client App.'))
      const { url } = normalizeSalesforceUrl(input.label)
      await ctx.secrets.set('integration.salesforce.client', encodeSecret({ key, ...(secret ? { secret } : {}), myDomain: url } satisfies Client))
    },
    async connectOAuth(ctx) {
      const c = await client(ctx)
      if (!c) throw expected(notulaError('missing-key', 'Paste your Consumer Key and Salesforce URL first.'))
      if (pending) throw expected(notulaError('busy', 'A Salesforce connection is already in progress'))
      const state = randomBytes(32).toString('base64url')
      const verifier = randomBytes(48).toString('base64url')
      const challenge = createHash('sha256').update(verifier).digest('base64url')
      let resolveCode!: (code: string) => void
      let rejectCode!: (e: Error) => void
      const result = new Promise<string>((res, rej) => {
        resolveCode = res
        rejectCode = rej
      })
      result.catch(() => undefined)
      const handler = (req: IncomingMessage, res: ServerResponse): void => {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1')
        if (req.method !== 'GET' || url.pathname !== SALESFORCE.callbackPath) {
          res.writeHead(404).end()
          return
        }
        if (url.searchParams.get('state') !== state) {
          res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(page('Something went wrong', 'This sign-in link is no longer valid. Return to Notula and try again.'))
          return
        }
        const code = url.searchParams.get('code')
        if (!code) {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Salesforce not connected', 'Notula did not get access to Salesforce. You can close this tab.'))
          rejectCode(expected(notulaError('provider-error', 'Access was not granted')))
          return
        }
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(page('Salesforce connected', 'You can close this tab and return to Notula.'))
        resolveCode(code)
      }
      const server = createServer(handler)
      await new Promise<void>((resolve, reject) => {
        server.once('error', () => reject(expected(notulaError('busy', SF_COPY.port))))
        server.listen(SALESFORCE.callbackPort, '127.0.0.1', () => resolve())
      })
      pending = { server, reject: rejectCode }
      const timer = setTimeout(() => rejectCode(expected(notulaError('provider-error', SF_COPY.timeout))), SALESFORCE.oauthTimeoutMs)
      try {
        const params = new URLSearchParams({ response_type: 'code', client_id: c.key, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', scope: 'api refresh_token', state })
        const authorizeUrl = `${c.myDomain}/services/oauth2/authorize?${params.toString()}`
        // Dev builds with the provider mock: the browser step is a plain request (no browser).
        const mocked = !app.isPackaged && devUrl(authorizeUrl) !== authorizeUrl
        if (mocked) void providerHttp(ctx, 'integration', 'salesforce').fetchUrl(devUrl(authorizeUrl), { redirect: 'follow' }).then((r) => r.body?.cancel()).catch(() => undefined)
        else {
          try {
            await shell.openExternal(authorizeUrl)
          } catch {
            throw expected(notulaError('provider-error', SF_COPY.start))
          }
        }
        log('info', 'salesforce:oauth-browser-opened', {})
        const code = await result
        const x = await tokenCall(ctx, c.myDomain, { grant_type: 'authorization_code', code, client_id: c.key, redirect_uri: REDIRECT, code_verifier: verifier, ...(c.secret ? { client_secret: c.secret } : {}) })
        if (!x.ok) throw expected(notulaError('provider-error', x.kind === 'local-only' ? 'local-only mode' : x.kind === 'http' ? 'Salesforce didn’t accept the sign-in. Check the app’s key and secret.' : 'Couldn’t reach Salesforce. Check your connection and try again.'))
        const b = x.body
        const tok: Tokens = {
          accessToken: typeof b['access_token'] === 'string' ? b['access_token'] : '',
          refreshToken: typeof b['refresh_token'] === 'string' ? b['refresh_token'] : '',
          instanceUrl: typeof b['instance_url'] === 'string' ? b['instance_url'] : c.myDomain,
          identityUrl: typeof b['id'] === 'string' ? b['id'] : '',
          apiVersion: '',
          accountLabel: null
        }
        if (!tok.accessToken || !tok.refreshToken) throw expected(notulaError('provider-error', 'Salesforce returned no sign-in. Check that the refresh_token scope is on.'))
        normalizeSalesforceUrl(tok.instanceUrl)
        // The highest API version listed, at least 58.0.
        const http = providerHttp(ctx, 'integration', 'salesforce')
        const v = await exchange(() => http.fetch('https://{host}/services/data/', { params: { host: hostOf(tok.instanceUrl) }, headers: { authorization: `Bearer ${tok.accessToken}`, accept: 'application/json' } }))
        const list = v.ok ? ((Array.isArray(v.body) ? v.body : v.body['value']) as { version?: string }[] | undefined) : undefined
        const versions = (list ?? []).map((r) => Number(r.version)).filter((n) => Number.isFinite(n)).sort((a, b2) => b2 - a)
        const best = versions[0]
        if (best === undefined || best < SALESFORCE.minApiVersion) throw expected(notulaError('provider-error', SF_COPY.tooOld))
        tok.apiVersion = best.toFixed(1)
        await saveTokens(ctx, tok)
        log('info', 'salesforce:connected', { apiVersion: tok.apiVersion })
      } finally {
        clearTimeout(timer)
        if (pending?.server === server) pending = null
        server.close()
      }
    },
    cancelOAuth() {
      if (!pending) return
      const p = pending
      pending = null
      p.reject(expected(notulaError('provider-error', 'Connection cancelled')))
      p.server.close()
    },
    async search(ctx, q) {
      const text = q.query?.trim() ?? ''
      try {
        if (text.length >= 3) return await typed(ctx, text)
        if (!text && q.noteId) return await suggestions(ctx, q.noteId)
        return []
      } catch (err) {
        log('warn', 'salesforce:search-failed', {})
        throw expected(notulaError('provider-error', err instanceof Error && err.message ? err.message : SF_COPY.generic))
      }
    },
    async share(_ctx, req) {
      const key = targetKey(req.targets, KINDS, SF_ID)
      if (!key) throw expected(notulaError('invalid-input', 'Pick Salesforce records to save to.'))
      return [manualRow('salesforce', req, key)]
    },
    async send(ctx, d) {
      return save(ctx, d.noteId, d.panelId, d.targetKey)
    },
    async folderTargets(ctx, noteId) {
      const s = await suggestions(ctx, noteId).catch(() => [] as IntegrationSearchResult[])
      if (!s.some((r) => r.kind === 'contact' || r.kind === 'lead')) return []
      const accounts = s.filter((r) => r.kind === 'account').slice(0, 1)
      const opps = s.filter((r) => r.kind === 'opportunity').slice(0, 1)
      const people = s.filter((r) => r.kind === 'contact' || r.kind === 'lead').slice(0, 10)
      const key = [...people, ...accounts, ...opps].map((r) => `${r.kind}:${r.id}`).join(',')
      const panels = await ctx.storage.listPanels(noteId)
      return [folderRow('salesforce', noteId, latestSummaryPanel(panels)?.id ?? null, key)]
    },
    async disconnect(ctx) {
      const t = await tokens(ctx)
      const c = await client(ctx)
      if (t && c) {
        const http = providerHttp(ctx, 'integration', 'salesforce')
        await exchange(() =>
          http.fetch('https://{host}/services/oauth2/revoke', {
            method: 'POST',
            params: { host: hostOf(c.myDomain) },
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ token: t.refreshToken }).toString()
          })
        ).catch(() => undefined)
      }
      await ctx.secrets.clear('integration.salesforce.tokens')
      await ctx.secrets.clear('integration.salesforce.client')
      log('info', 'salesforce:disconnected', {})
    }
  }
}
