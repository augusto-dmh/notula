// SPDX-License-Identifier: Apache-2.0
// The opt-in company icon: the company's own
// `https://<domain>/favicon.ico`, the location the HTML standard defines when a page
// declares no icon. Fetched in main only, never by the renderer, and only while
// `companies.faviconsEnabled` is on. No page is loaded or parsed, no cookies or
// credentials go with it, and nothing else is requested.
//
// Rules: HTTPS only; 5 s for the whole request; at most 3 redirects, each to the domain
// or a subdomain of it; a raster image (ICO, PNG, JPEG, GIF or WebP; never SVG) of at most
// 100 KB that decodes. Successes are kept 30 days, failures 7; at most 4 fetches at once.

import { nativeImage } from 'electron'
import { COMPANY_ICON_LIMITS as L, type CompanyIcon } from '@shared/types/people'
import { isGenericDomain, isResourceEmail } from '@shared/lib/people'
import type { MainContext } from '../context'
import { log } from '../log'
import { egressBlocked, LOCAL_ONLY_REASON } from '../privacy'

const DOMAIN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/

export function validDomain(v: unknown): string | null {
  const d = typeof v === 'string' ? v.trim().toLowerCase() : ''
  return d && d.length <= 253 && DOMAIN.test(d) ? d : null
}

/** The image type from the first bytes; null for anything else (SVG included). */
function sniff(b: Buffer): string | null {
  if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'image/x-icon'
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  if (b.length >= 6 && (b.subarray(0, 6).toString('ascii') === 'GIF87a' || b.subarray(0, 6).toString('ascii') === 'GIF89a')) return 'image/gif'
  if (b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp'
  return null
}

/** The body, or null past the cap. */
async function readCapped(res: Response, cap: number): Promise<Buffer | null> {
  const declared = Number(res.headers.get('content-length') ?? '')
  if (Number.isFinite(declared) && declared > cap) return null
  if (!res.body) return Buffer.alloc(0)
  const chunks: Buffer[] = []
  let size = 0
  const reader = res.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > cap) {
        await reader.cancel().catch(() => undefined)
        return null
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
}

function onDomain(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`)
}

/** One icon, or the reason it was refused (logged without the image). */
async function fetchIcon(domain: string): Promise<{ icon: CompanyIcon } | { reason: string }> {
  const signal = AbortSignal.timeout(L.timeoutMs)
  let url = `https://${domain}/favicon.ico`
  for (let hop = 0; hop <= L.maxRedirects; hop++) {
    let res: Response
    try {
      res = await fetch(url, { redirect: 'manual', credentials: 'omit', headers: { Accept: 'image/*' }, signal })
    } catch (err) {
      return { reason: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'network' }
    }
    if (res.status >= 300 && res.status < 400) {
      await res.body?.cancel().catch(() => undefined)
      const location = res.headers.get('location')
      if (!location) return { reason: 'redirect-without-location' }
      let next: URL
      try {
        next = new URL(location, url)
      } catch {
        return { reason: 'bad-redirect' }
      }
      if (next.protocol !== 'https:') return { reason: 'redirect-not-https' }
      if (!onDomain(next.hostname.toLowerCase(), domain)) return { reason: 'redirect-off-domain' }
      url = next.href
      continue
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => undefined)
      return { reason: `http-${res.status}` }
    }
    const bytes = await readCapped(res, L.maxBytes).catch(() => null)
    if (!bytes) return { reason: 'too-large' }
    const mimeType = sniff(bytes)
    if (!mimeType) return { reason: 'not-a-raster-image' }
    // nativeImage decodes PNG and JPEG everywhere; ICO, GIF and WebP fall back to the tile in the renderer if they fail.
    if ((mimeType === 'image/png' || mimeType === 'image/jpeg') && nativeImage.createFromBuffer(bytes).isEmpty()) return { reason: 'undecodable' }
    return { icon: { mimeType, bytes: new Uint8Array(bytes) } }
  }
  return { reason: 'too-many-redirects' }
}

export class CompanyIcons {
  private readonly inflight = new Map<string, Promise<CompanyIcon | null>>()
  private running = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly ctx: MainContext) {}

  /** The cached icon, fetching it first when the cache is empty or stale. Null: show the initials tile. */
  async get(raw: string): Promise<CompanyIcon | null> {
    const domain = validDomain(raw)
    if (!domain) return null
    const s = await this.ctx.settings.getAll()
    if (!s['companies.faviconsEnabled']) return null
    // Never for webmail or calendar-resource domains.
    if (isGenericDomain(domain, s['people.genericEmailDomains']) || isResourceEmail(`x@${domain}`)) return null
    const row = await this.ctx.storage.getCompanyIcon(domain).catch(() => null)
    const age = row ? Date.now() - Date.parse(row.fetched_at) : Infinity
    const cached: CompanyIcon | null = row?.status === 'ok' && row.bytes && row.mime_type ? { mimeType: row.mime_type, bytes: row.bytes } : null
    if (row?.status === 'ok' && age < L.refreshOkMs) return cached
    if (row?.status === 'failed' && age < L.retryFailedMs) return null
    if (await egressBlocked(this.ctx, { kind: 'favicon' })) {
      log('info', 'companies:icon-blocked', { reason: LOCAL_ONLY_REASON })
      return cached
    }
    let p = this.inflight.get(domain)
    if (!p) {
      p = this.limited(() => this.refresh(domain)).finally(() => this.inflight.delete(domain))
      this.inflight.set(domain, p)
    }
    return p
  }

  private async refresh(domain: string): Promise<CompanyIcon | null> {
    // The switch may have gone off while this waited for a slot.
    if (!(await this.ctx.settings.get('companies.faviconsEnabled'))) return null
    const r = await fetchIcon(domain)
    const now = new Date().toISOString()
    if ('reason' in r) {
      log('debug', 'companies:icon-failed', { domain, reason: r.reason })
      await this.ctx.storage.putCompanyIcon({ domain, bytes: null, mime_type: null, fetched_at: now, status: 'failed' }).catch(() => undefined)
      return null
    }
    if (!(await this.ctx.settings.get('companies.faviconsEnabled'))) return null
    await this.ctx.storage
      .putCompanyIcon({ domain, bytes: r.icon.bytes, mime_type: r.icon.mimeType, fetched_at: now, status: 'ok' })
      .catch((err: unknown) => log('warn', 'companies:icon-save-failed', { domain, err }))
    return r.icon
  }

  private async limited<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= L.concurrency) await new Promise<void>((resolve) => this.waiting.push(resolve))
    this.running++
    try {
      return await fn()
    } finally {
      this.running--
      this.waiting.shift()?.()
    }
  }
}
