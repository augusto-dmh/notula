// SPDX-License-Identifier: Apache-2.0
// Calendar writes: Google Calendar events insert / patch and
// Microsoft Graph events, from the main process only, with the account's `calendar-write` token.
// Idempotency: Google `id` = the block id without dashes, Graph `transactionId` = the block id, so a
// second click or a "Try again" after `unknown` creates no second event.

import type { CalendarEventDraft } from '@shared/types/workflow-blocks'
import type { MainContext } from '../context'
import { log } from '../log'
import type { ExecResult } from '../blocks'
import { chosenTime, diffDraft, parseRule, WEEKDAYS, type DraftDiff } from './draft'
import { errorReason, exchange, insufficientScope, providerHttp, type Exchange } from './http'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

export const COPY = {
  localOnly: 'Calendar changes are off while Local-only mode is on.',
  reconnect: 'Reconnect your calendar to continue.',
  missingScopes: 'Notula needs permission to create events. Grant access to continue.',
  unknown: 'Notula can’t tell whether this reached your calendar. Check it before trying again.',
  etag: 'This event changed in your calendar. Ask again to get a fresh draft.',
  msRepeat: 'This repeat rule isn’t supported for Microsoft calendars.',
  network: 'Couldn’t reach your calendar. Check your connection and try again.',
  other: 'Your calendar didn’t accept the change. Try again.'
} as const

export interface WriteTarget {
  sourceId: string
  provider: 'google' | 'microsoft'
  accountEmail: string | null
  /** The provider's calendar id (`primary` for Google when none is synced). */
  calendarNativeId: string
}

/** A failed exchange as the block's outcome (anything that may have arrived is `unknown`). */
function failed(x: Exclude<Exchange, { ok: true }>, write: boolean): ExecResult {
  if (x.kind === 'local-only') return { status: 'failed', errorCode: 'local_only', error: COPY.localOnly }
  if (x.kind === 'network') return { status: 'failed', errorCode: 'network', error: COPY.network }
  if (x.kind === 'uncertain') return write ? { status: 'unknown', errorCode: 'timeout', error: COPY.unknown } : { status: 'failed', errorCode: 'network', error: COPY.network }
  if (insufficientScope(x)) return { status: 'failed', errorCode: 'missing_scopes', error: COPY.missingScopes }
  if (x.status === 401) return { status: 'failed', errorCode: 'missing_token', error: COPY.reconnect }
  if (x.status === 412) return { status: 'failed', errorCode: 'etag_mismatch', error: COPY.etag }
  if (x.status >= 500 && write) return { status: 'unknown', errorCode: `http_${x.status}`, error: COPY.unknown }
  const reason = errorReason(x.body)
  const message = str(obj(x.body['error'])['message'])
  return { status: 'failed', errorCode: `http_${x.status}`, error: message ? `This change isn’t valid: ${message.slice(0, 200)}.` : (reason ?? COPY.other) }
}

const isWorkAccount = (email: string | null): boolean => !!email && !/@(outlook|hotmail|live|msn)\.[a-z.]+$/i.test(email)

function attendeeList(d: CalendarEventDraft, me: string | null): { email: string; resource?: boolean }[] {
  const others = d.attendees.filter((a) => !me || a.email.toLowerCase() !== me.toLowerCase())
  return d.addMeAsGuest !== false && me ? [{ email: me }, ...others] : others
}

/** A custom link goes in `location` when that is empty, else first in the description. */
function withCustomLink(d: CalendarEventDraft): { location: string; description: string } {
  const location = d.location ?? ''
  const description = d.description ?? ''
  if (d.conference.kind !== 'custom') return { location, description }
  const url = d.conference.url
  return location ? { location, description: description ? `${url}\n${description}` : url } : { location: url, description }
}

// ---------- Google ----------

function googleBody(d: CalendarEventDraft, blockId: string, me: string | null): Obj {
  const t = chosenTime(d)
  const { location, description } = withCustomLink(d)
  const body: Obj = {
    id: blockId.replace(/-/g, '').toLowerCase(),
    summary: d.summary || 'Untitled event',
    start: t?.start,
    end: t?.end,
    description,
    attendees: attendeeList(d, me).map((a, i) => ({ email: a.email, ...(a.resource ? { resource: true } : {}), ...(i === 0 && me && a.email === me ? { responseStatus: 'accepted' } : {}) }))
  }
  if (location) body['location'] = location
  if (d.conference.kind === 'googleMeet') body['conferenceData'] = { createRequest: { requestId: blockId, conferenceSolutionKey: { type: 'hangoutsMeet' } } }
  if (d.recurrenceRules?.length) body['recurrence'] = d.recurrenceRules
  return body
}

function googleCreated(body: Obj, calendarId: string): ExecResult {
  return { status: 'created', fields: { eventId: str(body['id']), calendarId, htmlLink: str(body['htmlLink']) } }
}

export async function googleCreate(ctx: MainContext, token: string, t: WriteTarget, d: CalendarEventDraft, blockId: string): Promise<ExecResult> {
  const http = providerHttp(ctx, 'calendar', 'calendar-write')
  const hasGuests = attendeeList(d, t.accountEmail).some((a) => !t.accountEmail || a.email.toLowerCase() !== t.accountEmail.toLowerCase())
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }
  const x = await exchange(() =>
    http.fetch('https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events', {
      method: 'POST',
      params: { calendarId: t.calendarNativeId },
      query: { conferenceDataVersion: '1', sendUpdates: hasGuests ? 'all' : 'none' },
      headers,
      body: JSON.stringify(googleBody(d, blockId, t.accountEmail))
    })
  )
  if (x.ok) return googleCreated(x.body, t.calendarNativeId)
  if (x.kind === 'http' && x.status === 409) {
    // The same `id` exists: the first click (or the request that timed out) created it.
    const got = await exchange(() =>
      http.fetch('https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}', {
        params: { calendarId: t.calendarNativeId, eventId: blockId.replace(/-/g, '').toLowerCase() },
        headers
      })
    )
    log('info', 'calendar-write:already-created', { provider: 'google', found: got.ok })
    if (got.ok) return googleCreated(got.body, t.calendarNativeId)
    return { status: 'created', fields: { eventId: blockId.replace(/-/g, '').toLowerCase(), calendarId: t.calendarNativeId, htmlLink: null } }
  }
  return failed(x, true)
}

function googlePatch(diff: DraftDiff, current: Obj): Obj {
  const p: Obj = {}
  if (diff.title !== undefined) p['summary'] = diff.title || 'Untitled event'
  if (diff.description !== undefined) p['description'] = diff.description
  if (diff.location !== undefined) p['location'] = diff.location
  if (diff.time) {
    p['start'] = diff.time.start
    p['end'] = diff.time.end
  }
  if (diff.addAttendees.length || diff.removeAttendees.length) {
    const drop = new Set(diff.removeAttendees.map((e) => e.toLowerCase()))
    const kept = (Array.isArray(current['attendees']) ? (current['attendees'] as Obj[]) : []).filter((a) => !drop.has(String(a['email'] ?? '').toLowerCase()))
    p['attendees'] = [...kept, ...diff.addAttendees.map((a) => ({ email: a.email, ...(a.resource ? { resource: true } : {}) }))]
  }
  if (diff.conference) {
    if (diff.conference.kind === 'googleMeet') p['conferenceData'] = { createRequest: { requestId: `${String(current['id'] ?? 'event')}-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } } }
    else if (diff.conference.kind === 'none') p['conferenceData'] = null
    else if (diff.location === undefined && !str(current['location'])) p['location'] = diff.conference.url
    else p['description'] = `${diff.conference.url}\n${diff.description ?? str(current['description']) ?? ''}`
  }
  return p
}

export async function googleUpdate(ctx: MainContext, token: string, t: WriteTarget, d: CalendarEventDraft): Promise<ExecResult> {
  const ex = d.existingEvent
  const r = diffDraft(d)
  if (!ex || 'refusal' in r) return { status: 'failed', errorCode: 'invalid', error: 'refusal' in r ? r.refusal : COPY.other }
  const http = providerHttp(ctx, 'calendar', 'calendar-write')
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }
  const cur = await exchange(() =>
    http.fetch('https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}', { params: { calendarId: t.calendarNativeId, eventId: ex.eventId }, headers })
  )
  if (!cur.ok) return failed(cur, false)
  if (ex.etag && str(cur.body['etag']) !== ex.etag) return { status: 'failed', errorCode: 'etag_mismatch', error: COPY.etag }
  const target = ex.scope === 'series' ? (str(cur.body['recurringEventId']) ?? ex.eventId) : ex.eventId
  const hasGuests = Array.isArray(cur.body['attendees']) && (cur.body['attendees'] as unknown[]).length > 1
  const x = await exchange(() =>
    http.fetch('https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}', {
      method: 'PATCH',
      params: { calendarId: t.calendarNativeId, eventId: target },
      query: { conferenceDataVersion: '1', sendUpdates: hasGuests || r.diff.addAttendees.length ? 'all' : 'none' },
      headers: { ...headers, 'if-match': str(cur.body['etag']) ?? '*' },
      body: JSON.stringify(googlePatch(r.diff, cur.body))
    })
  )
  if (x.ok) return { status: 'updated', fields: { eventId: str(x.body['id']) ?? target, calendarId: t.calendarNativeId, htmlLink: str(x.body['htmlLink']) } }
  return failed(x, true)
}

// ---------- Microsoft Graph ----------

const GRAPH_DAYS: Record<string, string> = { SU: 'sunday', MO: 'monday', TU: 'tuesday', WE: 'wednesday', TH: 'thursday', FR: 'friday', SA: 'saturday' }
const GRAPH_INDEX: Record<number, string> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', [-1]: 'last' }

function graphTime(t: { dateTime: string; timeZone: string } | { date: string }): Obj {
  return 'date' in t ? { dateTime: `${t.date}T00:00:00`, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : { dateTime: t.dateTime.slice(0, 19), timeZone: t.timeZone }
}

/** The recurrence mapping; a string is the refusal. */
export function graphRecurrence(d: CalendarEventDraft): Obj | string | null {
  if (!d.recurrenceRules?.length) return null
  const rule = parseRule(d.recurrenceRules)
  const first = d.timeOptions[0]
  if (!rule || !first) return COPY.msRepeat
  let pattern: Obj
  if (rule.frequency === 'DAILY') pattern = { type: 'daily', interval: rule.interval }
  else if (rule.frequency === 'WEEKLY') {
    const days = (rule.weekdays.length ? rule.weekdays : [WEEKDAYS[new Date(`${('date' in first.start ? first.start.date : first.start.dateTime.slice(0, 10))}T12:00:00Z`).getUTCDay()] ?? 'MO']).map((x) => GRAPH_DAYS[x] ?? 'monday')
    pattern = { type: 'weekly', interval: rule.interval, daysOfWeek: days, firstDayOfWeek: 'monday' }
  } else if (rule.weekOfMonth !== null) {
    const index = GRAPH_INDEX[rule.weekOfMonth]
    if (!index) return COPY.msRepeat
    pattern = { type: 'relativeMonthly', interval: rule.interval, daysOfWeek: [GRAPH_DAYS[rule.weekdays[0] ?? 'MO'] ?? 'monday'], index }
  } else if (rule.monthDay !== null) pattern = { type: 'absoluteMonthly', interval: rule.interval, dayOfMonth: rule.monthDay }
  else return COPY.msRepeat
  const startDate = 'date' in first.start ? first.start.date : first.start.dateTime.slice(0, 10)
  const tz = 'timeZone' in first.start ? first.start.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone
  const range: Obj = rule.count
    ? { type: 'numbered', startDate, numberOfOccurrences: rule.count, recurrenceTimeZone: tz }
    : rule.until
      ? { type: 'endDate', startDate, endDate: rule.until, recurrenceTimeZone: tz }
      : { type: 'noEnd', startDate, recurrenceTimeZone: tz }
  return { pattern, range }
}

function graphBody(d: CalendarEventDraft, blockId: string, me: string | null, recurrence: Obj | null): Obj {
  const t = chosenTime(d)
  const { location, description } = withCustomLink(d)
  const allDay = !!t && 'date' in t.start
  const body: Obj = {
    subject: d.summary || 'Untitled event',
    body: { contentType: 'text', content: description },
    start: t ? graphTime(t.start) : undefined,
    end: t ? graphTime(t.end) : undefined,
    attendees: attendeeList(d, me)
      .filter((a) => !me || a.email.toLowerCase() !== me.toLowerCase())
      .map((a) => ({ emailAddress: { address: a.email }, type: a.resource ? 'resource' : 'required' })),
    transactionId: blockId
  }
  if (allDay) body['isAllDay'] = true
  if (location) body['location'] = { displayName: location }
  if (d.conference.kind === 'googleMeet' && isWorkAccount(me)) {
    body['isOnlineMeeting'] = true
    body['onlineMeetingProvider'] = 'teamsForBusiness'
  }
  if (recurrence) body['recurrence'] = recurrence
  return body
}

export async function graphCreate(ctx: MainContext, token: string, t: WriteTarget, d: CalendarEventDraft, blockId: string): Promise<ExecResult> {
  const recurrence = graphRecurrence(d)
  if (typeof recurrence === 'string') return { status: 'failed', errorCode: 'invalid', error: recurrence }
  const http = providerHttp(ctx, 'calendar', 'calendar-write')
  const x = await exchange(() =>
    http.fetch('https://graph.microsoft.com/v1.0/me/calendars/{id}/events', {
      method: 'POST',
      params: { id: t.calendarNativeId },
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(graphBody(d, blockId, t.accountEmail, recurrence))
    })
  )
  if (x.ok) return { status: 'created', fields: { eventId: str(x.body['id']), calendarId: t.calendarNativeId, htmlLink: str(x.body['webLink']) } }
  return failed(x, true)
}

export async function graphUpdate(ctx: MainContext, token: string, t: WriteTarget, d: CalendarEventDraft): Promise<ExecResult> {
  const ex = d.existingEvent
  const r = diffDraft(d)
  if (!ex || 'refusal' in r) return { status: 'failed', errorCode: 'invalid', error: 'refusal' in r ? r.refusal : COPY.other }
  const http = providerHttp(ctx, 'calendar', 'calendar-write')
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }
  const cur = await exchange(() => http.fetch('https://graph.microsoft.com/v1.0/me/events/{id}', { params: { id: ex.eventId }, headers }))
  if (!cur.ok) return failed(cur, false)
  if (ex.etag && str(cur.body['changeKey']) !== ex.etag) return { status: 'failed', errorCode: 'etag_mismatch', error: COPY.etag }
  const target = ex.scope === 'series' ? (str(cur.body['seriesMasterId']) ?? ex.eventId) : ex.eventId
  const p: Obj = {}
  const diff = r.diff
  if (diff.title !== undefined) p['subject'] = diff.title || 'Untitled event'
  if (diff.description !== undefined) p['body'] = { contentType: 'text', content: diff.description }
  if (diff.location !== undefined) p['location'] = { displayName: diff.location }
  if (diff.time) {
    p['start'] = graphTime(diff.time.start)
    p['end'] = graphTime(diff.time.end)
  }
  if (diff.addAttendees.length || diff.removeAttendees.length) {
    const drop = new Set(diff.removeAttendees.map((e) => e.toLowerCase()))
    const kept = (Array.isArray(cur.body['attendees']) ? (cur.body['attendees'] as Obj[]) : []).filter((a) => !drop.has(String(obj(a['emailAddress'])['address'] ?? '').toLowerCase()))
    p['attendees'] = [...kept, ...diff.addAttendees.map((a) => ({ emailAddress: { address: a.email }, type: a.resource ? 'resource' : 'required' }))]
  }
  if (diff.conference?.kind === 'googleMeet' && isWorkAccount(t.accountEmail)) {
    p['isOnlineMeeting'] = true
    p['onlineMeetingProvider'] = 'teamsForBusiness'
  } else if (diff.conference?.kind === 'none') p['isOnlineMeeting'] = false
  else if (diff.conference?.kind === 'custom' && diff.location === undefined && !str(obj(cur.body['location'])['displayName'])) p['location'] = { displayName: diff.conference.url }
  const x = await exchange(() =>
    http.fetch('https://graph.microsoft.com/v1.0/me/events/{id}', { method: 'PATCH', params: { id: target }, headers, body: JSON.stringify(p) })
  )
  if (x.ok) return { status: 'updated', fields: { eventId: str(x.body['id']) ?? target, calendarId: t.calendarNativeId, htmlLink: str(x.body['webLink']) } }
  return failed(x, true)
}
