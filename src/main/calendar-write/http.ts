// SPDX-License-Identifier: Apache-2.0
// The one way the calendar-write, mail and file-connector code reaches Google, Microsoft Graph
// and Dropbox, under the integrations' request policy. Every call goes through `egressFetch`
// with its guard kind, so local-only mode refuses it before any socket opens. Call sites pass
// the endpoint as a literal to `<http>.fetch(...)`, so every endpoint Notula calls can be found
// in the source; `{name}` placeholders are filled here and the query appended.
//
// Dev builds only (`!app.isPackaged`): `NOTULA_DEV_PROVIDER_MOCK=http://127.0.0.1:<port>` sends
// every request to that origin as `/<host><path>?<query>` (the same layout as the calendar's
// NOTULA_DEV_CALENDAR_MOCK), so the flows run against a local fixture server. No real provider
// endpoint is ever needed to exercise them.
//
// Nothing here logs a URL, a query, a body or a token.

import { app } from 'electron'
import type { MainContext } from '../context'
import { egressFetch } from '../net/egress'

export type ProviderKind = 'calendar' | 'integration'

export interface ProviderRequestInit extends RequestInit {
  /** Appended as the query string. */
  query?: URLSearchParams | Record<string, string>
  /** `{name}` placeholders in the URL, each URI-encoded. */
  params?: Record<string, string>
  /** Default 30 s. */
  timeoutMs?: number
}

function devMock(): string | null {
  if (app.isPackaged) return null
  const v = process.env['NOTULA_DEV_PROVIDER_MOCK']?.trim()
  return v && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(v) ? v : null
}

/** The real URL, or its dev-mock equivalent. */
export function devUrl(url: string): string {
  const mock = devMock()
  if (!mock || url.startsWith(`${mock}/`)) return url
  const u = new URL(url)
  return `${mock}/${u.host}${u.pathname}${u.search}`
}

export interface ProviderHttp {
  fetch(url: string, init?: ProviderRequestInit): Promise<Response>
  /** An absolute URL the provider handed back (a next page, a download redirect). */
  fetchUrl(url: string, init?: ProviderRequestInit): Promise<Response>
}

export function providerHttp(ctx: Pick<MainContext, 'settings'>, kind: ProviderKind, caller: string): ProviderHttp {
  const run = (full: string, init: ProviderRequestInit): Promise<Response> => {
    const { query: _q, params: _p, timeoutMs, ...rest } = init
    return egressFetch(ctx, { kind }, devUrl(full), { signal: AbortSignal.timeout(timeoutMs ?? 30_000), ...rest }, caller)
  }
  return {
    fetch(url, init = {}) {
      let full = url.replace(/\{(\w+)\}/g, (_m, name: string) => encodeURIComponent(init.params?.[name] ?? ''))
      const q = init.query ? new URLSearchParams(init.query).toString() : ''
      if (q) full += `${full.includes('?') ? '&' : '?'}${q}`
      return run(full, init)
    },
    fetchUrl(url, init = {}) {
      return run(url, init)
    }
  }
}

/** One provider exchange's outcome. */
export type Exchange =
  | { ok: true; status: number; body: Record<string, unknown>; headers: Headers }
  | { ok: false; kind: 'local-only' }
  /** Nothing reached the provider (refused, no DNS, offline). */
  | { ok: false; kind: 'network' }
  /** The request may have arrived: a timeout or a reset after sending. */
  | { ok: false; kind: 'uncertain' }
  | { ok: false; kind: 'http'; status: number; body: Record<string, unknown>; retryAfterMs: number | null }

const BEFORE_SEND = /ERR_(CONNECTION_REFUSED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE|NETWORK_CHANGED|PROXY_CONNECTION_FAILED)|ECONNREFUSED|ENOTFOUND|EAI_AGAIN/

/** Runs a request and reads its JSON (an empty or non-JSON body reads as `{}`). */
export async function exchange(request: () => Promise<Response>): Promise<Exchange> {
  let res: Response
  try {
    res = await request()
  } catch (err) {
    const msg = err instanceof Error ? `${err.name} ${err.message}` : ''
    if (msg.includes('local-only mode')) return { ok: false, kind: 'local-only' }
    if (BEFORE_SEND.test(msg)) return { ok: false, kind: 'network' }
    return { ok: false, kind: 'uncertain' }
  }
  let body: Record<string, unknown> = {}
  try {
    const text = await res.text()
    if (text) {
      const parsed = JSON.parse(text) as unknown
      body = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : { value: parsed }
    }
  } catch {
    // A non-JSON body: the status decides.
  }
  if (res.ok) return { ok: true, status: res.status, body, headers: res.headers }
  const ra = Number(res.headers.get('retry-after'))
  return { ok: false, kind: 'http', status: res.status, body, retryAfterMs: Number.isFinite(ra) && ra > 0 ? ra * 1000 : null }
}

/** Reads at most `max` bytes of a body; null when it is larger. */
export async function readCapped(res: Response, max: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined)
    return null
  }
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const parts: Buffer[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => undefined)
      return null
    }
    parts.push(Buffer.from(value))
  }
  return Buffer.concat(parts)
}

/** Google's error reason (`error.errors[0].reason` or `error.status`), Graph's `error.code`. */
export function errorReason(body: Record<string, unknown>): string | null {
  const e = body['error']
  if (typeof e === 'string') return e
  if (!e || typeof e !== 'object') return null
  const o = e as { errors?: { reason?: unknown }[]; status?: unknown; code?: unknown }
  const r = o.errors?.[0]?.reason ?? o.status ?? o.code
  return typeof r === 'string' ? r : null
}

/** A 403 that means a missing permission (not a rate or quota limit). */
export function insufficientScope(x: Exchange): boolean {
  if (x.ok || x.kind !== 'http' || x.status !== 403) return false
  const r = errorReason(x.body) ?? ''
  return !/rate|quota|limit/i.test(r)
}
