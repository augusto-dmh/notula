// SPDX-License-Identifier: Apache-2.0
// The integrations' request policy: Electron `net.fetch` (system proxy),
// a 20 s timeout, the read and write retry rules, `Retry-After`, and per-provider pacing.
//
// Call sites pass each endpoint as a literal to `integrationsHttp.fetch`, so every endpoint
// Notula calls can be found in the source. `{name}` placeholders are filled
// URI-encoded and `query` is appended. Webhook and hook URLs go through `fetchUrl`.
//
// Dev builds only (`!app.isPackaged`): `NOTULA_DEV_INTEGRATIONS_MOCK=http://127.0.0.1:<port>`
// sends every provider request to that origin as `/<host><path>`, and
// `NOTULA_DEV_INTEGRATIONS_TIMEOUT_MS` shortens the timeout, so the outbox can be shown
// against local fixture servers. Nothing here logs a URL, a header or a body.

import { app, net } from 'electron'
import { INTEGRATION_POLICY } from '@shared/types/integrations'

export type RequestKind = 'read' | 'write'

export interface HttpInit {
  method?: 'GET' | 'POST' | 'PATCH'
  headers?: Record<string, string>
  /** Serialized as JSON with `Content-Type: application/json`. */
  json?: unknown
  query?: Record<string, string | number | boolean | undefined>
  params?: Record<string, string>
  kind: RequestKind
  /** A pacing key such as `slack:write` or `notion`; requests on one key are spaced. */
  pace?: { key: string; intervalMs: number; concurrency?: number }
}

/** What an exchange ended with, after the policy's own retries. */
export type HttpResult =
  | { ok: true; status: number; headers: Headers; text: string }
  | { ok: false; kind: 'http'; status: number; headers: Headers; text: string; retryAfterMs: number | null }
  /** A connection failure before the request was sent: always safe to retry later. */
  | { ok: false; kind: 'network'; code: string }
  /** A timeout or a reset after the body may have reached the provider. */
  | { ok: false; kind: 'uncertain'; code: string }
  /** `Retry-After` above the 60 s cap: the scheduler retries later. */
  | { ok: false; kind: 'rate_limited'; status: number; retryAfterMs: number }

function devMock(): string | null {
  if (app.isPackaged) return null
  const v = process.env['NOTULA_DEV_INTEGRATIONS_MOCK']?.trim()
  return v && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(v) ? v : null
}

function timeoutMs(): number {
  if (!app.isPackaged) {
    const v = Number(process.env['NOTULA_DEV_INTEGRATIONS_TIMEOUT_MS'])
    if (Number.isFinite(v) && v >= 200 && v <= INTEGRATION_POLICY.timeoutMs) return v
  }
  return INTEGRATION_POLICY.timeoutMs
}

function backoffMs(): readonly number[] {
  // Dev fixture runs keep the same shape at a tenth of the wait.
  return devMock() ? INTEGRATION_POLICY.backoffMs.map((v) => v / 10) : INTEGRATION_POLICY.backoffMs
}

function resolve(url: string): string {
  const mock = devMock()
  if (!mock || url.startsWith(`${mock}/`)) return url
  const u = new URL(url)
  return `${mock}/${u.host}${u.pathname}${u.search}`
}

// ---------- pacing: one queue per key, spaced, with a concurrency cap ----------

interface Lane {
  next: number
  active: number
  waiting: (() => void)[]
}
const lanes = new Map<string, Lane>()

async function acquire(p: NonNullable<HttpInit['pace']>): Promise<() => void> {
  let lane = lanes.get(p.key)
  if (!lane) {
    lane = { next: 0, active: 0, waiting: [] }
    lanes.set(p.key, lane)
  }
  const l = lane
  const cap = Math.max(1, p.concurrency ?? 8)
  while (l.active >= cap) await new Promise<void>((r) => l.waiting.push(r))
  l.active++
  const now = Date.now()
  const at = Math.max(now, l.next)
  l.next = at + p.intervalMs
  if (at > now) await sleep(at - now)
  return () => {
    l.active--
    l.waiting.shift()?.()
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function jitter(ms: number): number {
  const j = INTEGRATION_POLICY.jitter
  return Math.round(ms * (1 - j + Math.random() * 2 * j))
}

/** `Retry-After` in seconds or as an HTTP date; null when absent or unreadable. */
export function retryAfter(headers: Headers): number | null {
  const v = headers.get('retry-after')?.trim()
  if (!v) return null
  if (/^\d+(\.\d+)?$/.test(v)) return Math.round(Number(v) * 1000)
  const t = Date.parse(v)
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : null
}

const READ_RETRY = new Set([429, 500, 502, 503, 504])
const WRITE_RETRY = new Set([429, 502, 503, 504])
/** Chromium net errors raised before anything was sent. */
const NOT_SENT = /ERR_(NAME_NOT_RESOLVED|NAME_RESOLUTION_FAILED|INTERNET_DISCONNECTED|CONNECTION_REFUSED|ADDRESS_UNREACHABLE|ADDRESS_INVALID|NETWORK_CHANGED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|CONNECTION_FAILED|NETWORK_ACCESS_DENIED|CERT_[A-Z_]+|SSL_[A-Z_]+|BLOCKED_[A-Z_]+)|ENOTFOUND|ECONNREFUSED|EAI_AGAIN/

/** A short, URL-free code for an exception thrown by fetch. */
function errorCode(err: unknown): string {
  const m = /net::ERR_[A-Z_]+|E[A-Z]{3,}/.exec(err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? '')}` : String(err))
  return m ? m[0].replace('net::', '') : 'ERR_FAILED'
}

async function once(url: string, init: HttpInit): Promise<HttpResult> {
  const headers: Record<string, string> = { Accept: 'application/json', ...init.headers }
  let body: string | undefined
  if (init.json !== undefined) {
    headers['Content-Type'] = 'application/json'
    body = JSON.stringify(init.json)
  }
  const ac = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    ac.abort()
  }, timeoutMs())
  try {
    const res = await net.fetch(resolve(url), { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, signal: ac.signal, redirect: 'error' })
    const text = await res.text()
    if (res.ok) return { ok: true, status: res.status, headers: res.headers, text }
    return { ok: false, kind: 'http', status: res.status, headers: res.headers, text, retryAfterMs: retryAfter(res.headers) }
  } catch (err) {
    if (timedOut) return { ok: false, kind: init.kind === 'write' ? 'uncertain' : 'network', code: 'timeout' }
    const code = errorCode(err)
    if (init.kind === 'write' && !NOT_SENT.test(code)) return { ok: false, kind: 'uncertain', code }
    return { ok: false, kind: 'network', code }
  } finally {
    clearTimeout(timer)
  }
}

async function exchange(url: string, init: HttpInit): Promise<HttpResult> {
  const waits = backoffMs()
  let last: HttpResult | null = null
  for (let attempt = 0; attempt <= INTEGRATION_POLICY.maxRetries; attempt++) {
    const release = init.pace ? await acquire(init.pace) : () => {}
    try {
      last = await once(url, init)
    } finally {
      release()
    }
    if (last.ok || last.kind === 'uncertain') return last
    let wait: number | null = null
    if (last.kind === 'network') wait = jitter(waits[Math.min(attempt, waits.length - 1)] ?? 4_000)
    else if (last.kind === 'http') {
      const retryable = (init.kind === 'read' ? READ_RETRY : WRITE_RETRY).has(last.status)
      if (!retryable) return last
      if (last.retryAfterMs !== null) {
        if (last.retryAfterMs > INTEGRATION_POLICY.retryAfterCapMs) {
          return { ok: false, kind: 'rate_limited', status: last.status, retryAfterMs: last.retryAfterMs }
        }
        wait = last.retryAfterMs
      } else wait = jitter(waits[Math.min(attempt, waits.length - 1)] ?? 4_000)
    }
    if (attempt === INTEGRATION_POLICY.maxRetries || wait === null) break
    await sleep(wait)
  }
  return last as HttpResult
}

function fill(url: string, init: HttpInit): string {
  let full = url.replace(/\{(\w+)\}/g, (_m, name: string) => encodeURIComponent(init.params?.[name] ?? ''))
  const q = new URLSearchParams()
  for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) q.set(k, String(v))
  const qs = q.toString()
  if (qs) full += `${full.includes('?') ? '&' : '?'}${qs}`
  return full
}

export const integrationsHttp = {
  /** A provider endpoint, passed as a literal. */
  fetch: (url: string, init: HttpInit): Promise<HttpResult> => exchange(fill(url, init), init),
  /** A user-supplied webhook or hook URL, already validated against its prefix. */
  fetchUrl: (url: string, init: HttpInit): Promise<HttpResult> => exchange(url, init)
}

export function parseBody(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
