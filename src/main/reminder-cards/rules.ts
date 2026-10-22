// SPDX-License-Identifier: Apache-2.0
// The reminder kinds Notula ships, as pure functions over
// calendar events and the capture state. `produce` returns what should be raised now; `index.ts`
// merges it with the stored rows and resolves what is no longer eligible.
//
// ICS rows may lack "can respond" or "primary calendar"; missing fields count as
// permissive, except the user's own attendee response, which must be present to raise an invite.

import { detectConferenceLink } from '@shared/lib/conference'
import type { IsoTime } from '@shared/types/common'
import type { CalendarAttendee, CalendarEvent } from '@shared/types/notes'
import { REMINDER_LIMITS as R, type Reminder, type ReminderAction, type ReminderKind, type ReminderResolvedReason } from '@shared/types/reminder-cards'

export interface Inputs {
  now: number
  events: CalendarEvent[]
  mine: ReadonlySet<string>
  /** The capturing note and its linked event, if any. */
  capture: { noteId: string; eventId: string | null; startedAt: number; systemChars: number; anyChars: number } | null
  /** Whether a linked meeting's other side can be heard (macOS screen-capture grant). */
  systemAudio: boolean
  followUps: { noteId: string; title: string | null; createdAt: number }[]
}

/** What a producer wants raised; the stored row adds id, status and times. */
export type Wanted = Pick<Reminder, 'key' | 'kind' | 'dueAt' | 'expiresAt' | 'presentation' | 'actions' | 'context'>

const SKIP_TYPES = new Set(['focusTime', 'outOfOffice', 'workingLocation', 'birthday'])

export const startMs = (ev: CalendarEvent): number | null => {
  const v = ev.start?.dateTime
  const ms = v ? Date.parse(v) : NaN
  return Number.isNaN(ms) ? null : ms
}
export const endMs = (ev: CalendarEvent): number | null => {
  const v = ev.end?.dateTime
  const ms = v ? Date.parse(v) : NaN
  return Number.isNaN(ms) ? null : ms
}
const iso = (ms: number): IsoTime => new Date(ms).toISOString()
const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null)

function selfOf(ev: CalendarEvent, mine: ReadonlySet<string>): CalendarAttendee | null {
  return (ev.attendees ?? []).find((a) => a && (a.self === true || mine.has(String(a.email ?? '').toLowerCase()))) ?? null
}

function organizerOf(ev: CalendarEvent): { email: string; name: string | null; self: boolean } | null {
  const o = ev['organizer'] as { email?: unknown; displayName?: unknown; self?: unknown } | undefined
  const email = str(o?.email)
  return email ? { email: email.toLowerCase(), name: str(o?.displayName), self: o?.self === true } : null
}

function iAmOrganizer(ev: CalendarEvent, mine: ReadonlySet<string>): boolean {
  const o = organizerOf(ev)
  return !!o && (o.self || mine.has(o.email)) || selfOf(ev, mine)?.organizer === true
}

/** Other human attendees: not me, not a room or resource. */
export function others(ev: CalendarEvent, mine: ReadonlySet<string>): CalendarAttendee[] {
  return (ev.attendees ?? []).filter((a) => a && typeof a.email === 'string' && !a.resource && a.self !== true && !mine.has(a.email.toLowerCase()))
}

const nameOf = (a: { email: string; displayName?: string | undefined; name?: string | null }): string =>
  str(a.displayName) ?? str(a.name) ?? a.email.split('@')[0] ?? a.email

export function meetingLink(ev: CalendarEvent): string | null {
  return detectConferenceLink(ev, null)?.url ?? str(ev['hangoutLink'])
}

const calendarLink = (ev: CalendarEvent): string | null => {
  const l = str(ev['htmlLink'])
  return l && /^https?:\/\//i.test(l) ? l : null
}

const title = (ev: CalendarEvent): string => str(ev.summary) ?? 'Untitled meeting'

function timeLabel(ms: number): string {
  return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(new Date(ms))
}

function eventKey(ev: CalendarEvent): string {
  return ev.id
}

function draftAction(label: string): ReminderAction {
  return { id: 'draft', kind: 'draft_block', label, state: 'requested', retryable: true, draft: null }
}

function linkAction(id: string, label: string, url: string | null): ReminderAction[] {
  return url ? [{ id, kind: 'open_link', label, url }] : []
}

function ctxOf(ev: CalendarEvent | null, noteId: string | null, clash: Reminder['context']['clash'] = null): Reminder['context'] {
  return { eventId: ev?.id ?? null, noteId, clash }
}

// ---------- invite awaiting a reply ----------

function inviteEligible(ev: CalendarEvent, i: Inputs): boolean {
  const s = startMs(ev)
  if (!ev.id || ev['status'] === 'cancelled' || s === null) return false
  if (ev['primaryCalendar'] === false) return false
  const me = selfOf(ev, i.mine)
  if (!me || me.responseStatus !== 'needsAction' || iAmOrganizer(ev, i.mine)) return false
  return s > i.now && s - i.now <= R.inviteHorizonMs
}

function clashFor(ev: CalendarEvent, i: Inputs): Reminder['context']['clash'] {
  const s = startMs(ev)
  const e = endMs(ev)
  if (s === null || e === null) return null
  const hits = i.events
    .filter((o) => {
      if (o.id === ev.id || o['status'] === 'cancelled' || o['status'] === 'tentative' || o['transparency'] === 'transparent') return false
      if (SKIP_TYPES.has(String(o['eventType'] ?? ''))) return false
      const me = selfOf(o, i.mine)
      if (me && (me.responseStatus === 'declined' || me.optional)) return false
      const os = startMs(o)
      const oe = endMs(o)
      return os !== null && oe !== null && os < e && oe > s
    })
    .sort((a, b) => (startMs(a) ?? 0) - (startMs(b) ?? 0))
  const c = hits[0]
  return c ? { title: title(c), start: c.start?.dateTime ?? '' } : null
}

// ---------- missing details ----------

function missingWhat(ev: CalendarEvent, i: Inputs): 'link' | 'location' | 'room' | null {
  if (meetingLink(ev)) return null
  const roomDeclined = (ev.attendees ?? []).some((a) => a?.resource && a.responseStatus === 'declined')
  if (str(ev['location']) && !roomDeclined) return null
  void i
  return roomDeclined ? 'room' : str(ev['location']) ? 'location' : 'link'
}

function missingEligible(ev: CalendarEvent, i: Inputs): boolean {
  const s = startMs(ev)
  if (!ev.id || ev['status'] === 'cancelled' || s === null || SKIP_TYPES.has(String(ev['eventType'] ?? ''))) return false
  if (ev['primaryCalendar'] === false) return false
  const me = selfOf(ev, i.mine)
  if (!iAmOrganizer(ev, i.mine) && me?.responseStatus !== 'accepted') return false
  if (others(ev, i.mine).length === 0) return false
  if (i.capture?.eventId === ev.id) return false
  if (!missingWhat(ev, i)) return false
  return s > i.now && s - i.now <= R.missingDetailsMs
}

// ---------- no-show ----------

function noShowState(ev: CalendarEvent, i: Inputs): 'raise' | 'joined' | 'wait' | 'ineligible' {
  const s = startMs(ev)
  const e = endMs(ev)
  if (!ev.id || s === null || e === null || ev['status'] === 'cancelled') return 'ineligible'
  const o = others(ev, i.mine)
  if (o.length !== 1) return 'ineligible'
  const link = meetingLink(ev)
  // A meeting without a link could only be reached through Slack, which Notula does not check, so
  // only linked meetings count.
  if (!link) return 'ineligible'
  if (!i.systemAudio) return 'ineligible'
  if (!i.capture || i.capture.eventId !== ev.id) return 'wait'
  if (i.capture.systemChars > 0) return 'joined'
  if (i.now - i.capture.startedAt < R.noShowAfterMs || i.now - s < R.noShowAfterMs) return 'wait'
  return 'raise'
}

// ---------- running late ----------

function lateEligible(ev: CalendarEvent, i: Inputs): boolean {
  const s = startMs(ev)
  if (!ev.id || s === null || ev['status'] === 'cancelled' || !i.capture || i.capture.eventId === ev.id) return false
  if (SKIP_TYPES.has(String(ev['eventType'] ?? ''))) return false
  const me = selfOf(ev, i.mine)
  if (me?.responseStatus === 'declined') return false
  if (others(ev, i.mine).length === 0) return false
  return i.now >= s + R.lateFromMs && i.now < s + R.lateUntilMs
}

/** Everything that should be raised now. */
export function produce(i: Inputs): Wanted[] {
  const out: Wanted[] = []
  for (const ev of i.events) {
    const s = startMs(ev)
    if (s === null) continue
    if (inviteEligible(ev, i)) {
      const o = organizerOf(ev)
      out.push({
        key: `missing_invite:${eventKey(ev)}`,
        kind: 'missing_invite',
        dueAt: iso(i.now),
        expiresAt: iso(s),
        presentation: {
          variant: 'default',
          title: `Reply to ${o?.name ?? o?.email ?? 'the organizer'}’s invite`,
          summary: `${title(ev)} · ${timeLabel(s)}`
        },
        actions: [...linkAction('calendar', 'Open in calendar', calendarLink(ev)), draftAction('Draft a reply')],
        context: ctxOf(ev, null, clashFor(ev, i))
      })
    }
    if (missingEligible(ev, i)) {
      const what = missingWhat(ev, i)
      const mineToEdit = iAmOrganizer(ev, i.mine)
      const o = organizerOf(ev)
      const to = mineToEdit ? 'attendees' : (o?.name ?? o?.email ?? 'the organizer')
      out.push({
        key: `no_meeting_link:${eventKey(ev)}`,
        kind: 'no_meeting_link',
        dueAt: iso(i.now),
        expiresAt: iso(s),
        presentation: {
          variant: 'default',
          title:
            what === 'room'
              ? `The room for ${title(ev)} declined`
              : mineToEdit
                ? `Add a meeting link or location to ${title(ev)}`
                : `${title(ev)} has no join link or location`,
          summary: `Starts at ${timeLabel(s)}`
        },
        actions: [draftAction(`Draft a message to ${to}`), ...linkAction('calendar', 'Open in calendar', calendarLink(ev))],
        context: ctxOf(ev, null)
      })
    }
    if (noShowState(ev, i) === 'raise') {
      const other = others(ev, i.mine)[0]!
      out.push({
        key: `attendees_absent:${eventKey(ev)}`,
        kind: 'attendees_absent',
        dueAt: iso(i.now),
        expiresAt: iso(endMs(ev) ?? s),
        presentation: { variant: 'default', title: `${nameOf(other)} hasn’t joined yet`, summary: title(ev) },
        actions: [draftAction(`Draft a message to ${nameOf(other)}`), ...linkAction('meeting', 'Open meeting link', meetingLink(ev))],
        context: ctxOf(ev, i.capture?.noteId ?? null)
      })
    }
    if (lateEligible(ev, i)) {
      out.push({
        key: `late_for_meeting:${eventKey(ev)}`,
        kind: 'late_for_meeting',
        dueAt: iso(s + R.lateFromMs),
        expiresAt: iso(s + R.lateUntilMs),
        presentation: { variant: 'late_for_meeting', title: `${title(ev)} has started`, summary: `It began at ${timeLabel(s)}, while you’re still in another meeting.` },
        actions: [draftAction('Draft a “running late” message'), ...linkAction('meeting', 'Open meeting link', meetingLink(ev))],
        context: ctxOf(ev, null)
      })
    }
  }
  for (const f of i.followUps) {
    out.push({
      key: `followup_drafts:${f.noteId}`,
      kind: 'followup_drafts',
      dueAt: iso(i.now),
      expiresAt: iso(f.createdAt + 2 * 3_600_000),
      presentation: { variant: 'default', title: 'Suggested follow-up emails', summary: f.title ?? 'Your last meeting' },
      actions: [{ id: 'review', kind: 'review_drafts', label: 'Review drafts' }],
      context: ctxOf(null, f.noteId)
    })
  }
  return out
}

/** Why a stored live reminder that `produce` no longer wants is resolved. */
export function resolveReason(r: Reminder, i: Inputs): ReminderResolvedReason {
  const now = i.now
  if (r.expiresAt && Date.parse(r.expiresAt) <= now) return 'expired'
  if (r.kind === 'followup_drafts') return 'session_ended'
  const ev = i.events.find((e) => e.id === r.context.eventId)
  if (!ev) return r.kind === 'late_for_meeting' || r.kind === 'attendees_absent' ? 'ineligible' : 'cancelled'
  if (ev['status'] === 'cancelled') return 'cancelled'
  const s = startMs(ev)
  switch (r.kind as ReminderKind) {
    case 'missing_invite': {
      if (s !== null && s <= now) return 'expired'
      const me = selfOf(ev, i.mine)
      return me && me.responseStatus !== 'needsAction' ? 'rsvped' : 'ineligible'
    }
    case 'no_meeting_link':
      if (s !== null && s <= now) return 'expired'
      if (i.capture?.eventId === ev.id) return 'live'
      return missingWhat(ev, i) === null ? 'details_added' : 'ineligible'
    case 'attendees_absent':
      return noShowState(ev, i) === 'joined' ? 'joined' : 'ineligible'
    case 'late_for_meeting':
      if (!i.capture) return 'not_transcribing'
      if (i.capture.eventId === ev.id) return 'joined'
      return 'ineligible'
    default:
      return 'ineligible'
  }
}

/** Recipients and facts for a draft. */
export function draftFacts(r: Reminder, ev: CalendarEvent | null, mine: ReadonlySet<string>): { to: string[]; facts: string } {
  if (!ev) return { to: [], facts: '' }
  const o = organizerOf(ev)
  const attendees = others(ev, mine)
  const s = startMs(ev)
  let to: string[] = []
  if (r.kind === 'missing_invite') to = o && !mine.has(o.email) ? [o.email] : []
  else if (r.kind === 'no_meeting_link') to = iAmOrganizer(ev, mine) ? attendees.map((a) => a.email) : o ? [o.email] : []
  else to = attendees.map((a) => a.email)
  const facts = [
    `Event title: ${title(ev)}`,
    `Starts: ${s !== null ? new Date(s).toString() : 'unknown'}`,
    `Organizer: ${o ? (o.name ? `${o.name} <${o.email}>` : o.email) : 'unknown'}`,
    `Other attendees: ${attendees.map((a) => nameOf(a)).join(', ') || 'none'}`,
    `Has a meeting link: ${meetingLink(ev) ? 'yes' : 'no'}`,
    `Location: ${str(ev['location']) ?? 'none'}`,
    r.context.clash ? `Clashes with: ${r.context.clash.title} at ${r.context.clash.start}` : ''
  ]
    .filter(Boolean)
    .join('\n')
  return { to: [...new Set(to.map((t) => t.toLowerCase()))], facts }
}
