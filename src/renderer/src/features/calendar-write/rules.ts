// SPDX-License-Identifier: Apache-2.0
// Card-side helpers for calendar drafts: time labels and
// edits in the draft's own time zone, the repeat options built from the first occurrence with their
// labels, and the disabled reasons the card can tell before main checks the draft.
// Main validates every write and execute again (calendar-write/draft.ts).

import type { CalendarDraftTime, CalendarEventDraft } from '@shared/types/workflow-blocks'

export type TimeOption = { start: CalendarDraftTime; end: CalendarDraftTime }

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth']

export const isTimed = (t: CalendarDraftTime): t is { dateTime: string; timeZone: string } => 'dateTime' in t

/** The zone's UTC offset in minutes at `utcMs`. */
function offsetMin(tz: string, utcMs: number): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
      .formatToParts(new Date(utcMs))
      .map((p) => [p.type, p.value])
  )
  const asUtc = Date.UTC(Number(parts['year']), Number(parts['month']) - 1, Number(parts['day']), Number(parts['hour']) % 24, Number(parts['minute']), Number(parts['second']))
  return Math.round((asUtc - utcMs) / 60_000)
}

/** A wall-clock date and time in `tz` as ISO 8601 with its offset. */
export function zonedIso(date: string, time: string, tz: string): string {
  const [y, m, d] = date.split('-').map(Number)
  const [hh, mm] = time.split(':').map(Number)
  const wall = Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, hh ?? 0, mm ?? 0)
  let off = offsetMin(tz, wall)
  off = offsetMin(tz, wall - off * 60_000)
  const sign = off >= 0 ? '+' : '-'
  const a = Math.abs(off)
  return `${date}T${String(hh ?? 0).padStart(2, '0')}:${String(mm ?? 0).padStart(2, '0')}:00${sign}${String(Math.floor(a / 60)).padStart(2, '0')}:${String(a % 60).padStart(2, '0')}`
}

export const localDate = (t: CalendarDraftTime): string => (isTimed(t) ? t.dateTime.slice(0, 10) : t.date)
export const localTime = (t: CalendarDraftTime): string => (isTimed(t) ? t.dateTime.slice(11, 16) : '')

function dayOf(date: string): number {
  return new Date(`${date}T12:00:00Z`).getUTCDay()
}

export function dateLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
}

function clock(t: CalendarDraftTime): string {
  if (!isTimed(t)) return ''
  const [h, m] = t.dateTime.slice(11, 16).split(':').map(Number)
  return new Date(Date.UTC(2000, 0, 1, h ?? 0, m ?? 0)).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' })
}

/** "Tue, Oct 20 · 10:00 AM – 10:30 AM" (all-day: "Tue, Oct 20 · All day"). */
export function optionLabel(o: TimeOption): string {
  if (!isTimed(o.start)) return `${dateLabel(localDate(o.start))} · All day`
  const sameDay = localDate(o.start) === localDate(o.end)
  return `${dateLabel(localDate(o.start))} · ${clock(o.start)} – ${sameDay ? '' : `${dateLabel(localDate(o.end))} `}${clock(o.end)}`
}

export function zoneLabel(o: TimeOption): string | null {
  if (!isTimed(o.start)) return null
  const local = Intl.DateTimeFormat().resolvedOptions().timeZone
  return o.start.timeZone === local ? null : o.start.timeZone.replace(/_/g, ' ')
}

// ---------- repeat ----------

export interface RepeatChoice {
  /** The RRULE line without COUNT / UNTIL, or '' for none. */
  value: string
  label: string
}

/** The options built from the first occurrence. */
export function repeatChoices(first: CalendarDraftTime): RepeatChoice[] {
  const date = localDate(first)
  const wd = dayOf(date)
  const code = DAYS[wd] ?? 'MO'
  const dom = Number(date.slice(8, 10))
  const daysInMonth = new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate()
  const nth = Math.ceil(dom / 7)
  const ordinal = nth === 5 || dom + 7 > daysInMonth ? -1 : nth
  const out: RepeatChoice[] = [
    { value: '', label: 'Does not repeat' },
    { value: 'RRULE:FREQ=DAILY', label: 'Every day' }
  ]
  if (wd >= 1 && wd <= 5) out.push({ value: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', label: 'Every weekday (Mon–Fri)' })
  out.push(
    { value: `RRULE:FREQ=WEEKLY;BYDAY=${code}`, label: `Every week on ${DAY_NAMES[wd]}` },
    { value: `RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=${code}`, label: `Every 2 weeks on ${DAY_NAMES[wd]}` },
    { value: `RRULE:FREQ=MONTHLY;BYDAY=${ordinal}${code}`, label: `Every month on the ${ordinal === -1 ? 'last' : ORD[ordinal]} ${DAY_NAMES[wd]}` }
  )
  return out
}

export interface ParsedRepeat {
  base: string
  count: number | null
  until: string | null
}

export function parseRepeat(rules: string[] | undefined): ParsedRepeat {
  const line = rules?.find((r) => r.startsWith('RRULE:'))
  if (!line) return { base: '', count: null, until: null }
  const parts = line.slice(6).split(';')
  const keep = parts.filter((p) => !p.startsWith('COUNT=') && !p.startsWith('UNTIL=') && p !== 'INTERVAL=1')
  const count = parts.find((p) => p.startsWith('COUNT='))
  const until = parts.find((p) => p.startsWith('UNTIL='))
  const u = until?.slice(6) ?? ''
  return { base: `RRULE:${keep.join(';')}`, count: count ? Number(count.slice(6)) || null : null, until: /^\d{8}/.test(u) ? `${u.slice(0, 4)}-${u.slice(4, 6)}-${u.slice(6, 8)}` : null }
}

/** The stored rule: `UNTIL` is the last second of the until-date in the event's zone, as UTC. */
export function buildRepeat(base: string, count: number | null, until: string | null, tz: string | null): string[] | undefined {
  if (!base) return undefined
  if (count) return [`${base};COUNT=${Math.max(1, Math.min(1_000, Math.floor(count)))}`]
  if (until) {
    const iso = tz ? zonedIso(until, '23:59', tz) : `${until}T23:59:00Z`
    const utc = new Date(Date.parse(iso) + 59_000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
    return [`${base};UNTIL=${utc}`]
  }
  return [base]
}

/** The repeat label ("Every week", …) of any rule Notula reads. */
export function repeatLabel(rules: string[] | undefined): string {
  const r = parseRepeat(rules)
  if (!r.base) return 'Does not repeat'
  const p = Object.fromEntries(r.base.slice(6).split(';').map((x) => x.split('=') as [string, string]))
  const n = Number(p['INTERVAL'] ?? 1) || 1
  const days = (p['BYDAY'] ?? '').split(',').filter(Boolean)
  let label: string
  if (p['FREQ'] === 'DAILY') label = n === 1 ? 'Every day' : `Every ${n} days`
  else if (p['FREQ'] === 'WEEKLY') {
    if (days.join(',') === 'MO,TU,WE,TH,FR' && n === 1) label = 'Every weekday (Mon–Fri)'
    else label = `${n === 1 ? 'Every week' : `Every ${n} weeks`}${days.length ? ` on ${days.map((d) => SHORT[DAYS.indexOf(d as (typeof DAYS)[number])] ?? d).join(', ')}` : ''}`
  } else if (p['FREQ'] === 'MONTHLY') {
    const m = /^([+-]?\d)(SU|MO|TU|WE|TH|FR|SA)$/.exec(days[0] ?? '')
    const base = n === 1 ? 'Every month' : `Every ${n} months`
    label = m ? `${base} on the ${Number(m[1]) === -1 ? 'last' : ORD[Number(m[1])]} ${DAY_NAMES[DAYS.indexOf(m[2] as (typeof DAYS)[number])]}` : p['BYMONTHDAY'] ? `${base} on the ${p['BYMONTHDAY']}` : base
  } else label = 'Custom repeat'
  if (r.count) label += ` · ${r.count} times`
  else if (r.until) label += ` · until ${new Date(`${r.until}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })}`
  return label
}

// ---------- disabled reasons ----------

export function validLink(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname
  } catch {
    return false
  }
}

/** The first card-side reason Create event can't run yet, or null. */
export function cardReason(d: CalendarEventDraft): string | null {
  if (d.eventType && d.eventType !== 'default') return 'Notula can only create regular events.'
  const o = d.selectedTime ?? (d.timeOptions.length === 1 ? d.timeOptions[0] : null)
  if (!o) return 'Choose a time'
  if (isTimed(o.start) && isTimed(o.end)) {
    const ms = Date.parse(o.end.dateTime) - Date.parse(o.start.dateTime)
    if (!(ms > 0)) return 'The end time must be after the start time.'
    if (ms > 86_400_000) return 'Events can’t be longer than 24 hours.'
  } else if (!isTimed(o.start) && !isTimed(o.end) && !(o.end.date > o.start.date)) return 'Pick an end date that comes after the start date.'
  const r = parseRepeat(d.recurrenceRules)
  if (r.until && r.until < localDate(o.start)) return 'Repeat end date is before the start.'
  if (d.existingEvent) {
    const a = JSON.stringify({ ...d.existingEvent.original, execution: undefined })
    const { existingEvent: _x, execution: _e, dismissedAt: _d, fromEvent: _f, ...now } = d
    if (a === JSON.stringify({ ...now, execution: undefined })) return 'This draft doesn’t change the event.'
  }
  if (d.conference.kind === 'custom' && !validLink(d.conference.url)) return 'Add a valid meeting link'
  return null
}
