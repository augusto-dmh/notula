// SPDX-License-Identifier: Apache-2.0
// The attendee summary line. Kept general: shared-note
// variants never occur yet, but the formatter supports them.
//
// Own notes: `Me` (nobody else) · `Ana Lima` (one) · `Ana & Ben` (two) ·
// `Ana, Ben & Caio` (three) · `Ana, Ben & 3 others` (four or more).
// External-domain people sort first, then by name.
//
// Names come from `displayName`, resources from `isResourceEmail`,
// and the webmail list is the user's `people.genericEmailDomains`.

import { DEFAULT_GENERIC_EMAIL_DOMAINS, displayName, isGenericDomain, isResourceEmail } from '@shared/lib/people'
import type { CalendarAttendee, NoteListItem, NotePerson } from '@shared/types/notes'

export interface Attendee {
  email?: string
  name?: string
  self?: boolean
  resource?: boolean
}

function domainOf(email: string | undefined): string {
  const at = email?.lastIndexOf('@') ?? -1
  return at >= 0 && email ? email.slice(at + 1).toLowerCase() : ''
}

/** Rooms and group calendars are not people. */
function isExcluded(a: Attendee): boolean {
  return a.resource === true || (!!a.email && isResourceEmail(a.email))
}

export function fullName(a: Attendee): string {
  return displayName({ name: a.name ?? null, email: a.email ?? null })
}

export function firstName(a: Attendee): string {
  const name = a.name?.trim()
  if (name) return name.split(/\s+/)[0] as string
  return fullName(a)
}

function ownList(names: string[], total: number): string {
  if (total === 2) return `${names[0]} & ${names[1]}`
  if (total === 3) return `${names[0]}, ${names[1]} & ${names[2]}`
  return `${names[0]}, ${names[1]} & ${total - 2} others`
}

/** Shared notes: the creator first, then the others, then "& Me". */
function sharedList(names: string[]): string {
  if (names.length === 0) return 'Me'
  if (names.length <= 2) return `${names.join(', ')} & Me`
  return `${names[0]}, ${names[1]} & ${names.length - 1} others`
}

export interface SummaryInput {
  attendees: Attendee[]
  /** The user's own address, to drop them from the list and tell internal from external. */
  selfEmail?: string
  /** False for a note shared with the user (not possible yet). */
  own: boolean
  creator?: Attendee
  /** `people.genericEmailDomains`; the default list when not given. */
  genericDomains?: readonly string[]
}

export function attendeeSummary({ attendees, selfEmail, own, creator, genericDomains }: SummaryInput): string {
  const self = selfEmail?.trim().toLowerCase() ?? ''
  const selfDomain = domainOf(self)
  const generic = genericDomains ?? DEFAULT_GENERIC_EMAIL_DOMAINS
  const internalDomain = selfDomain !== '' && !isGenericDomain(selfDomain, generic) ? selfDomain : null
  const creatorKey = creator?.email?.toLowerCase() ?? (creator ? fullName(creator).toLowerCase() : '')
  const seen = new Set<string>()
  const people: Attendee[] = []
  for (const a of attendees) {
    if (a.self || isExcluded(a)) continue
    const key = (a.email?.trim() || a.name?.trim() || '').toLowerCase()
    if (key === '' || key === self || seen.has(key) || (!own && key === creatorKey)) continue
    seen.add(key)
    people.push(a)
  }
  const external = (a: Attendee): number => (internalDomain && domainOf(a.email) === internalDomain ? 1 : 0)
  people.sort((a, b) => external(a) - external(b) || fullName(a).localeCompare(fullName(b)))

  if (own) {
    if (people.length === 0) return 'Me'
    if (people.length === 1) return fullName(people[0] as Attendee)
    return ownList(people.slice(0, 3).map(firstName), people.length)
  }
  const creatorName = creator ? firstName(creator) : ''
  return sharedList([creatorName, ...people.map(firstName)].filter(Boolean))
}

/** The prefix for a note the user does not own: "<creator first name>'s Note ∙ ". */
export function sharedPrefix(creator: Attendee | undefined): string {
  return creator ? `${firstName(creator)}'s Note ∙ ` : ''
}

function fromPerson(p: NotePerson): Attendee {
  return { ...(p.email ? { email: p.email } : {}), ...(p.name ? { name: p.name } : {}) }
}

function fromCalendar(a: CalendarAttendee): Attendee {
  return {
    email: a.email,
    ...(a.displayName ? { name: a.displayName } : {}),
    ...(a.self ? { self: true } : {}),
    ...(a.resource ? { resource: true } : {})
  }
}

/**
 * The secondary line of a home row or the note header. A note's `people` is the list
 * once it exists (filled at creation, then edited by hand: a removed attendee stays
 * removed); only an older note without it falls back to its event's attendees.
 */
export function noteAttendeeLine(
  item: Pick<NoteListItem, 'people' | 'linked_event' | 'is_shared'>,
  own: boolean,
  selfEmail?: string,
  genericDomains?: readonly string[]
): string {
  const attendees = item.people
    ? (item.people.attendees ?? []).map(fromPerson)
    : (item.linked_event?.attendees ?? []).map(fromCalendar)
  const creator = item.people?.creator ? fromPerson(item.people.creator) : undefined
  const summary = attendeeSummary({
    attendees,
    own,
    ...(selfEmail ? { selfEmail } : {}),
    ...(creator ? { creator } : {}),
    ...(genericDomains ? { genericDomains } : {})
  })
  return own ? summary : `${sharedPrefix(creator)}${summary}`
}
