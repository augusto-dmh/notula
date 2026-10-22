// SPDX-License-Identifier: Apache-2.0
// The emails and domains providers match against (HubSpot, Attio and Affinity
// suggestions, Attio folder sync): the attendees' external rule.

import { externalAttendees, isGenericDomain } from '@shared/lib/people'
import type { Note } from '@shared/types/notes'
import type { MainContext } from '../context'

export interface MatchSet {
  emails: string[]
  /** Distinct company domains, without generic (free-mail) domains. */
  domains: string[]
}

function domainOf(email: string): string {
  const at = email.lastIndexOf('@')
  return at < 0 ? '' : email.slice(at + 1).toLowerCase()
}

export async function matchSet(ctx: MainContext, note: Note): Promise<MatchSet> {
  const [myEmails, generic] = await Promise.all([
    ctx.calendar.myEmails().catch(() => [] as string[]),
    ctx.settings.get('people.genericEmailDomains').catch(() => [] as string[])
  ])
  const mine = new Set(myEmails.map((e) => e.trim().toLowerCase()))
  let emails: string[]
  if (note.linked_event) {
    emails = externalAttendees(note.linked_event, myEmails, generic).map((a) => a.email.trim().toLowerCase())
  } else {
    // No event: the note's own attendee list, without the user (Attio step 11 adds the creator).
    emails = (note.people?.attendees ?? []).map((a) => (a.email ?? '').trim().toLowerCase()).filter((e) => e.includes('@') && !mine.has(e))
  }
  emails = [...new Set(emails)].slice(0, 100)
  const myDomains = new Set([...mine].map(domainOf))
  const all = [...new Set(emails.map(domainOf).filter(Boolean))].filter((d) => !isGenericDomain(d, generic))
  const external = all.filter((d) => !myDomains.has(d))
  return { emails, domains: external.length ? external : all }
}
