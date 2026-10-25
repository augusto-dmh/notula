// SPDX-License-Identifier: Apache-2.0
// Scheduling reads for chat: `checkAvailability` (when the listed people are busy, and the
// open slots that suit everyone) and `readPersonCalendar` (one person's days, when they share
// their calendar). Both run on the account's read scope through the calendar-write HTTP
// helpers and need no approval. Addresses and times stay in the answer; logs carry counts only.

import type { MainContext } from '../context'
import { log } from '../log'
import { isoWithOffset, zonedWallToUtcMs, zoneOffsetMs, utcMsToZonedWall } from '../calendar/tz'
import { AVAILABILITY_COPY, availabilitySource, busyTimes, graphSchedule, overlaps, readToken, without, type Busy } from '../calendar-write/availability'
import { exchange, providerHttp } from '../calendar-write/http'
import type { ChatToolResult, ChatToolSpec } from './tool-api'

export const AVAILABILITY_TOOL = 'checkAvailability'
export const PERSON_CALENDAR_TOOL = 'readPersonCalendar'

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/
const DAY_MS = 86_400_000
const MAX_PEOPLE = 5
const MAX_DAYS = 8
const MAX_SLOTS = 10
const SLOTS_PER_DAY = 3
const STEP_MS = 15 * 60_000

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const userZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
const fail = (content: string): ChatToolResult => ({ content, isError: true })
const zoned = (ms: number, tz: string): string => isoWithOffset(ms, zoneOffsetMs(tz, ms))

export const AVAILABILITY_SPECS: ChatToolSpec[] = [
  {
    def: {
      name: AVAILABILITY_TOOL,
      description:
        'Looks up when the listed people (and the user) are busy between two dates, so you can suggest meeting times that work for all of them. ' +
        'Give minutes to also get open slots on weekdays within the day hours. A calendar the provider cannot show comes back in unknown: that person is not free, just not visible.',
      inputSchema: {
        type: 'object',
        properties: {
          people: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 5, description: 'One to five email addresses, not counting the user.' },
          includeMe: { type: 'boolean', description: "Also check the user's own calendar. Default true." },
          from: { type: 'string', description: "Start: an ISO date (YYYY-MM-DD) or date-time, in the user's time zone unless it has an offset." },
          to: { type: 'string', description: 'End, at most 8 days after from. A date alone covers that whole day.' },
          minutes: { type: 'integer', minimum: 15, maximum: 480, description: 'The meeting length, for open slots.' },
          dayStartHour: { type: 'integer', minimum: 0, maximum: 23, description: 'Earliest hour for open slots (default 9).' },
          dayEndHour: { type: 'integer', minimum: 0, maximum: 23, description: 'Hour open slots end by (default 18).' },
          ignoreEventId: { type: 'string', description: 'The id of an event being moved, so its own time does not count as busy.' }
        },
        required: ['people', 'from', 'to'],
        additionalProperties: false
      }
    },
    category: 'calendar',
    needsApproval: false,
    readOnly: true,
    title: 'Check free time'
  },
  {
    def: {
      name: PERSON_CALENDAR_TOOL,
      description:
        "Shows one person's schedule on up to 7 days, when they share their calendar with the user. Titles of events the user may not see come back as null. " +
        'Use it only when the user wants detail about that person’s day; to find a common time, use checkAvailability.',
      inputSchema: {
        type: 'object',
        properties: {
          email: { type: 'string' },
          dates: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 7, description: 'Days as YYYY-MM-DD.' }
        },
        required: ['email', 'dates'],
        additionalProperties: false
      }
    },
    category: 'calendar',
    needsApproval: false,
    readOnly: true,
    title: "Read a person's calendar"
  }
]

// ---------- times ----------

/** A date or date-time as an instant; a date is its midnight (or, as an end, the next one) in the zone. */
function instant(v: string, tz: string, end: boolean): number | null {
  const d = DATE.exec(v)
  if (d) return zonedWallToUtcMs({ year: Number(d[1]), month: Number(d[2]), day: Number(d[3]) + (end ? 1 : 0), hour: 0, minute: 0, second: 0 }, tz)
  const m = DATETIME.exec(v)
  if (!m) return null
  if (m[7]) {
    const ms = Date.parse(v)
    return Number.isNaN(ms) ? null : ms
  }
  return zonedWallToUtcMs({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? 0) }, tz)
}

/** The day's wall-clock hour in the zone as an instant (hour 24 is the next midnight). */
function atHour(dayMs: number, hour: number, tz: string): number {
  const w = utcMsToZonedWall(dayMs, tz)
  return zonedWallToUtcMs({ year: w.year, month: w.month, day: w.day, hour, minute: 0, second: 0 }, tz)
}

/**
 * Up to 10 slots of `minutes` inside the day hours on weekdays, free for everyone known: at most
 * three a day, back to back in the free stretches, on quarter hours.
 */
export function openSlots(busy: Busy[], fromMs: number, toMs: number, minutes: number, startHour: number, endHour: number, tz: string): { start: string; end: string }[] {
  const len = minutes * 60_000
  const out: { start: string; end: string }[] = []
  const w = utcMsToZonedWall(fromMs, tz)
  let day = zonedWallToUtcMs({ year: w.year, month: w.month, day: w.day, hour: 12, minute: 0, second: 0 }, tz)
  for (let i = 0; i <= MAX_DAYS + 1 && out.length < MAX_SLOTS; i++, day += DAY_MS) {
    const dw = utcMsToZonedWall(day, tz)
    const wd = new Date(Date.UTC(dw.year, dw.month - 1, dw.day)).getUTCDay()
    if (wd === 0 || wd === 6) continue
    const open = Math.max(fromMs, atHour(day, startHour, tz))
    const close = Math.min(toMs, atHour(day, endHour, tz))
    let t = Math.ceil(open / STEP_MS) * STEP_MS
    let today = 0
    while (t + len <= close && today < SLOTS_PER_DAY && out.length < MAX_SLOTS) {
      const clash = busy.filter((b) => Date.parse(b.start) < t + len && Date.parse(b.end) > t)
      if (clash.length) {
        // Jump past the busy time that ends last.
        t = Math.ceil(Math.max(...clash.map((b) => Date.parse(b.end))) / STEP_MS) * STEP_MS
        continue
      }
      out.push({ start: zoned(t, tz), end: zoned(t + len, tz) })
      today++
      t += len
    }
  }
  return out
}

// ---------- checkAvailability ----------

export async function runCheckAvailability(ctx: MainContext, args: Obj): Promise<ChatToolResult> {
  const people = Array.isArray(args['people']) ? (args['people'] as unknown[]).map((p) => str(p).trim()).filter(Boolean) : []
  if (people.length > MAX_PEOPLE) return fail('Check at most five people besides you.')
  if (!people.length) return fail('Name at least one person to check.')
  const invalid = people.find((p) => !EMAIL.test(p))
  if (invalid) return fail(`${invalid} isn’t a valid email address.`)
  const tz = userZone()
  const from = instant(str(args['from']), tz, false)
  const to = instant(str(args['to']), tz, true)
  if (from === null || to === null) return fail('Give from and to as a date (YYYY-MM-DD) or a date and time.')
  if (!(to > from)) return fail('The end must come after the start.')
  if (to - from > MAX_DAYS * DAY_MS) return fail('Check at most 8 days at a time.')
  const minutes = args['minutes'] === undefined ? null : Number(args['minutes'])
  if (minutes !== null && !(Number.isInteger(minutes) && minutes >= 15 && minutes <= 480)) return fail('Use 15–480 minutes.')
  const startHour = args['dayStartHour'] === undefined ? 9 : Number(args['dayStartHour'])
  const endHour = args['dayEndHour'] === undefined ? 18 : Number(args['dayEndHour'])
  if (![startHour, endHour].every((h) => Number.isInteger(h) && h >= 0 && h <= 23) || endHour <= startHour) return fail('Use day hours from 0 to 23, with the end after the start.')

  const src = await availabilitySource(ctx)
  if (!src) return fail(AVAILABILITY_COPY.noAccount)
  const me = src.accountEmail ?? null
  const includeMe = args['includeMe'] !== false && !!me
  const unique = [...new Map(people.filter((p) => p.toLowerCase() !== me?.toLowerCase()).map((p) => [p.toLowerCase(), p])).values()]
  const asked = includeMe && me ? [me, ...unique] : unique
  const busy = await busyTimes(ctx, src, asked, new Date(from), new Date(to), tz)
  if (typeof busy === 'string') return fail(busy)

  let ignore: { startMs: number; endMs: number } | null = null
  if (typeof args['ignoreEventId'] === 'string' && args['ignoreEventId']) {
    const ev = await ctx.calendar.getEvent(args['ignoreEventId']).catch(() => null)
    const s = Date.parse(str(ev?.start?.dateTime))
    const e = Date.parse(str(ev?.end?.dateTime))
    if (!Number.isNaN(s) && !Number.isNaN(e)) ignore = { startMs: s, endMs: e }
  }
  const rows = busy.map((b) => ({ email: b.email, known: b.known, busy: without(b.busy, ignore) }))
  const slots = minutes ? openSlots(rows.filter((r) => r.known).flatMap((r) => r.busy), from, to, minutes, startHour, endHour, tz) : []
  log('info', 'chat:availability-checked', { provider: src.kind, people: unique.length, unknown: rows.filter((r) => !r.known).length, slots: slots.length })
  const result = {
    timeZone: tz,
    people: rows,
    unknown: rows.filter((r) => !r.known).map((r) => r.email),
    openSlots: slots
  }
  return { content: JSON.stringify(result), data: { people: unique.length, unknown: result.unknown.length, slots: slots.length }, isError: false }
}

// ---------- readPersonCalendar ----------

interface PersonEvent {
  start: string
  end: string
  title: string | null
  status: string
}

export async function runReadPersonCalendar(ctx: MainContext, args: Obj): Promise<ChatToolResult> {
  const email = str(args['email']).trim()
  if (!EMAIL.test(email)) return fail(`${email || 'That'} isn’t a valid email address.`)
  const dates = Array.isArray(args['dates']) ? [...new Set((args['dates'] as unknown[]).map(str))] : []
  if (!dates.length || dates.length > 7 || dates.some((d) => !DATE.test(d))) return fail('Give one to seven dates as YYYY-MM-DD.')
  const src = await availabilitySource(ctx)
  if (!src) return fail(AVAILABILITY_COPY.noAccount)
  const token = await readToken(ctx, src)
  if (!token) return fail(AVAILABILITY_COPY.reconnect)
  const tz = userZone()
  const days = dates.sort().map((d) => ({ from: instant(d, tz, false) as number, to: instant(d, tz, true) as number }))
  const r = src.kind === 'google' ? await googleDays(ctx, token, email, days, tz) : await graphDays(ctx, token, email, days, tz)
  if (typeof r === 'string') return fail(r)
  log('info', 'chat:person-calendar-read', { provider: src.kind, readable: r.readable, events: r.events.length })
  return { content: JSON.stringify({ email, ...r }), data: { readable: r.readable, events: r.events.length }, isError: false }
}

async function googleDays(ctx: MainContext, token: string, email: string, days: { from: number; to: number }[], tz: string): Promise<{ readable: boolean; events: PersonEvent[] } | string> {
  const http = providerHttp(ctx, 'calendar', 'calendar-read')
  const events: PersonEvent[] = []
  for (const day of days) {
    const x = await exchange(() =>
      http.fetch('https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events', {
        params: { calendarId: email },
        query: { singleEvents: 'true', orderBy: 'startTime', timeMin: new Date(day.from).toISOString(), timeMax: new Date(day.to).toISOString(), timeZone: tz, maxResults: '250' },
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
      })
    )
    if (!x.ok) {
      if (x.kind === 'http' && (x.status === 403 || x.status === 404)) return { readable: false, events: [] }
      return x.kind === 'http' && x.status === 401 ? AVAILABILITY_COPY.reconnect : AVAILABILITY_COPY.failed
    }
    for (const ev of Array.isArray(x.body['items']) ? (x.body['items'] as Obj[]) : []) {
      if (ev['status'] === 'cancelled') continue
      const s = obj(ev['start'])
      const e = obj(ev['end'])
      const title = str(ev['summary']) || null
      events.push({
        start: str(s['dateTime']) || str(s['date']),
        end: str(e['dateTime']) || str(e['date']),
        title,
        status: ev['transparency'] === 'transparent' ? 'free' : ev['status'] === 'tentative' ? 'tentative' : 'busy'
      })
    }
  }
  return { readable: true, events }
}

async function graphDays(ctx: MainContext, token: string, email: string, days: { from: number; to: number }[], tz: string): Promise<{ readable: boolean; events: PersonEvent[] } | string> {
  const first = days[0]
  const last = days[days.length - 1]
  if (!first || !last) return { readable: false, events: [] }
  const map = await graphSchedule(ctx, token, [email], new Date(first.from), new Date(last.to))
  if (typeof map === 'string') return map
  const items = map.get(email.toLowerCase())
  if (!items) return { readable: false, events: [] }
  return {
    readable: true,
    events: items
      .filter((i) => days.some((d) => overlaps([i], d.from, d.to)))
      .map((i) => ({ start: zoned(Date.parse(i.start), tz), end: zoned(Date.parse(i.end), tz), title: i.subject ? (i.location ? `${i.subject} (${i.location})` : i.subject) : null, status: i.status }))
  }
}

