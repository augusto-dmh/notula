// SPDX-License-Identifier: Apache-2.0
// People: display names, companies and the address lists. Pure functions shared by main,
// the storage worker and the renderer.

import type { CalendarAttendee, CalendarEvent, NotePeople, NotePerson } from '../types/notes'

/** The name shown when nothing better is known. */
const UNKNOWN = 'Unknown'

const RESOURCE_PARTS = ['resource.calendar.google.com', 'group.calendar.google.com', 'events.workablemail.com'] as const
const BOT_SUFFIXES = ['@assistant.gong.io', '@capture.grain.com'] as const
const BOT_ADDRESSES = ['fred@fireflies.ai', 'meet@chime.aws'] as const

/**
 * The webmail domains Notula ships: its own short curated
 * list, editable in settings (`people.genericEmailDomains`).
 */
export const DEFAULT_GENERIC_EMAIL_DOMAINS: readonly string[] = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'hotmail.com',
  'live.com',
  'msn.com',
  'yahoo.com',
  'ymail.com',
  'icloud.com',
  'me.com',
  'mac.com',
  'aol.com',
  'proton.me',
  'protonmail.com',
  'gmx.com',
  'gmx.de',
  'web.de',
  'mail.com',
  'zoho.com',
  'yandex.com',
  'yandex.ru',
  'qq.com',
  '163.com'
]

/** The part before `@`, its first dot as a space, lower-cased, each word capitalized. */
function nameFromEmail(email: string): string {
  const local = (email.split('@')[0] ?? '').replace('.', ' ').toLowerCase()
  return local.replace(/(^|\s)(\S)/g, (_m, space: string, c: string) => space + c.toUpperCase())
}

/** A person's display name. Notula has no profile enrichment, so no enriched full name is ever used. */
export function displayName(
  p: { name?: string | null; email?: string | null; isGroup?: boolean } | null,
  fallbackEmail?: string | null
): string {
  const email = p?.email?.trim() || fallbackEmail?.trim() || ''
  if (p?.isGroup && email) return email
  const name = p?.name?.trim()
  if (name) return name
  return email ? nameFromEmail(email) || UNKNOWN : UNKNOWN
}

/** The domain's first label, first letter upper-cased; empty for a `gmail` domain. */
/** The `/person/…` key of a people row: its email, or `p:<personId>` for a person without one. */
export function personRouteKey(p: { email?: string; personId?: string }): string {
  return p.email ?? `p:${p.personId ?? ''}`
}

export function companyFromEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at < 0) return ''
  const domain = email.slice(at + 1).trim()
  if (!domain || domain.toLowerCase().includes('gmail')) return ''
  const label = domain.split('.')[0] ?? ''
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : ''
}

/**
 * A company's display name from its
 * domain, the first label with its first letter upper-cased ("acme.co.uk" → "Acme");
 * the domain itself when that label is empty.
 */
export function companyName(domain: string): string {
  const d = domain.trim().toLowerCase()
  const label = d.split('.')[0] ?? ''
  return label ? label.charAt(0).toUpperCase() + label.slice(1) : d
}

/** A calendar resource (room, group calendar). Case-insensitive. */
export function isResourceEmail(email: string): boolean {
  const e = email.trim().toLowerCase()
  return RESOURCE_PARTS.some((part) => e.includes(part)) || (e.startsWith('calendarserver') && e.endsWith('@apple.com'))
}

/** A note-taker bot. Case-insensitive. */
export function isBotEmail(email: string): boolean {
  const e = email.trim().toLowerCase()
  return BOT_SUFFIXES.some((suffix) => e.endsWith(suffix)) || (BOT_ADDRESSES as readonly string[]).includes(e)
}

/** "excluded" = a resource or a bot. */
export function isExcludedEmail(email: string): boolean {
  return isResourceEmail(email) || isBotEmail(email)
}

/**
 * `people` for a new note. The creator is the profile; the attendees are the
 * event's, without resources and without the user's own entry (`self`, or any of
 * "my emails"), each named by `displayName`.
 */
export function peopleForNote(i: {
  event: CalendarEvent | null
  profile: { name: string; email: string }
  myEmails: readonly string[]
}): NotePeople {
  const mine = new Set(i.myEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))
  const seen = new Set<string>()
  const attendees: NotePerson[] = []
  const list: unknown = i.event?.attendees
  for (const a of Array.isArray(list) ? (list as CalendarAttendee[]) : []) {
    const email = typeof a?.email === 'string' ? a.email.trim() : ''
    const key = email.toLowerCase()
    if (!email || a.self || a.resource || isResourceEmail(email) || mine.has(key) || seen.has(key)) continue
    seen.add(key)
    attendees.push({ email, name: displayName({ name: a.displayName ?? null, email }) })
  }
  return { creator: { name: i.profile.name, email: i.profile.email }, attendees, attendee_overrides: [] }
}

/** Exact, case-insensitive membership in the user's list. */
export function isGenericDomain(domain: string, genericDomains: readonly string[]): boolean {
  return genericDomains.includes(domain.trim().toLowerCase())
}

function domainOf(email: string | null | undefined): string {
  if (!email) return ''
  const at = email.lastIndexOf('@')
  return at < 0 ? '' : email.slice(at + 1).trim().toLowerCase()
}

/**
 * The event's external attendees. Candidates: attendees not `self`, not resources, with an
 * email, plus the organizer when it is not `self` ("self" also means one of "my emails"). The user's
 * domain comes from the user's email, else the `self` attendee, else a `self`
 * organizer. With a generic user domain every candidate is external; otherwise a
 * candidate is external when it is not a resource or a bot, is on another domain, and
 * is not on one of `extraInternal`.
 */
export function externalAttendees(
  event: CalendarEvent,
  myEmails: readonly string[],
  genericDomains: readonly string[],
  extraInternal?: readonly string[]
): CalendarAttendee[] {
  const mine = new Set(myEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))
  const isSelf = (p: { email?: unknown; self?: unknown } | null | undefined): boolean =>
    !!p && (p.self === true || (typeof p.email === 'string' && mine.has(p.email.trim().toLowerCase())))
  const list: unknown = event?.attendees
  const attendees = Array.isArray(list) ? (list as CalendarAttendee[]) : []
  const organizer = event?.['organizer'] as { email?: unknown; displayName?: unknown; self?: unknown } | undefined

  const candidates: CalendarAttendee[] = []
  const seen = new Set<string>()
  const add = (a: CalendarAttendee): void => {
    const key = a.email.trim().toLowerCase()
    if (!key || seen.has(key)) return
    seen.add(key)
    candidates.push(a)
  }
  for (const a of attendees) {
    if (!a || typeof a.email !== 'string' || !a.email.trim() || isSelf(a) || a.resource) continue
    add(a)
  }
  if (organizer && typeof organizer.email === 'string' && organizer.email.trim() && !isSelf(organizer)) {
    add({
      email: organizer.email,
      ...(typeof organizer.displayName === 'string' ? { displayName: organizer.displayName } : {}),
      organizer: true
    })
  }

  const selfAttendee = attendees.find((a) => a && isSelf(a) && typeof a.email === 'string')
  const userDomain =
    domainOf([...mine][0]) ||
    domainOf(selfAttendee?.email) ||
    (organizer && isSelf(organizer) && typeof organizer.email === 'string' ? domainOf(organizer.email) : '')
  if (userDomain && isGenericDomain(userDomain, genericDomains)) return candidates
  const internal = new Set((extraInternal ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean))
  return candidates.filter((a) => {
    const domain = domainOf(a.email)
    return !isResourceEmail(a.email) && !isBotEmail(a.email) && domain !== userDomain && !internal.has(domain)
  })
}

/** One of Notula's seven avatar tones, stable per seed (0 = neutral for an empty seed). */
export function avatarTone(seed: string): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  const s = (seed ?? '').trim().toLowerCase()
  if (!s) return 0
  // FNV-1a, 32-bit: stable across processes and sessions.
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return (h % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6
}
