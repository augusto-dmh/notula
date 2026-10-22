// SPDX-License-Identifier: Apache-2.0
// ICS feeds (the baseline calendar source: it needs no server and no account): the URL and the
// fetch. Parsing and recurrence expansion are in ics-parse.ts and run only in the
// notula-ics utility process (ics-host.ts), never on main.
//
// The feed URL is a secret: it never reaches a log, an error message or the renderer.
// Errors carry a reason without the URL; logs carry the host only.

import { CALENDAR_SYNC } from '@shared/types/calendar'

/** A feed failure. `reason` is shown inline in Settings ("Couldn't read this calendar: <reason>"). */
export class IcsError extends Error {
  constructor(
    readonly type: 'fetch_failed' | 'invalid_feed',
    readonly reason: string
  ) {
    super(reason)
  }
}

// ---------- the URL ----------

export interface FeedUrl {
  url: string
  host: string
  insecure: boolean
}

/** `webcal://` → `https://`; only http(s) (plain http is accepted with a warning). */
export function normalizeFeedUrl(raw: unknown): FeedUrl {
  if (typeof raw !== 'string') throw new IcsError('invalid_feed', 'enter the calendar’s address')
  let text = raw.trim()
  if (!text) throw new IcsError('invalid_feed', 'enter the calendar’s address')
  if (text.length > 4_096) throw new IcsError('invalid_feed', 'the address is too long')
  text = text.replace(/^webcals?:\/\//i, 'https://')
  let u: URL
  try {
    u = new URL(text)
  } catch {
    throw new IcsError('invalid_feed', 'that is not a web address')
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new IcsError('invalid_feed', 'the address must start with https://')
  if (!u.hostname) throw new IcsError('invalid_feed', 'that is not a web address')
  return { url: u.toString(), host: u.hostname.toLowerCase(), insecure: u.protocol === 'http:' }
}

// ---------- fetching ----------

/** `insecure`: the body came over plain http, typed or reached through a redirect. */
export type IcsFetch =
  | { status: 'ok'; bytes: Uint8Array; etag: string | null; lastModified: string | null; insecure: boolean }
  | { status: 'not-modified'; insecure: boolean }

/**
 * GET with up to 5 redirects, a 30 s timeout and a 20 MB cap. The validators are sent
 * only when the caller still holds the body they belong to (a 304 re-expands it).
 */
export async function fetchIcs(url: string, validators: { etag: string | null; lastModified: string | null } | null): Promise<IcsFetch> {
  const signal = AbortSignal.timeout(CALENDAR_SYNC.icsTimeoutMs)
  let current = url
  try {
    for (let hop = 0; ; hop++) {
      const headers: Record<string, string> = { accept: 'text/calendar, text/plain;q=0.9, */*;q=0.5', 'user-agent': 'Notula calendar sync' }
      if (validators?.etag) headers['if-none-match'] = validators.etag
      if (validators?.lastModified) headers['if-modified-since'] = validators.lastModified
      const res = await fetch(current, { headers, redirect: 'manual', signal })
      if (res.status >= 300 && res.status < 400 && res.status !== 304) {
        const location = res.headers.get('location')
        await res.body?.cancel().catch(() => undefined)
        if (!location) throw new IcsError('fetch_failed', `the server answered HTTP ${res.status} without a new address`)
        if (hop >= CALENDAR_SYNC.icsMaxRedirects) throw new IcsError('fetch_failed', 'the address redirected too many times')
        const next = new URL(location, current)
        if (next.protocol !== 'https:' && next.protocol !== 'http:') throw new IcsError('fetch_failed', 'the address redirected somewhere unsupported')
        current = next.toString()
        continue
      }
      const insecure = new URL(current).protocol === 'http:'
      if (res.status === 304) {
        await res.body?.cancel().catch(() => undefined)
        return { status: 'not-modified', insecure }
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined)
        const hint = res.status === 401 || res.status === 403 ? ' (the address may be private or expired)' : res.status === 404 ? ' (not found)' : ''
        throw new IcsError('fetch_failed', `the server answered HTTP ${res.status}${hint}`)
      }
      const declared = Number(res.headers.get('content-length') ?? NaN)
      if (Number.isFinite(declared) && declared > CALENDAR_SYNC.icsMaxBytes) {
        await res.body?.cancel().catch(() => undefined)
        throw new IcsError('fetch_failed', 'the calendar is larger than 20 MB')
      }
      const bytes = await readCapped(res)
      // A body shorter than its declared length was cut off. Only checkable when the
      // body arrives unencoded: fetch decodes gzip, and the length is then the encoded one.
      const encoding = (res.headers.get('content-encoding') ?? 'identity').trim().toLowerCase()
      if (Number.isFinite(declared) && encoding === 'identity' && bytes.byteLength !== declared) {
        throw new IcsError('fetch_failed', 'the calendar arrived incomplete')
      }
      return { status: 'ok', bytes, etag: res.headers.get('etag'), lastModified: res.headers.get('last-modified'), insecure }
    }
  } catch (err) {
    if (err instanceof IcsError) throw err
    if (signal.aborted) throw new IcsError('fetch_failed', 'the request timed out')
    throw new IcsError('fetch_failed', 'the calendar could not be reached')
  }
}

/** The body as bytes: the parse process decodes it, so a 20 MB decode never runs on main. */
async function readCapped(res: Response): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0)
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > CALENDAR_SYNC.icsMaxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new IcsError('fetch_failed', 'the calendar is larger than 20 MB')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks)
}
