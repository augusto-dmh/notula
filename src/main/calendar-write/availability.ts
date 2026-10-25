// SPDX-License-Identifier: Apache-2.0
// Free and busy times, read on the account's read scope: Google `freeBusy` and Graph
// `getSchedule`. A calendar the provider can't show is `known: false`, never free. Nothing here
// logs an address or a time.

import type { CalendarSource } from '@shared/types/calendar'
import type { MainContext } from '../context'
import { exchange, providerHttp } from './http'

export interface Busy {
  start: string
  end: string
}

export interface PersonBusy {
  email: string
  known: boolean
  busy: Busy[]
}

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const arr = (v: unknown): Obj[] => (Array.isArray(v) ? (v as unknown[]).map(obj) : [])
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export const AVAILABILITY_COPY = {
  noAccount: 'Connect Google Calendar or Microsoft to check free time.',
  reconnect: 'Reconnect your calendar to continue.',
  failed: 'Couldn’t reach your calendar. Check your connection and try again.'
} as const

/** The account availability is read from: the one with the profile email, else the first. */
export async function availabilitySource(ctx: MainContext): Promise<CalendarSource | null> {
  const all = ((await ctx.storage.listCalendarSources().catch(() => [])) as CalendarSource[]).filter((s) => s.kind === 'google' || s.kind === 'microsoft')
  const profile = String((await ctx.settings.get('profile.email').catch(() => '')) ?? '').toLowerCase()
  return all.find((s) => !!profile && s.accountEmail?.toLowerCase() === profile) ?? all[0] ?? null
}

export async function readToken(ctx: MainContext, src: CalendarSource): Promise<string | null> {
  try {
    return await ctx.calendar.accessToken(src.id, null)
  } catch {
    return null
  }
}

/** Graph returns UTC wall times under `Prefer: outlook.timezone="UTC"`. */
const graphUtc = (v: unknown): string => {
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(str(obj(v)['dateTime']))
  return m ? `${m[1]}Z` : ''
}

/** Each person's busy times in [from, to); an error string when the provider couldn't answer at all. */
export async function busyTimes(ctx: MainContext, src: CalendarSource, people: string[], from: Date, to: Date, timeZone: string): Promise<PersonBusy[] | string> {
  const token = await readToken(ctx, src)
  if (!token) return AVAILABILITY_COPY.reconnect
  const out: PersonBusy[] = []
  if (src.kind === 'google') {
    const http = providerHttp(ctx, 'calendar', 'calendar-read')
    // freeBusy takes up to 50 calendars a request.
    for (let i = 0; i < people.length; i += 50) {
      const batch = people.slice(i, i + 50)
      const x = await exchange(() =>
        http.fetch('https://www.googleapis.com/calendar/v3/freeBusy', {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ timeMin: from.toISOString(), timeMax: to.toISOString(), timeZone, items: batch.map((id) => ({ id })) })
        })
      )
      if (!x.ok) return x.kind === 'http' && x.status === 401 ? AVAILABILITY_COPY.reconnect : AVAILABILITY_COPY.failed
      const calendars = obj(x.body['calendars'])
      for (const email of batch) {
        const c = calendars[email] === undefined ? (Object.entries(calendars).find(([k]) => k.toLowerCase() === email.toLowerCase())?.[1] ?? null) : calendars[email]
        const known = !!c && arr(obj(c)['errors']).length === 0
        out.push({ email, known, busy: known ? arr(obj(c)['busy']).map((b) => ({ start: str(b['start']), end: str(b['end']) })).filter((b) => b.start && b.end) : [] })
      }
    }
    return out
  }
  const items = await graphSchedule(ctx, token, people, from, to)
  if (typeof items === 'string') return items
  for (const email of people) {
    const s = items.get(email.toLowerCase())
    out.push({ email, known: !!s, busy: s ? s.filter((i) => i.status !== 'free').map(({ start, end }) => ({ start, end })) : [] })
  }
  return out
}

export interface ScheduleItem extends Busy {
  status: string
  subject: string | null
  location: string | null
}

/** Graph `getSchedule`: per lower-cased address, its items; an address with an error is missing. */
export async function graphSchedule(ctx: MainContext, token: string, people: string[], from: Date, to: Date): Promise<Map<string, ScheduleItem[]> | string> {
  const http = providerHttp(ctx, 'calendar', 'calendar-read')
  const out = new Map<string, ScheduleItem[]>()
  const wall = (d: Date): string => d.toISOString().slice(0, 19)
  for (let i = 0; i < people.length; i += 20) {
    const batch = people.slice(i, i + 20)
    const x = await exchange(() =>
      http.fetch('https://graph.microsoft.com/v1.0/me/calendar/getSchedule', {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json', prefer: 'outlook.timezone="UTC"' },
        body: JSON.stringify({ schedules: batch, startTime: { dateTime: wall(from), timeZone: 'UTC' }, endTime: { dateTime: wall(to), timeZone: 'UTC' }, availabilityViewInterval: 15 })
      })
    )
    if (!x.ok) return x.kind === 'http' && x.status === 401 ? AVAILABILITY_COPY.reconnect : AVAILABILITY_COPY.failed
    for (const s of arr(x.body['value'])) {
      if (s['error']) continue
      const id = str(s['scheduleId']).toLowerCase()
      if (!id) continue
      out.set(
        id,
        arr(s['scheduleItems'])
          .map((it) => ({
            start: graphUtc(it['start']),
            end: graphUtc(it['end']),
            status: str(it['status']) || 'busy',
            subject: str(it['subject']) || null,
            location: str(it['location']) || null
          }))
          .filter((it) => it.start && it.end)
      )
    }
  }
  return out
}

/** Busy intervals with one interval cut out (the event being moved doesn't count against itself). */
export function without(busy: Busy[], ignore: { startMs: number; endMs: number } | null): Busy[] {
  if (!ignore) return busy
  const out: Busy[] = []
  for (const b of busy) {
    const s = Date.parse(b.start)
    const e = Date.parse(b.end)
    if (e <= ignore.startMs || s >= ignore.endMs) {
      out.push(b)
      continue
    }
    if (s < ignore.startMs) out.push({ start: b.start, end: new Date(ignore.startMs).toISOString() })
    if (e > ignore.endMs) out.push({ start: new Date(ignore.endMs).toISOString(), end: b.end })
  }
  return out
}

export const overlaps = (busy: Busy[], startMs: number, endMs: number): boolean => busy.some((b) => Date.parse(b.start) < endMs && Date.parse(b.end) > startMs)
