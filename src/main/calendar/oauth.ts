// SPDX-License-Identifier: Apache-2.0
// Desktop OAuth for Google Calendar and Microsoft Graph, without a server: the user's own
// client, a loopback redirect plus PKCE S256, read-only
// scopes, refresh 60 s before expiry, Microsoft refresh-token rotation, Google revoke.
//
// Tokens never reach a log, an error message or a renderer. Error messages here are
// fixed texts; provider error *codes* (`invalid_grant`, …) are the only remote text kept.

import { createHash, randomBytes } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { app, shell } from 'electron'
import { CALENDAR_GRANT_SCOPES, CALENDAR_SYNC, type CalendarGrant, type OAuthCalendarProvider } from '@shared/types/calendar'
import { log } from '../log'
import type { OAuthClient } from './secrets'

export const GOOGLE_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly'
export const MICROSOFT_SCOPE = 'offline_access User.Read Calendars.Read'

const GRANT_ORDER: readonly CalendarGrant[] = ['calendar-write', 'mail-read', 'mail-send', 'files-read']

/**
 * The scope request for the read scope plus the held grants. On Microsoft
 * `Calendars.ReadWrite` replaces `Calendars.Read`.
 */
export function scopeFor(provider: OAuthCalendarProvider, grants: readonly CalendarGrant[]): string {
  const held = GRANT_ORDER.filter((g) => grants.includes(g))
  if (provider === 'google') return [GOOGLE_SCOPE, ...held.flatMap((g) => CALENDAR_GRANT_SCOPES[g].google)].join(' ')
  const base = held.includes('calendar-write') ? ['offline_access', 'User.Read'] : MICROSOFT_SCOPE.split(' ')
  return [...base, ...held.flatMap((g) => CALENDAR_GRANT_SCOPES[g].microsoft)].join(' ')
}

/** The grants a token response's `scope` covers (Graph may prefix `https://graph.microsoft.com/`). */
export function grantsFromScope(provider: OAuthCalendarProvider, scope: string): CalendarGrant[] {
  const have = new Set(
    scope
      .split(/\s+/)
      .filter(Boolean)
      .map((x) => (provider === 'microsoft' ? x.replace(/^https:\/\/graph\.microsoft\.com\//i, '').toLowerCase() : x))
  )
  return GRANT_ORDER.filter((g) => CALENDAR_GRANT_SCOPES[g][provider].every((x) => have.has(provider === 'microsoft' ? x.toLowerCase() : x)))
}

/** Options of a consent run: the grants to request and the account to pre-select. */
export interface ConsentOptions {
  grants?: readonly CalendarGrant[]
  /** Google `include_granted_scopes=true` (adding a grant; never on a turn-off). */
  incremental?: boolean
  loginHint?: string | null
}

/**
 * Dev builds only (`!app.isPackaged`): `NOTULA_DEV_CALENDAR_MOCK=http://127.0.0.1:<port>`
 * sends every Google and Microsoft request to that origin as `/<host><path>`, and the
 * browser step becomes a plain request that follows redirects, so the whole flow can run
 * against a local mock without registered clients or a browser.
 */
function devMock(): string | null {
  if (app.isPackaged) return null
  const v = process.env['NOTULA_DEV_CALENDAR_MOCK']?.trim()
  return v && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(v) ? v : null
}

export function isDevMock(): boolean {
  return devMock() !== null
}

/** The real URL, or its dev-mock equivalent. */
export function endpoint(url: string): string {
  const mock = devMock()
  if (!mock || url.startsWith(`${mock}/`)) return url
  const u = new URL(url)
  return `${mock}/${u.host}${u.pathname}${u.search}`
}

export interface CalendarRequestInit extends RequestInit {
  /** Appended as the query string. */
  query?: URLSearchParams | Record<string, string>
  /** `{name}` placeholders in the URL, each URI-encoded. */
  params?: Record<string, string>
}

function request(url: string, init: CalendarRequestInit = {}): Promise<Response> {
  const { query, params, ...rest } = init
  let full = url.replace(/\{(\w+)\}/g, (_m, name: string) => encodeURIComponent(params?.[name] ?? ''))
  const q = query ? new URLSearchParams(query).toString() : ''
  if (q) full += `${full.includes('?') ? '&' : '?'}${q}`
  return globalThis.fetch(endpoint(full), { signal: AbortSignal.timeout(30_000), ...rest })
}

/**
 * The only way calendar code reaches Google and Microsoft. Call sites pass the endpoint
 * as a literal, so every endpoint Notula calls can be found in the source;
 * `fetch` fills the path placeholders, appends the query and applies the dev mock.
 * `fetchUrl` takes an absolute URL the provider handed back (a next page).
 */
export const calendarHttp = {
  fetch: request,
  fetchUrl: (url: string, init: RequestInit = {}): Promise<Response> =>
    globalThis.fetch(endpoint(url), { signal: AbortSignal.timeout(30_000), ...init })
}

/** A provider or token failure with a fixed, user-safe message. */
export class OAuthError extends Error {
  constructor(
    readonly kind: 'denied' | 'timeout' | 'invalid_grant' | 'unauthorized' | 'forbidden' | 'rate_limited' | 'network' | 'provider',
    message: string,
    readonly status?: number
  ) {
    super(message)
  }
}

export interface TokenSet {
  accessToken: string
  refreshToken: string
  /** ms since the epoch. */
  expiresAt: number
  scope: string | null
}

const b64url = (buf: Buffer): string => buf.toString('base64url')

/** The close-the-tab page the loopback listener answers with. */
function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:15px/1.5 system-ui,-apple-system,'Segoe UI',sans-serif;display:grid;place-items:center;min-height:90vh;margin:0;color:#1b1b19;background:#fafaf9}
main{text-align:center;max-width:28rem;padding:2rem}h1{font-size:20px;margin:0 0 .5rem}p{margin:0;color:#5c5c57}</style></head>
<body><main><h1>${title}</h1><p>${body}</p></main></body></html>`
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve((server.address() as AddressInfo).port)
    })
  })
}

/** Step 3: the authorization page in the default browser (in dev-mock mode, a plain request). */
async function openAuthorization(provider: OAuthCalendarProvider, params: URLSearchParams): Promise<void> {
  if (isDevMock()) {
    const visit =
      provider === 'google'
        ? calendarHttp.fetch('https://accounts.google.com/o/oauth2/v2/auth', { query: params, redirect: 'follow' })
        : calendarHttp.fetch('https://login.microsoftonline.com/common/oauth2/v2.0/authorize', { query: params, redirect: 'follow' })
    void visit.then((r) => r.body?.cancel()).catch(() => undefined)
    return
  }
  await shell.openExternal(
    provider === 'google'
      ? `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
      : `https://login.microsoftonline.com/common/oauth2/v2.0/authorize?${params.toString()}`
  )
}

interface Redirect {
  code: string
}

/**
 * Runs the browser part of the flow (steps 1–5): a loopback listener, the authorization
 * URL, the redirect with the `state` check. Resolves the code and the redirect URI used.
 */
async function authorize(
  provider: OAuthCalendarProvider,
  client: OAuthClient,
  opts: ConsentOptions = {}
): Promise<{ code: string; redirectUri: string; verifier: string }> {
  const state = b64url(randomBytes(32))
  const verifier = b64url(randomBytes(48))
  const challenge = b64url(createHash('sha256').update(verifier).digest())

  const servers: Server[] = []
  let resolveRedirect!: (r: Redirect) => void
  let rejectRedirect!: (e: Error) => void
  const result = new Promise<Redirect>((resolve, reject) => {
    resolveRedirect = resolve
    rejectRedirect = reject
  })
  // A rejection before anyone awaits (the timeout, a denial) must not be unhandled.
  result.catch(() => undefined)
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const q = url.searchParams
    if (req.method !== 'GET' || (!q.has('code') && !q.has('error'))) {
      res.writeHead(404).end()
      return
    }
    if (q.get('state') !== state) {
      res.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(page('Something went wrong', 'This sign-in link is no longer valid. Return to Notula and try again.'))
      return
    }
    const error = q.get('error')
    const code = q.get('code')
    if (error || !code) {
      res
        .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        .end(page('Calendar not connected', 'Notula did not get access to your calendar. You can close this tab.'))
      rejectRedirect(
        error === 'access_denied' || error === 'consent_required'
          ? new OAuthError('denied', 'Access was not granted')
          : new OAuthError('provider', 'The provider refused the sign-in')
      )
      return
    }
    res
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      .end(page('Calendar connected', 'You can close this tab and return to Notula.'))
    resolveRedirect({ code })
  }

  const first = createServer(handler)
  servers.push(first)
  const port = await listen(first, 0, '127.0.0.1')
  let redirectUri = `http://127.0.0.1:${port}`
  if (provider === 'microsoft') {
    // Microsoft matches `http://localhost` and ignores the port; localhost may resolve to either address.
    const second = createServer(handler)
    try {
      await listen(second, port, '::1')
      servers.push(second)
    } catch {
      second.close()
    }
    redirectUri = `http://localhost:${port}`
  }

  const params = new URLSearchParams({
    client_id: client.clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: scopeFor(provider, opts.grants ?? []),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  })
  if (provider === 'google') {
    params.set('access_type', 'offline')
    params.set('prompt', 'consent')
    if (opts.incremental) params.set('include_granted_scopes', 'true')
  } else {
    params.set('response_mode', 'query')
  }
  if (opts.loginHint) params.set('login_hint', opts.loginHint)

  const timer = setTimeout(() => rejectRedirect(new OAuthError('timeout', 'Connection timed out')), CALENDAR_SYNC.oauthTimeoutMs)
  try {
    await openAuthorization(provider, params)
    log('info', 'calendar:oauth-browser-opened', { provider })
    const { code } = await result
    return { code, redirectUri, verifier }
  } finally {
    clearTimeout(timer)
    for (const s of servers) s.close()
  }
}

/** The token endpoint, by provider. */
function postToken(provider: OAuthCalendarProvider, form: Record<string, string>): Promise<Response> {
  const init: CalendarRequestInit = {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body: new URLSearchParams(form).toString()
  }
  return provider === 'google'
    ? calendarHttp.fetch('https://oauth2.googleapis.com/token', init)
    : calendarHttp.fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', init)
}

async function tokenRequest(provider: OAuthCalendarProvider, form: Record<string, string>): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await postToken(provider, form)
  } catch {
    throw new OAuthError('network', 'The sign-in service could not be reached')
  }
  let body: Record<string, unknown> = {}
  try {
    body = (await res.json()) as Record<string, unknown>
  } catch {
    // An empty or non-JSON body: the status decides.
  }
  if (!res.ok) {
    const code = typeof body['error'] === 'string' ? body['error'] : ''
    if (code === 'invalid_grant') throw new OAuthError('invalid_grant', 'The sign-in has expired', res.status)
    if (res.status === 401 || code === 'invalid_client' || code === 'unauthorized_client') {
      throw new OAuthError('provider', 'The client ID or secret was not accepted', res.status)
    }
    throw new OAuthError('provider', `The sign-in service answered HTTP ${res.status}${code ? ` (${code.slice(0, 40)})` : ''}`, res.status)
  }
  return body
}

function tokenSet(body: Record<string, unknown>, previousRefresh: string | null): TokenSet {
  const accessToken = typeof body['access_token'] === 'string' ? body['access_token'] : ''
  const refreshToken = typeof body['refresh_token'] === 'string' && body['refresh_token'] ? body['refresh_token'] : previousRefresh
  const expiresIn = Number(body['expires_in'] ?? 3_600)
  if (!accessToken) throw new OAuthError('provider', 'The sign-in service returned no access token')
  if (!refreshToken) throw new OAuthError('provider', 'The sign-in service returned no refresh token')
  return {
    accessToken,
    refreshToken,
    expiresAt: Date.now() + (Number.isFinite(expiresIn) ? expiresIn : 3_600) * 1000,
    scope: typeof body['scope'] === 'string' ? body['scope'] : null
  }
}

/** The whole connect flow: browser, redirect, code exchange (with the PKCE verifier). */
export async function connectOAuth(provider: OAuthCalendarProvider, client: OAuthClient, opts: ConsentOptions = {}): Promise<TokenSet> {
  const { code, redirectUri, verifier } = await authorize(provider, client, opts)
  const form: Record<string, string> = {
    client_id: client.clientId,
    code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  }
  if (provider === 'google' && client.clientSecret) form['client_secret'] = client.clientSecret
  if (provider === 'microsoft') form['scope'] = scopeFor(provider, opts.grants ?? [])
  const tokens = tokenSet(await tokenRequest(provider, form), null)
  if (provider === 'google' && tokens.scope && !tokens.scope.split(/\s+/).includes(GOOGLE_SCOPE)) {
    throw new OAuthError('denied', 'Access was not granted')
  }
  log('info', 'calendar:oauth-connected', { provider })
  return tokens
}

/**
 * A refresh; Microsoft may rotate the refresh token, which then replaces the old one. Microsoft
 * issues an access token for the scopes asked, so the held grants are asked again.
 */
export async function refreshOAuth(provider: OAuthCalendarProvider, client: OAuthClient, refreshToken: string, grants: readonly CalendarGrant[] = []): Promise<TokenSet> {
  const form: Record<string, string> = { client_id: client.clientId, grant_type: 'refresh_token', refresh_token: refreshToken }
  if (provider === 'google' && client.clientSecret) form['client_secret'] = client.clientSecret
  if (provider === 'microsoft') form['scope'] = scopeFor(provider, grants)
  return tokenSet(await tokenRequest(provider, form), refreshToken)
}

/** Google only (Microsoft has no revoke endpoint). Best effort. */
export async function revokeGoogle(token: string): Promise<void> {
  try {
    await calendarHttp.fetch('https://oauth2.googleapis.com/revoke', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token }).toString(),
      signal: AbortSignal.timeout(15_000)
    })
  } catch {
    log('warn', 'calendar:revoke-failed', { provider: 'google' })
  }
}

/** Bearer headers for an API call. */
export function bearer(accessToken: string, extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${accessToken}`, accept: 'application/json', ...extra }
}

/** Google's 403 reasons for a quota or rate limit: transient, not a missing permission. */
const RATE_LIMIT_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded']

/** The `reason` of a Google error body (`error.errors[0].reason`), or null. */
async function errorReason(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { errors?: { reason?: unknown }[] } }
    const reason = body?.error?.errors?.[0]?.reason
    return typeof reason === 'string' ? reason : null
  } catch {
    return null
  }
}

/**
 * The JSON of an API response; 401 → `unauthorized`; 429, or a 403 whose reason is a rate
 * or quota limit → `rate_limited`; any other 403 → `forbidden`.
 */
export async function readJson(request: Promise<Response>): Promise<Record<string, unknown>> {
  let res: Response
  try {
    res = await request
  } catch {
    throw new OAuthError('network', 'The calendar service could not be reached')
  }
  if (!res.ok) {
    const reason = res.status === 403 ? await errorReason(res) : null
    await res.body?.cancel().catch(() => undefined)
    if (res.status === 401) throw new OAuthError('unauthorized', 'The calendar service refused the sign-in', 401)
    if (res.status === 429 || (reason !== null && RATE_LIMIT_REASONS.includes(reason))) {
      throw new OAuthError('rate_limited', 'The calendar service asked Notula to slow down', res.status)
    }
    if (res.status === 403) throw new OAuthError('forbidden', 'The calendar service refused access', 403)
    throw new OAuthError('provider', `The calendar service answered HTTP ${res.status}`, res.status)
  }
  try {
    return (await res.json()) as Record<string, unknown>
  } catch {
    throw new OAuthError('provider', 'The calendar service returned unreadable data')
  }
}
