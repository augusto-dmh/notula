// SPDX-License-Identifier: Apache-2.0
// `notula://` parsing and the duplicate guards.
//
// Safety rules: a host allow-list, a typed schema per host, `true`/`false` → booleans,
// pathname-only `open` (the renderer checks the route), and nothing in a URL can run
// code, change flags or reach the file system. Only the build's own scheme is a deep
// link (`notula` packaged, `notula-dev` otherwise); http(s) URLs never are.

import {
  DEEP_LINK_HOSTS,
  type DeepLinkEvent
} from '@shared/types/app'
import type { CreationOrigin } from '@shared/types/notes'
import type { SettingsSection } from '@shared/types/settings'

/** `eventId`: a `new-note` link's `event`, which main resolves through `ctx.calendar.getEvent`. */
export type ParseResult = { ok: true; event: DeepLinkEvent; eventId?: string } | { ok: false; reason: string }

type Host = (typeof DEEP_LINK_HOSTS)[number]
type QueryValue = string | boolean

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Entry origins a `created_via` may name; anything else falls back to `deep_link`. */
const ORIGINS: readonly CreationOrigin[] = [
  'new_note_button',
  'app_menu',
  'tray',
  'dock_menu',
  'notification',
  'deep_link',
  'unscheduled_meeting_alert'
]

/**
 * Settings pages Notula ships. `calendar` joins once
 * calendar sync ships; `dev` exists in development builds only.
 */
export function shippedSettingsSections(packaged: boolean): SettingsSection[] {
  const sections: SettingsSection[] = [
    'preferences',
    'ai',
    'profile',
    'notifications',
    // Voice typing lands on Preferences while its Labs switch is off.
    'keyboard-shortcuts',
    'speaker-tags',
    'voice-typing',
    'integrations',
    'connectors',
    'labs',
    'troubleshooting'
  ]
  if (!packaged) sections.push('dev')
  return sections
}

/** The first argument that is one of `scheme`'s URLs, if any. */
export function findSchemeUrl(argv: readonly string[], scheme: string): string | null {
  const prefix = `${scheme}:`
  return argv.find((a) => a.toLowerCase().startsWith(prefix)) ?? null
}

/** `true` / `false` become booleans; everything else is already URI-decoded. */
function readQuery(u: URL): Map<string, QueryValue> {
  const out = new Map<string, QueryValue>()
  for (const [k, v] of u.searchParams) {
    if (out.has(k)) continue
    out.set(k, v === 'true' ? true : v === 'false' ? false : v)
  }
  return out
}

function optionalString(q: Map<string, QueryValue>, key: string): string | null | undefined {
  const v = q.get(key)
  if (v === undefined) return null
  return typeof v === 'string' ? v : undefined
}

function parseHost(host: Host, q: Map<string, QueryValue>, packaged: boolean): ParseResult {
  const invalid = (detail: string): ParseResult => ({ ok: false, reason: `url-validation-failed-${host}: ${detail}` })

  switch (host) {
    case 'open': {
      const path = optionalString(q, 'path')
      if (path === undefined) return invalid('path must be text')
      return { ok: true, event: { type: 'open', data: { path: path ?? '' } } }
    }
    case 'new-note': {
      const event = optionalString(q, 'event')
      const source = optionalString(q, 'created_via')
      const auto = q.get('auto_transcribe')
      if (event === undefined) return invalid('event must be text')
      if (source === undefined) return invalid('created_via must be text')
      if (auto !== undefined && typeof auto !== 'boolean') return invalid('auto_transcribe must be true or false')
      const creationSource = source && (ORIGINS as readonly string[]).includes(source) ? (source as CreationOrigin) : 'deep_link'
      return {
        ok: true,
        event: { type: 'new-note', data: { creationSource, autoTranscribe: auto === true, event: null } },
        ...(event ? { eventId: event } : {})
      }
    }
    case 'show-note': {
      const id = q.get('document_id')
      if (typeof id !== 'string' || !UUID.test(id)) return invalid('document_id must be a UUID')
      return { ok: true, event: { type: 'show-note', data: { documentId: id.toLowerCase(), openSource: 'deep_link' } } }
    }
    case 'show-settings': {
      const page = q.get('page') ?? q.get('settings')
      if (page === undefined) return invalid('page is required')
      if (typeof page !== 'string' || !(shippedSettingsSections(packaged) as string[]).includes(page)) {
        return invalid(`unknown page ${String(page).slice(0, 40)}`)
      }
      return { ok: true, event: { type: 'show-settings', data: { page: page as SettingsSection } } }
    }
  }
}

/**
 * Parses a `<scheme>://<host>?<params>` link. Null when `raw` is not a URL of
 * `scheme` at all (it is then not a deep link and is ignored).
 */
export function parseDeepLink(raw: string, scheme: string, packaged: boolean): ParseResult | null {
  if (!raw.toLowerCase().startsWith(`${scheme}:`)) return null
  let u: URL
  try {
    u = new URL(raw)
  } catch {
    return { ok: false, reason: 'unparsable-url' }
  }
  if (u.protocol.toLowerCase() !== `${scheme}:`) return null
  const host = u.hostname.toLowerCase()
  // An empty host means `open` with no data.
  if (host === '') return { ok: true, event: { type: 'open', data: { path: '' } } }
  if (!(DEEP_LINK_HOSTS as readonly string[]).includes(host)) return { ok: false, reason: 'unknown-link-host' }
  return parseHost(host as Host, readQuery(u), packaged)
}

/**
 * The two duplicate guards: the same raw URL within 2 s and the same parsed
 * event within 1 s, each remembering at most 100 entries.
 */
export class DuplicateGuard {
  private readonly seen = new Map<string, number>()

  constructor(
    private readonly windowMs: number,
    private readonly max = 100
  ) {}

  /** True when `key` was recorded within the window; records it either way. */
  check(key: string, now = Date.now()): boolean {
    const last = this.seen.get(key)
    this.record(key, now)
    return last !== undefined && now - last < this.windowMs
  }

  record(key: string, now = Date.now()): void {
    this.seen.delete(key)
    this.seen.set(key, now)
    for (const [k, t] of this.seen) {
      if (this.seen.size <= this.max && now - t < this.windowMs) break
      this.seen.delete(k)
    }
  }
}

export function eventKey(e: DeepLinkEvent): string {
  return JSON.stringify(e)
}
