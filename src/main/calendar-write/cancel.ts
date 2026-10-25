// SPDX-License-Identifier: Apache-2.0
// Cancelling an event for the user: one occurrence, or this one and the later ones (the series
// master then ends before it). There is no whole-series delete. Guests hear about it only when
// `notify` is on, as far as the provider allows. Logs carry the provider and the notify choice.

import type { CalendarDraftTime } from '@shared/types/workflow-blocks'
import type { CalendarEvent } from '@shared/types/notes'
import type { ExecResult } from '../blocks'
import type { MainContext } from '../context'
import { log } from '../log'
import { egressBlocked } from '../privacy'
import { ianaZoneFor, utcMsToZonedWall } from '../calendar/tz'
import { exchange, providerHttp } from './http'
import { COPY, dayBefore, endBefore, eventRef, failed, googleHeaders, googleOriginalStart, startMs, writeToken, type EventRef } from './providers'

export const CANCEL_COPY = {
  graphSilent: 'Microsoft may still tell the guests.'
} as const

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

const googleEventUrl = 'https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events/{eventId}'
const graphEventUrl = 'https://graph.microsoft.com/v1.0/me/events/{id}'

export async function cancelEvent(ctx: MainContext, event: CalendarEvent, scope: 'occurrence' | 'following', notify: boolean): Promise<ExecResult> {
  const ref = eventRef(event)
  if (!ref) return { status: 'failed', errorCode: 'invalid', error: 'Calendar feeds are read-only, so this event can’t be cancelled from Notula.' }
  if (await egressBlocked(ctx, { kind: 'calendar' })) return { status: 'failed', errorCode: 'local_only', error: COPY.localOnly }
  const token = await writeToken(ctx, ref.sourceId)
  if (typeof token !== 'string') return token
  const following = scope === 'following' && !!ref.seriesId
  const out = ref.provider === 'google' ? await google(ctx, token, ref, following, notify) : await graph(ctx, token, ref, following, notify)
  log('info', 'calendar-write:cancel', { provider: ref.provider, notify, following, status: out.status })
  if (out.status === 'updated') ctx.calendar.refreshSource(ref.sourceId)
  return out
}

async function google(ctx: MainContext, token: string, ref: EventRef, following: boolean, notify: boolean): Promise<ExecResult> {
  const http = providerHttp(ctx, 'calendar', 'calendar-write')
  const headers = googleHeaders(token)
  const calendarId = ref.calendarNativeId
  const sendUpdates = notify ? 'all' : 'none'
  const remove = async (eventId: string): Promise<ExecResult> => {
    const x = await exchange(() => http.fetch(googleEventUrl, { method: 'DELETE', params: { calendarId, eventId }, query: { sendUpdates }, headers }))
    // Gone already is the outcome asked for.
    if (x.ok || (x.kind === 'http' && x.status === 410)) return { status: 'updated', fields: { eventId } }
    return failed(x, true)
  }
  if (!following || !ref.seriesId) return remove(ref.eventId)
  const masterId = ref.seriesId
  const cur = await exchange(() => http.fetch(googleEventUrl, { params: { calendarId, eventId: ref.eventId }, headers }))
  if (!cur.ok) return failed(cur, false)
  const m = await exchange(() => http.fetch(googleEventUrl, { params: { calendarId, eventId: masterId }, headers }))
  if (!m.ok) return failed(m, false)
  const occurrence = googleOriginalStart(cur.body, undefined)
  const rules = Array.isArray(m.body['recurrence']) ? (m.body['recurrence'] as unknown[]).filter((x): x is string => typeof x === 'string') : []
  if (!occurrence || !rules.length) return remove(ref.eventId)
  // From the first occurrence on is the whole series.
  if (startMs(occurrence) <= startMs(googleStart(m.body) ?? occurrence)) return remove(masterId)
  const x = await exchange(() =>
    http.fetch(googleEventUrl, {
      method: 'PATCH',
      params: { calendarId, eventId: masterId },
      query: { sendUpdates },
      headers: { ...headers, 'if-match': str(m.body['etag']) ?? '*' },
      body: JSON.stringify({ recurrence: endBefore(rules, occurrence) })
    })
  )
  if (x.ok) return { status: 'updated', fields: { eventId: masterId } }
  return failed(x, true)
}

function googleStart(ev: Obj): CalendarDraftTime | null {
  const s = obj(ev['start'])
  if (typeof s['date'] === 'string') return { date: s['date'] }
  return typeof s['dateTime'] === 'string' ? { dateTime: s['dateTime'], timeZone: str(s['timeZone']) ?? 'UTC' } : null
}

/** An instant's date in the series' own zone (Graph gives the occurrence's original start in UTC). */
function graphLocalDate(iso: string | null, zone: string | null): string | null {
  if (!iso) return null
  const ms = Date.parse(/[zZ]|[+-]\d{2}:\d{2}$/.test(iso) ? iso : `${iso}Z`)
  const tz = ianaZoneFor(zone)
  if (Number.isNaN(ms) || !tz) return iso.slice(0, 10)
  const w = utcMsToZonedWall(ms, tz)
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`
}

async function graph(ctx: MainContext, token: string, ref: EventRef, following: boolean, notify: boolean): Promise<ExecResult> {
  const http = providerHttp(ctx, 'calendar', 'calendar-write')
  const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' }
  // The organizer's cancel sends the notice; a delete may still notify guests on Graph's side.
  const remove = async (id: string): Promise<ExecResult> => {
    const x =
      ref.organizer && notify
        ? await exchange(() => http.fetch('https://graph.microsoft.com/v1.0/me/events/{id}/cancel', { method: 'POST', params: { id }, headers, body: JSON.stringify({ comment: '' }) }))
        : await exchange(() => http.fetch(graphEventUrl, { method: 'DELETE', params: { id }, headers }))
    if (x.ok || (x.kind === 'http' && x.status === 404)) return { status: 'updated', fields: { eventId: id, ...(ref.organizer && !notify ? { notice: CANCEL_COPY.graphSilent } : {}) } }
    return failed(x, true)
  }
  if (!following || !ref.seriesId) return remove(ref.eventId)
  const masterId = ref.seriesId
  const cur = await exchange(() => http.fetch(graphEventUrl, { params: { id: ref.eventId }, headers }))
  if (!cur.ok) return failed(cur, false)
  const m = await exchange(() => http.fetch(graphEventUrl, { params: { id: masterId }, headers }))
  if (!m.ok) return failed(m, false)
  const recurrence = obj(m.body['recurrence'])
  const range = obj(recurrence['range'])
  const date = graphLocalDate(str(cur.body['originalStart']) ?? str(obj(cur.body['start'])['dateTime']), str(m.body['originalStartTimeZone']))
  const first = str(range['startDate'])
  if (!date || !first) return remove(ref.eventId)
  if (date <= first) return remove(masterId)
  const end: Obj = { type: 'endDate', startDate: first, endDate: dayBefore(date), ...(range['recurrenceTimeZone'] ? { recurrenceTimeZone: range['recurrenceTimeZone'] } : {}) }
  const etag = str(m.body['@odata.etag'])
  const x = await exchange(() =>
    http.fetch(graphEventUrl, {
      method: 'PATCH',
      params: { id: masterId },
      headers: { ...headers, ...(etag ? { 'if-match': etag } : {}) },
      body: JSON.stringify({ recurrence: { ...recurrence, range: end } })
    })
  )
  if (x.ok) return { status: 'updated', fields: { eventId: masterId, ...(!notify ? { notice: CANCEL_COPY.graphSilent } : {}) } }
  return failed(x, true)
}
