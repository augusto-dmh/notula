// SPDX-License-Identifier: Apache-2.0
// The opt-in company favicon cache: `company_icons`,
// deleted outright when favicons are turned off.

import type { CompanyIconRow } from './api'
import { invalid, type StoreCtx } from './store'

const DOMAIN = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/
const MAX_BYTES = 102_400

function domainOf(v: unknown): string {
  const d = typeof v === 'string' ? v.trim().toLowerCase() : ''
  if (!d || d.length > 253 || !DOMAIN.test(d)) throw invalid('domain is invalid')
  return d
}

export function getCompanyIcon(s: StoreCtx, domain: string): CompanyIconRow | null {
  const row = s.db
    .prepare(`SELECT domain, bytes, mime_type, fetched_at, status FROM company_icons WHERE domain = ? AND owner_id = ?`)
    .get(domainOf(domain), s.identity.ownerId) as
    | { domain: string; bytes: Uint8Array | null; mime_type: string | null; fetched_at: string; status: string }
    | undefined
  if (!row) return null
  return {
    domain: row.domain,
    bytes: row.bytes ? new Uint8Array(row.bytes) : null,
    mime_type: row.mime_type,
    fetched_at: row.fetched_at,
    status: row.status === 'ok' ? 'ok' : 'failed'
  }
}

export function putCompanyIcon(s: StoreCtx, row: CompanyIconRow): void {
  const domain = domainOf(row?.domain)
  if (row.status !== 'ok' && row.status !== 'failed') throw invalid('status must be ok or failed')
  if (typeof row.fetched_at !== 'string' || Number.isNaN(Date.parse(row.fetched_at))) throw invalid('fetched_at is invalid')
  const bytes = row.status === 'ok' && row.bytes ? Buffer.from(row.bytes) : null
  if (row.status === 'ok' && (!bytes || bytes.length === 0 || bytes.length > MAX_BYTES)) throw invalid('an icon must be 1 byte to 100 KB')
  s.db
    .prepare(
      `INSERT INTO company_icons (domain, owner_id, bytes, mime_type, fetched_at, status) VALUES (@domain, @owner, @bytes, @mime, @at, @status)
       ON CONFLICT (domain) DO UPDATE SET owner_id = @owner, bytes = @bytes, mime_type = @mime, fetched_at = @at, status = @status`
    )
    .run({
      domain,
      owner: s.identity.ownerId,
      bytes,
      mime: row.status === 'ok' ? (row.mime_type ?? null) : null,
      at: row.fetched_at,
      status: row.status
    })
  s.touch('company_icons', domain)
}

export function deleteAllCompanyIcons(s: StoreCtx): number {
  const r = s.db.prepare(`DELETE FROM company_icons WHERE owner_id = ?`).run(s.identity.ownerId)
  if (r.changes > 0) s.touch('company_icons')
  return r.changes
}
