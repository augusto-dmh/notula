// SPDX-License-Identifier: Apache-2.0
// Calendar writes: Google Calendar events insert / patch and
// Microsoft Graph events, from the main process only, with the account's `calendar-write` token.
// Idempotency: Google `id` = the block id without dashes, Graph `transactionId` = the block id, so a
// second click or a "Try again" after `unknown` creates no second event.

import type { CalendarDraftTime, CalendarEventDraft } from '@shared/types/workflow-blocks'
import type { CalendarEvent } from '@shared/types/notes'
import type { MainContext } from '../context'
import { log } from '../log'
import type { ExecResult } from '../blocks'
import { utcBasic, utcMsToZonedWall } from '../calendar/tz'
import { chosenTime, diffDraft, localDate, parseRule, WEEKDAYS, type DraftDiff } from './draft'
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
  split: 'Your calendar changed while saving. Ask again for a fresh draft.',
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
export function failed(x: Exclude<Exchange, { ok: true }>, write: boolean): ExecResult {
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
  if (d.colorId && d.colorId !== 'default') body['colorId'] = d.colorId
  if (d.visibility) body['visibility'] = d.visibility
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

const googleEventUrl = 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}'

export async function googleUpdate(ctx: MainContext, token: string, t: WriteTarget, d: CalendarEventDraft): Promise<ExecResult> {
  const ex = d.existingEvent
  const r = diffDraft(d)
  if (!ex || 'refusal' in r) return { status: 'failed', errorCode: 'invalid', error: 'refusal' in r ? r.refusal : COPY.other }
  const http = providerHttp(ctx, 'calendar', 'calendar-write')
  const headers = googleHeaders(token)
  const cur = await exchange(() => http.fetch(googleEventUrl, { params: { calendarId: t.calendarNativeId, eventId: ex.eventId }, headers }))
  if (!cur.ok) return failed(cur, false)
  if (ex.etag && str(cur.body['etag']) !== ex.etag) return { status: 'failed', errorCode: 'etag_mismatch', error: COPY.etag }
  const masterId = ex.scope === 'series' ? str(cur.body['recurringEventId']) : null
  let current = cur.body
  if (masterId) {
    // A series edit writes to the master, under the master's own etag.
    const m = await exchange(() => http.fetch(googleEventUrl, { params: { calendarId: t.calendarNativeId, eventId: masterId }, headers }))
    if (!m.ok) return failed(m, false)
    if (ex.seriesEtag && str(m.body['etag']) !== ex.seriesEtag) return { status: 'failed', errorCode: 'etag_mismatch', error: COPY.etag }
    current = m.body
  }
  const target = masterId ?? ex.eventId
  const x = await exchange(() =>
    http.fetch(googleEventUrl, {
      method: 'PATCH',
      params: { calendarId: t.calendarNativeId, eventId: target },
      query: { conferenceDataVersion: '1', sendUpdates: googleHasGuests(current) || r.diff.addAttendees.length ? 'all' : 'none' },
      headers: { ...headers, 'if-match': str(current['etag']) ?? '*' },
      body: JSON.stringify(googlePatch(r.diff, current))
    })
  )
  if (x.ok) return { status: 'updated', fields: { eventId: str(x.body['id']) ?? target, calendarId: t.calendarNativeId, htmlLink: str(x.body['htmlLink']) } }
  return failed(x, true)
}

export const googleHeaders = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' })
export const googleHasGuests = (ev: Obj): boolean => Array.isArray(ev['attendees']) && (ev['attendees'] as Obj[]).some((a) => a['self'] !== true && a['resource'] !== true)

/** The day before a `YYYY-MM-DD` date. */
export function dayBefore(date: string): string {
  return new Date(Date.parse(`${date}T12:00:00Z`) - 86_400_000).toISOString().slice(0, 10)
}

/**
 * A master's recurrence that ends just before an occurrence: the RRULE loses COUNT and gets
 * UNTIL one second before the occurrence's start in UTC, or the previous date for an all-day
 * series. The other lines stay.
 */
export function endBefore(recurrence: string[], occurrence: CalendarDraftTime): string[] {
  const until = 'date' in occurrence ? dayBefore(occurrence.date).replace(/-/g, '') : utcBasic(Date.parse(occurrence.dateTime) - 1_000)
  return recurrence.map((line) => {
    if (!line.startsWith('RRULE:')) return line
    const parts = line
      .slice(6)
      .split(';')
      .filter((p) => p && !/^(COUNT|UNTIL)=/.test(p))
    return `RRULE:${[...parts, `UNTIL=${until}`].join(';')}`
  })
}

/** The same lines with the RRULE's COUNT set to `count`. */
function withCount(recurrence: string[], count: number): string[] {
  return recurrence.map((line) => (line.startsWith('RRULE:') ? line.replace(/(^RRULE:|;)COUNT=\d+/, `$1COUNT=${Math.max(1, count)}`) : line))
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === 'string') : [])

/** A Google occurrence's original start (before any move). */
export function googleOriginalStart(instance: Obj, fallback: CalendarDraftTime | undefined): CalendarDraftTime | null {
  const o = obj(instance['originalStartTime'])
  if (typeof o['date'] === 'string') return { date: o['date'] }
  if (typeof o['dateTime'] === 'string') return { dateTime: o['dateTime'], timeZone: str(o['timeZone']) ?? 'UTC' }
  return fallback ?? null
}

/** The master's fields a split carries over to the new series; guests answer the new invitation afresh. */
const GOOGLE_SERIES_FIELDS = ['summary', 'description', 'location', 'conferenceData', 'reminders', 'colorId', 'visibility', 'transparency', 'guestsCanInviteOthers', 'guestsCanModify', 'guestsCanSeeOtherGuests'] as const

function googleSeriesCopy(master: Obj): Obj {
  const out: Obj = {}
  for (const k of GOOGLE_SERIES_FIELDS) if (master[k] !== undefined) out[k] = master[k]
  if (Array.isArray(master['attendees'])) {
    out['attendees'] = (master['attendees'] as Obj[]).map((a) => {
      const { comment: _c, responseStatus, ...rest } = a
      return { ...rest, responseStatus: a['self'] === true ? (responseStatus ?? 'accepted') : 'needsAction' }
    })
  }
  return out
}

/**
 * "This and later": the occurrence and the ones after it become a new series, and the master
 * ends just before it. The new series is inserted first; when the master can't be trimmed,
 * the new series is deleted again.
 */
export async function googleSplit(ctx: MainContext, token: string, t: WriteTarget, d: CalendarEventDraft, blockId: string): Promise<ExecResult> {
  const ex = d.existingEvent
  const r = diffDraft(d)
  if (!ex || 'refusal' in r) return { status: 'failed', errorCode: 'invalid', error: 'refusal' in r ? r.refusal : COPY.other }
  const time = chosenTime(d)
  if (!time) return { status: 'failed', errorCode: 'invalid', error: 'Choose a time' }
  const http = providerHttp(ctx, 'calendar', 'calendar-write')
  const headers = googleHeaders(token)
  const calendarId = t.calendarNativeId
  const step = (name: string, ok: boolean): void => log('info', 'calendar-write:split', { provider: 'google', step: name, ok })

  // 1. The occurrence, then its series master and the master's etag.
  const cur = await exchange(() => http.fetch(googleEventUrl, { params: { calendarId, eventId: ex.eventId }, headers }))
  if (!cur.ok) return failed(cur, false)
  if (ex.etag && str(cur.body['etag']) !== ex.etag) return { status: 'failed', errorCode: 'etag_mismatch', error: COPY.etag }
  const masterId = str(cur.body['recurringEventId'])
  if (!masterId) return googleUpdate(ctx, token, t, { ...d, existingEvent: { ...ex, scope: 'occurrence' } })
  const m = await exchange(() => http.fetch(googleEventUrl, { params: { calendarId, eventId: masterId }, headers }))
  step('master', m.ok)
  if (!m.ok) return failed(m, false)
  const master = m.body
  const seriesEtag = str(master['etag'])
  if (ex.seriesEtag && seriesEtag !== ex.seriesEtag) return { status: 'failed', errorCode: 'etag_mismatch', error: COPY.etag }
  const occurrence = googleOriginalStart(cur.body, ex.occurrenceStart)
  if (!occurrence) return { status: 'failed', errorCode: 'invalid', error: COPY.other }
  const masterRules = strings(master['recurrence'])

  // 2. The new series from this occurrence on: the draft's rule, else the master's with what's left of its COUNT.
  let recurrence = r.diff.recurrence ?? masterRules
  const count = parseRule(masterRules)?.count ?? null
  if (!r.diff.recurrence && count !== null) {
    const before = await googleCountBefore(ctx, token, calendarId, masterId, occurrence)
    if (before === null) return { status: 'failed', errorCode: 'network', error: COPY.network }
    recurrence = withCount(masterRules, count - before)
  }
  const copy = googleSeriesCopy(master)
  const body: Obj = { ...copy, ...googlePatch(r.diff, { ...master, ...copy }) }
  body['id'] = blockId.replace(/-/g, '').toLowerCase()
  body['start'] = time.start
  body['end'] = time.end
  body['recurrence'] = recurrence
  const conference = obj(body['conferenceData'])
  if (body['conferenceData'] && conference['createRequest'] === undefined) {
    // The same video link: its solution and entry points, without the master's request.
    const { createRequest: _r, ...same } = conference
    body['conferenceData'] = same
  }
  const sendUpdates = googleHasGuests(master) || r.diff.addAttendees.length ? 'all' : 'none'
  const created = await exchange(() =>
    http.fetch('https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events', {
      method: 'POST',
      params: { calendarId },
      query: { conferenceDataVersion: '1', sendUpdates },
      headers,
      body: JSON.stringify(body)
    })
  )
  step('insert', created.ok)
  // The same id exists: an earlier try inserted it, so this one carries on from there.
  const made = !created.ok && created.kind === 'http' && created.status === 409 ? await exchange(() => http.fetch(googleEventUrl, { params: { calendarId, eventId: String(body['id']) }, headers })) : created
  if (!made.ok) return failed(made, true)
  const newId = str(made.body['id']) ?? String(body['id'])

  // 3. The master ends before this occurrence, under the etag read in step 1.
  const trimmed = await exchange(() =>
    http.fetch(googleEventUrl, {
      method: 'PATCH',
      params: { calendarId, eventId: masterId },
      query: { sendUpdates },
      headers: { ...headers, 'if-match': seriesEtag ?? '*' },
      body: JSON.stringify({ recurrence: endBefore(masterRules, occurrence) })
    })
  )
  step('trim', trimmed.ok)
  if (!trimmed.ok) {
    // A timeout may have trimmed it: two overlapping series are safer than a lost one.
    if (trimmed.kind === 'uncertain') return { status: 'unknown', errorCode: 'timeout', error: COPY.unknown }
    const undo = await exchange(() => http.fetch(googleEventUrl, { method: 'DELETE', params: { calendarId, eventId: newId }, query: { sendUpdates }, headers }))
    step('rollback', undo.ok)
    return { status: 'failed', errorCode: trimmed.kind === 'http' && trimmed.status === 412 ? 'etag_mismatch' : 'split_failed', error: COPY.split }
  }
  return { status: 'updated', fields: { eventId: newId, calendarId, htmlLink: str(made.body['htmlLink']) } }
}

/** How many occurrences of a series start before one of them; null when Google can't say. */
async function googleCountBefore(ctx: MainContext, token: string, calendarId: string, masterId: string, occurrence: CalendarDraftTime): Promise<number | null> {
  const http = providerHttp(ctx, 'calendar', 'calendar-write')
  const at = startMs(occurrence)
  const x = await exchange(() =>
    http.fetch('https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}/instances', {
      params: { calendarId, eventId: masterId },
      query: { timeMax: new Date(at).toISOString(), showDeleted: 'true', maxResults: '2500' },
      headers: googleHeaders(token)
    })
  )
  if (!x.ok) return null
  const items = Array.isArray(x.body['items']) ? (x.body['items'] as Obj[]) : []
  return items.filter((i) => {
    const o = googleOriginalStart(i, undefined)
    return !o || startMs(o) < at
  }).length
}

/** A draft time as an instant; an all-day date as its UTC midnight. */
export const startMs = (t: CalendarDraftTime): number => ('date' in t ? Date.parse(`${t.date}T00:00:00Z`) : Date.parse(t.dateTime))

// ---------- Microsoft Graph ----------

const GRAPH_DAYS: Record<string, string> = { SU: 'sunday', MO: 'monday', TU: 'tuesday', WE: 'wednesday', TH: 'thursday', FR: 'friday', SA: 'saturday' }
const GRAPH_INDEX: Record<number, string> = { 1: 'first', 2: 'second', 3: 'third', 4: 'fourth', [-1]: 'last' }
/** Graph has no event colors; `sensitivity` stands in for visibility. */
const SENSITIVITY: Record<NonNullable<CalendarEventDraft['visibility']>, string> = { default: 'normal', public: 'normal', private: 'private' }

function graphTime(t: { dateTime: string; timeZone: string } | { date: string }): Obj {
  return 'date' in t ? { dateTime: `${t.date}T00:00:00`, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone } : { dateTime: t.dateTime.slice(0, 19), timeZone: t.timeZone }
}

/** The recurrence mapping; a string is the refusal. */
export function graphRecurrence(d: CalendarEventDraft): Obj | string | null {
  if (!d.recurrenceRules?.length) return null
  const rule = parseRule(d.recurrenceRules)
  const first = d.timeOptions[0]
  if (!rule || !first) return COPY.msRepeat
  const startDate = 'date' in first.start ? first.start.date : first.start.dateTime.slice(0, 10)
  let pattern: Obj
  if (rule.frequency === 'DAILY') pattern = { type: 'daily', interval: rule.interval }
  else if (rule.frequency === 'WEEKLY') {
    const days = (rule.weekdays.length ? rule.weekdays : [WEEKDAYS[new Date(`${startDate}T12:00:00Z`).getUTCDay()] ?? 'MO']).map((x) => GRAPH_DAYS[x] ?? 'monday')
    pattern = { type: 'weekly', interval: rule.interval, daysOfWeek: days, firstDayOfWeek: 'monday' }
  } else {
    const yearly = rule.frequency === 'YEARLY'
    const month = yearly ? { month: rule.month ?? Number(startDate.slice(5, 7)) } : {}
    if (rule.weekOfMonth !== null) {
      const index = GRAPH_INDEX[rule.weekOfMonth]
      if (!index) return COPY.msRepeat
      pattern = { type: yearly ? 'relativeYearly' : 'relativeMonthly', interval: rule.interval, daysOfWeek: [GRAPH_DAYS[rule.weekdays[0] ?? 'MO'] ?? 'monday'], index, ...month }
    } else if (rule.monthDay !== null || yearly) {
      // Graph's day of month is 1–31: there is no "last day".
      const day = rule.monthDay ?? Number(startDate.slice(8, 10))
      if (day < 1) return COPY.msRepeat
      pattern = { type: yearly ? 'absoluteYearly' : 'absoluteMonthly', interval: rule.interval, dayOfMonth: day, ...month }
    } else return COPY.msRepeat
  }
  const tz = 'timeZone' in first.start ? first.start.timeZone : Intl.DateTimeFormat().resolvedOptions().timeZone
  const range: Obj = rule.count
    ? { type: 'numbered', startDate, numberOfOccurrences: rule.count, recurrenceTimeZone: tz }
    : rule.until
      ? { type: 'endDate', startDate, endDate: rule.until, recurrenceTimeZone: tz }
      : { type: 'noEnd', startDate, recurrenceTimeZone: tz }
  return { pattern, range }
}

const RRULE_DAYS: Record<string, string> = Object.fromEntries(Object.entries(GRAPH_DAYS).map(([k, v]) => [v, k]))
const RRULE_INDEX: Record<string, number> = { first: 1, second: 2, third: 3, fourth: 4, last: -1 }

/** A Graph recurrence as the RRULE line Notula's drafts carry; null when it has no such line. */
export function rruleFromGraph(recurrence: unknown): string | null {
  const pattern = obj(obj(recurrence)['pattern'])
  const range = obj(obj(recurrence)['range'])
  const interval = Number(pattern['interval'] ?? 1) || 1
  const days = (Array.isArray(pattern['daysOfWeek']) ? (pattern['daysOfWeek'] as unknown[]) : []).map((d) => RRULE_DAYS[String(d).toLowerCase()]).filter(Boolean)
  const index = RRULE_INDEX[String(pattern['index'] ?? 'first')] ?? 1
  const parts: string[] = []
  switch (pattern['type']) {
    case 'daily':
      parts.push('FREQ=DAILY')
      break
    case 'weekly':
      parts.push('FREQ=WEEKLY', ...(days.length ? [`BYDAY=${days.join(',')}`] : []))
      break
    case 'absoluteMonthly':
      parts.push('FREQ=MONTHLY', `BYMONTHDAY=${Number(pattern['dayOfMonth']) || 1}`)
      break
    case 'relativeMonthly':
      parts.push('FREQ=MONTHLY', `BYDAY=${index}${days[0] ?? 'MO'}`)
      break
    case 'absoluteYearly':
      parts.push('FREQ=YEARLY', `BYMONTH=${Number(pattern['month']) || 1}`, `BYMONTHDAY=${Number(pattern['dayOfMonth']) || 1}`)
      break
    case 'relativeYearly':
      parts.push('FREQ=YEARLY', `BYMONTH=${Number(pattern['month']) || 1}`, `BYDAY=${index}${days[0] ?? 'MO'}`)
      break
    default:
      return null
  }
  if (interval > 1) parts.splice(1, 0, `INTERVAL=${interval}`)
  if (range['type'] === 'numbered') parts.push(`COUNT=${Number(range['numberOfOccurrences']) || 1}`)
  else if (range['type'] === 'endDate' && typeof range['endDate'] === 'string') parts.push(`UNTIL=${range['endDate'].replace(/-/g, '')}`)
  return `RRULE:${parts.join(';')}`
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
  if (d.visibility) body['sensitivity'] = SENSITIVITY[d.visibility]
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

/** The PATCH body of a diff, against the event as Graph has it now. */
function graphPatch(diff: DraftDiff, current: Obj, me: string | null): Obj {
  const p: Obj = {}
  if (diff.title !== undefined) p['subject'] = diff.title || 'Untitled event'
  if (diff.description !== undefined) p['body'] = { contentType: 'text', content: diff.description }
  if (diff.location !== undefined) p['location'] = { displayName: diff.location }
  if (diff.time) {
    p['start'] = graphTime(diff.time.start)
    p['end'] = graphTime(diff.time.end)
  }
  if (diff.addAttendees.length || diff.removeAttendees.length) {
    const drop = new Set(diff.removeAttendees.map((e) => e.toLowerCase()))
    const kept = (Array.isArray(current['attendees']) ? (current['attendees'] as Obj[]) : []).filter((a) => !drop.has(String(obj(a['emailAddress'])['address'] ?? '').toLowerCase()))
    p['attendees'] = [...kept, ...diff.addAttendees.map((a) => ({ emailAddress: { address: a.email }, type: a.resource ? 'resource' : 'required' }))]
  }
  if (diff.conference?.kind === 'googleMeet' && isWorkAccount(me)) {
    p['isOnlineMeeting'] = true
    p['onlineMeetingProvider'] = 'teamsForBusiness'
  } else if (diff.conference?.kind === 'none') p['isOnlineMeeting'] = false
  else if (diff.conference?.kind === 'custom' && diff.location === undefined && !str(obj(current['location'])['displayName'])) p['location'] = { displayName: diff.conference.url }
  if (diff.visibility !== undefined) p['sensitivity'] = SENSITIVITY[diff.visibility]
  return p
}

const graphHeaders = (token: string): Record<string, string> => ({ authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' })
const graphEventUrl = 'https://graph.microsoft.com/v1.0/me/events/{id}'

export async function graphUpdate(ctx: MainContext, token: string, t: WriteTarget, d: CalendarEventDraft): Promise<ExecResult> {
  const ex = d.existingEvent
  const r = diffDraft(d)
  if (!ex || 'refusal' in r) return { status: 'failed', errorCode: 'invalid', error: 'refusal' in r ? r.refusal : COPY.other }
  const http = providerHttp(ctx, 'calendar', 'calendar-write')
  const headers = graphHeaders(token)
  const cur = await exchange(() => http.fetch(graphEventUrl, { params: { id: ex.eventId }, headers }))
  if (!cur.ok) return failed(cur, false)
  if (ex.etag && str(cur.body['changeKey']) !== ex.etag) return { status: 'failed', errorCode: 'etag_mismatch', error: COPY.etag }
  const target = ex.scope === 'series' ? (str(cur.body['seriesMasterId']) ?? ex.eventId) : ex.eventId
  const p = graphPatch(r.diff, cur.body, t.accountEmail)
  if (r.diff.recurrence) {
    const recurrence = graphRecurrence(d)
    if (typeof recurrence === 'string') return { status: 'failed', errorCode: 'invalid', error: recurrence }
    if (recurrence) {
      // The series keeps its first date; only the pattern and the end change.
      const m = target === ex.eventId ? cur : await exchange(() => http.fetch(graphEventUrl, { params: { id: target }, headers }))
      if (!m.ok) return failed(m, false)
      if (target !== ex.eventId && ex.seriesEtag && str(m.body['changeKey']) !== ex.seriesEtag) return { status: 'failed', errorCode: 'etag_mismatch', error: COPY.etag }
      const startDate = str(obj(obj(m.body['recurrence'])['range'])['startDate'])
      p['recurrence'] = startDate ? { ...recurrence, range: { ...obj(recurrence['range']), startDate } } : recurrence
    }
  }
  const x = await exchange(() => http.fetch(graphEventUrl, { method: 'PATCH', params: { id: target }, headers, body: JSON.stringify(p) }))
  if (x.ok) return { status: 'updated', fields: { eventId: str(x.body['id']) ?? target, calendarId: t.calendarNativeId, htmlLink: str(x.body['webLink']) } }
  return failed(x, true)
}

/** The master's fields a split carries over to the new series; guests answer the new invitation afresh. */
const GRAPH_SERIES_FIELDS = ['subject', 'body', 'location', 'isOnlineMeeting', 'onlineMeetingProvider', 'sensitivity', 'showAs', 'categories', 'importance', 'isReminderOn', 'reminderMinutesBeforeStart', 'isAllDay'] as const

function graphSeriesCopy(master: Obj): Obj {
  const out: Obj = {}
  for (const k of GRAPH_SERIES_FIELDS) if (master[k] !== undefined && master[k] !== null) out[k] = master[k]
  if (Array.isArray(master['attendees'])) out['attendees'] = (master['attendees'] as Obj[]).map((a) => ({ emailAddress: a['emailAddress'], type: a['type'] ?? 'required' }))
  return out
}

/** A Graph occurrence's original local date, in the zone of the draft's time. */
function graphOriginalDate(instance: Obj, ex: NonNullable<CalendarEventDraft['existingEvent']>, time: { start: CalendarDraftTime }): string {
  const original = str(instance['originalStart'])
  const zone = 'timeZone' in time.start ? time.start.timeZone : null
  const ms = original ? Date.parse(original) : NaN
  if (!Number.isNaN(ms) && zone) {
    const w = utcMsToZonedWall(ms, zone)
    return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`
  }
  return localDate(ex.occurrenceStart ?? time.start)
}

/** "This and later" on Microsoft: the same three steps as Google, on `seriesMasterId`. */
export async function graphSplit(ctx: MainContext, token: string, t: WriteTarget, d: CalendarEventDraft, blockId: string): Promise<ExecResult> {
  const ex = d.existingEvent
  const r = diffDraft(d)
  if (!ex || 'refusal' in r) return { status: 'failed', errorCode: 'invalid', error: 'refusal' in r ? r.refusal : COPY.other }
  const time = chosenTime(d)
  if (!time) return { status: 'failed', errorCode: 'invalid', error: 'Choose a time' }
  const http = providerHttp(ctx, 'calendar', 'calendar-write')
  const headers = graphHeaders(token)
  const step = (name: string, ok: boolean): void => log('info', 'calendar-write:split', { provider: 'microsoft', step: name, ok })

  // 1. The occurrence, its series master and the master's etag.
  const cur = await exchange(() => http.fetch(graphEventUrl, { params: { id: ex.eventId }, headers }))
  if (!cur.ok) return failed(cur, false)
  if (ex.etag && str(cur.body['changeKey']) !== ex.etag) return { status: 'failed', errorCode: 'etag_mismatch', error: COPY.etag }
  const masterId = str(cur.body['seriesMasterId'])
  if (!masterId) return graphUpdate(ctx, token, t, { ...d, existingEvent: { ...ex, scope: 'occurrence' } })
  const m = await exchange(() => http.fetch(graphEventUrl, { params: { id: masterId }, headers }))
  step('master', m.ok)
  if (!m.ok) return failed(m, false)
  const master = m.body
  if (ex.seriesEtag && str(master['changeKey']) !== ex.seriesEtag) return { status: 'failed', errorCode: 'etag_mismatch', error: COPY.etag }
  const etag = str(master['@odata.etag'])
  const masterRecurrence = obj(master['recurrence'])
  const range = obj(masterRecurrence['range'])
  const originalDate = graphOriginalDate(cur.body, ex, time)
  const newStart = localDate(time.start)

  // 2. The new series: the draft's rule, else the master's from this date with what's left of its count.
  let recurrence: Obj
  if (r.diff.recurrence) {
    const mapped = graphRecurrence(d)
    if (typeof mapped === 'string') return { status: 'failed', errorCode: 'invalid', error: mapped }
    if (!mapped) return { status: 'failed', errorCode: 'invalid', error: COPY.msRepeat }
    recurrence = mapped
  } else {
    const next: Obj = { ...range, startDate: newStart }
    if (range['type'] === 'numbered') {
      const before = await graphCountBefore(ctx, token, masterId, str(range['startDate']) ?? originalDate, str(cur.body['originalStart']) ?? `${originalDate}T00:00:00Z`)
      if (before === null) return { status: 'failed', errorCode: 'network', error: COPY.network }
      next['numberOfOccurrences'] = Math.max(1, Number(range['numberOfOccurrences'] ?? 1) - before)
    }
    recurrence = { ...masterRecurrence, range: next }
  }
  const copy = graphSeriesCopy(master)
  const body: Obj = { ...copy, ...graphPatch(r.diff, { ...master, ...copy }, t.accountEmail) }
  body['start'] = graphTime(time.start)
  body['end'] = graphTime(time.end)
  body['recurrence'] = recurrence
  body['transactionId'] = blockId
  const created = await exchange(() =>
    http.fetch('https://graph.microsoft.com/v1.0/me/calendars/{id}/events', { method: 'POST', params: { id: t.calendarNativeId }, headers, body: JSON.stringify(body) })
  )
  step('insert', created.ok)
  if (!created.ok) return failed(created, true)
  const newId = str(created.body['id'])

  // 3. The master's range ends the day before this occurrence.
  const end: Obj = { type: 'endDate', startDate: range['startDate'], endDate: dayBefore(originalDate), ...(range['recurrenceTimeZone'] ? { recurrenceTimeZone: range['recurrenceTimeZone'] } : {}) }
  const trimmed = await exchange(() =>
    http.fetch(graphEventUrl, {
      method: 'PATCH',
      params: { id: masterId },
      headers: { ...headers, ...(etag ? { 'if-match': etag } : {}) },
      body: JSON.stringify({ recurrence: { ...masterRecurrence, range: end } })
    })
  )
  step('trim', trimmed.ok)
  if (!trimmed.ok) {
    if (trimmed.kind === 'uncertain') return { status: 'unknown', errorCode: 'timeout', error: COPY.unknown }
    if (newId) {
      const undo = await exchange(() => http.fetch(graphEventUrl, { method: 'DELETE', params: { id: newId }, headers }))
      step('rollback', undo.ok)
    }
    return { status: 'failed', errorCode: trimmed.kind === 'http' && trimmed.status === 412 ? 'etag_mismatch' : 'split_failed', error: COPY.split }
  }
  return { status: 'updated', fields: { eventId: newId, calendarId: t.calendarNativeId, htmlLink: str(created.body['webLink']) } }
}

/** How many occurrences of a Graph series start before `beforeIso`; null when Graph can't say. */
async function graphCountBefore(ctx: MainContext, token: string, masterId: string, seriesStart: string, beforeIso: string): Promise<number | null> {
  const http = providerHttp(ctx, 'calendar', 'calendar-write')
  const x = await exchange(() =>
    http.fetch('https://graph.microsoft.com/v1.0/me/events/{id}/instances', {
      params: { id: masterId },
      query: { startDateTime: `${seriesStart}T00:00:00Z`, endDateTime: beforeIso, $select: 'id,originalStart', $top: '1000' },
      headers: graphHeaders(token)
    })
  )
  if (!x.ok) return null
  const before = Date.parse(beforeIso)
  return (Array.isArray(x.body['value']) ? (x.body['value'] as Obj[]) : []).filter((i) => {
    const o = Date.parse(str(i['originalStart']) ?? '')
    return Number.isNaN(o) || o < before
  }).length
}

// ---------- synced events ----------

/** Where a synced event lives: `<provider>:<sourceId>:<native id>`, for both the event and its calendar. */
export interface EventRef {
  provider: 'google' | 'microsoft'
  sourceId: string
  eventId: string
  /** The series master's id, when the event repeats. */
  seriesId: string | null
  calendarNativeId: string
  organizer: boolean
}

export function eventRef(ev: CalendarEvent): EventRef | null {
  const m = /^(google|microsoft):([^:]+):(.+)$/.exec(ev.id)
  if (!m) return null
  const cal = /^(google|microsoft):[^:]+:(.+)$/.exec(typeof ev['calendarId'] === 'string' ? ev['calendarId'] : '')
  return {
    provider: m[1] as 'google' | 'microsoft',
    sourceId: m[2] ?? '',
    eventId: m[3] ?? '',
    seriesId: str(ev['recurringEventId']),
    calendarNativeId: cal?.[2] ?? 'primary',
    organizer: obj(ev['organizer'])['self'] === true
  }
}

/** The account's `calendar-write` token, or the outcome that stops the write. */
export async function writeToken(ctx: MainContext, sourceId: string): Promise<string | ExecResult> {
  try {
    return await ctx.calendar.accessToken(sourceId, 'calendar-write')
  } catch (err) {
    const code = err instanceof Error && /missing_scopes/.test(err.message) ? 'missing_scopes' : 'missing_token'
    return { status: 'failed', errorCode: code, error: code === 'missing_scopes' ? COPY.missingScopes : COPY.reconnect }
  }
}

/** A repeating event's series: its recurrence lines and its etag (Google) or change key (Microsoft). Null when it can't be read. */
export async function seriesMaster(ctx: MainContext, ref: EventRef): Promise<{ rules: string[]; etag: string } | null> {
  if (!ref.seriesId) return null
  let token: string
  try {
    token = await ctx.calendar.accessToken(ref.sourceId, null)
  } catch {
    return null
  }
  const http = providerHttp(ctx, 'calendar', 'calendar-read')
  if (ref.provider === 'google') {
    const x = await exchange(() => http.fetch(googleEventUrl, { params: { calendarId: ref.calendarNativeId, eventId: ref.seriesId ?? '' }, headers: googleHeaders(token) }))
    if (!x.ok) return null
    return { rules: strings(x.body['recurrence']).filter((l) => /^(RRULE|EXRULE|RDATE|EXDATE)[:;]/.test(l)), etag: str(x.body['etag']) ?? '' }
  }
  const x = await exchange(() => http.fetch(graphEventUrl, { params: { id: ref.seriesId ?? '' }, headers: graphHeaders(token) }))
  if (!x.ok) return null
  const rule = rruleFromGraph(x.body['recurrence'])
  return { rules: rule ? [rule] : [], etag: str(x.body['changeKey']) ?? '' }
}
