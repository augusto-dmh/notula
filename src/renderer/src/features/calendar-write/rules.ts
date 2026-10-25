// SPDX-License-Identifier: Apache-2.0
// Card-side helpers for calendar drafts: time labels and
// edits in the draft's own time zone, the repeat options built from the first occurrence with their
// labels, and the disabled reasons the card can tell before main checks the draft.
// Main validates every write and execute again (calendar-write/draft.ts).

import type { CalendarColorId, CalendarDraftTime, CalendarEventDraft } from '@shared/types/workflow-blocks'

export type TimeOption = { start: CalendarDraftTime; end: CalendarDraftTime }

const DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const ORD = ['', 'first', 'second', 'third', 'fourth', 'fifth']
/** Counted from the end of the month: −1 is the last. */
const FROM_END = ['', 'last', 'second to last', 'third to last', 'fourth to last', 'fifth to last']

const ordinal = (n: number): string => (n < 0 ? (FROM_END[-n] ?? 'last') : (ORD[n] ?? ''))

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

/** "Oct 20". */
function monthDayLabel(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
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
  const nthCode = nth === 5 || dom + 7 > daysInMonth ? -1 : nth
  const out: RepeatChoice[] = [
    { value: '', label: 'Does not repeat' },
    { value: 'RRULE:FREQ=DAILY', label: 'Every day' }
  ]
  if (wd >= 1 && wd <= 5) out.push({ value: 'RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR', label: 'Every weekday (Mon–Fri)' })
  out.push(
    { value: `RRULE:FREQ=WEEKLY;BYDAY=${code}`, label: `Every week on ${DAY_NAMES[wd]}` },
    { value: `RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=${code}`, label: `Every 2 weeks on ${DAY_NAMES[wd]}` },
    { value: `RRULE:FREQ=MONTHLY;BYDAY=${nthCode}${code}`, label: `Every month on the ${ordinal(nthCode)} ${DAY_NAMES[wd]}` },
    { value: `RRULE:FREQ=YEARLY;BYMONTH=${Number(date.slice(5, 7))};BYMONTHDAY=${dom}`, label: `Every year on ${monthDayLabel(date)}` }
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

/**
 * The stored rule: `UNTIL` is the last second of the until-date in the event's zone, as UTC;
 * an all-day series (no zone) ends on the date itself.
 */
export function buildRepeat(base: string, count: number | null, until: string | null, tz: string | null): string[] | undefined {
  if (!base) return undefined
  if (count) return [`${base};COUNT=${Math.max(1, Math.min(1_000, Math.floor(count)))}`]
  if (until) {
    if (!tz) return [`${base};UNTIL=${until.replace(/-/g, '')}`]
    const iso = zonedIso(until, '23:59', tz)
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
  } else if (p['FREQ'] === 'MONTHLY' || p['FREQ'] === 'YEARLY') {
    const m = /^([+-]?\d)(SU|MO|TU|WE|TH|FR|SA)$/.exec(days[0] ?? '')
    const yearly = p['FREQ'] === 'YEARLY'
    const base = yearly ? (n === 1 ? 'Every year' : `Every ${n} years`) : n === 1 ? 'Every month' : `Every ${n} months`
    const weekday = m ? `the ${ordinal(Number(m[1]))} ${DAY_NAMES[DAYS.indexOf(m[2] as (typeof DAYS)[number])]}` : null
    const monthDay = Number(p['BYMONTHDAY']) || 0
    const month = yearly ? Number(p['BYMONTH']) || 0 : 0
    if (month) {
      const mm = String(month).padStart(2, '0')
      const name = new Date(Date.UTC(2000, month - 1, 1)).toLocaleDateString(undefined, { month: 'short', timeZone: 'UTC' })
      if (weekday) label = `${base} on ${weekday} of ${name}`
      else if (monthDay === -1) label = `${base} on the last day of ${name}`
      else label = monthDay ? `${base} on ${monthDayLabel(`2000-${mm}-${String(monthDay).padStart(2, '0')}`)}` : base
    } else if (weekday) label = `${base} on ${weekday}`
    else label = monthDay === -1 ? `${base} on the last day` : monthDay ? `${base} on the ${monthDay}` : base
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
  if (d.eventType && d.eventType !== 'default') return d.existingEvent ? 'Notula can’t turn an event into a different kind of event.' : 'Notula can only create regular events.'
  const o = d.selectedTime ?? (d.timeOptions.length === 1 ? d.timeOptions[0] : null)
  if (!o) return 'Choose a time'
  if (isTimed(o.start) && isTimed(o.end)) {
    const ms = Date.parse(o.end.dateTime) - Date.parse(o.start.dateTime)
    if (!(ms > 0)) return 'The end time must be after the start time.'
  } else if (!isTimed(o.start) && !isTimed(o.end)) {
    if (!(o.end.date > o.start.date)) return 'Pick an end date that comes after the start date.'
    const rrule = d.recurrenceRules?.find((r) => r.startsWith('RRULE:'))
    const until = rrule ? /(?:^|;)UNTIL=([^;]+)/.exec(rrule.slice(6))?.[1] : undefined
    if (until !== undefined && !/^\d{8}$/.test(until)) return 'Use a date (YYYYMMDD) for the end of an all-day series.'
    if (d.recurrenceRules?.some((l) => /^(RDATE|EXDATE)/.test(l) && !/;VALUE=DATE(;|$)/.test(l.slice(0, Math.max(0, l.indexOf(':')))))) {
      return 'Extra or skipped dates of an all-day series must be dates, not times.'
    }
  }
  const r = parseRepeat(d.recurrenceRules)
  if (r.until && r.until < localDate(o.start)) return 'Repeat end date is before the start.'
  if (d.existingEvent) {
    const refusal = editRefusal(d)
    if (refusal) return refusal
    const a = JSON.stringify({ ...d.existingEvent.original, execution: undefined })
    const { existingEvent: _x, execution: _e, dismissedAt: _d, fromEvent: _f, ...now } = d
    if (a === JSON.stringify({ ...now, execution: undefined })) return 'This draft doesn’t change the event.'
  }
  if (d.conference.kind === 'custom' && !validLink(d.conference.url)) return 'Add a valid meeting link'
  return null
}

/** The update refusals the card can tell (main checks them again in the same order). */
function editRefusal(d: CalendarEventDraft): string | null {
  const ex = d.existingEvent
  if (!ex) return null
  const o = ex.original
  if (d.autoDeclineMode || d.declineMessage) return 'Auto-decline settings can’t be set from Notula.'
  const rules = d.recurrenceRules ?? []
  const before = o.recurrenceRules ?? []
  if (ex.scope === 'occurrence' && JSON.stringify(rules) !== JSON.stringify(before)) return 'Pick the whole series, or this and the later ones, to change how it repeats.'
  if ((d.addMeAsGuest !== false) !== (o.addMeAsGuest !== false)) return 'Notula can’t add or remove you as an attendee.'
  if (before.length && !rules.length) return 'Notula can’t stop a series from repeating. Change it in your calendar app.'
  if (ex.scope === 'occurrence' && ex.occurrenceStart && d.visibility !== undefined && d.visibility !== (o.visibility ?? 'default')) {
    return 'Your calendar only lets you change who can see this for the whole series.'
  }
  return null
}

/** A rule change that keeps the series' other lines (extra and skipped dates). */
export function withRepeat(d: CalendarEventDraft, rule: string[] | undefined): string[] | undefined {
  const others = (d.recurrenceRules ?? []).filter((l) => !l.startsWith('RRULE:'))
  return rule ? [...rule, ...others] : undefined
}

// ---------- color and visibility ----------

/** Plain names for Google's event colors, by color id. */
export const COLOR_CHOICES: { id: CalendarColorId; label: string }[] = [
  { id: 'default', label: 'Same as calendar' },
  { id: '1', label: 'Light blue' },
  { id: '2', label: 'Mint' },
  { id: '3', label: 'Lilac' },
  { id: '4', label: 'Salmon' },
  { id: '5', label: 'Yellow' },
  { id: '6', label: 'Orange' },
  { id: '7', label: 'Turquoise' },
  { id: '8', label: 'Gray' },
  { id: '9', label: 'Blue' },
  { id: '10', label: 'Green' },
  { id: '11', label: 'Red' }
]

export const VISIBILITY_CHOICES: { id: NonNullable<CalendarEventDraft['visibility']>; label: string }[] = [
  { id: 'default', label: 'Calendar setting' },
  { id: 'public', label: 'Anyone who can see your calendar' },
  { id: 'private', label: 'Only you and guests' }
]

/** The primary button: what clicking it writes. */
export function submitLabel(d: CalendarEventDraft): string {
  const scope = d.existingEvent?.scope
  if (!scope) return d.recurrenceRules?.length ? 'Create repeating event' : 'Create event'
  return scope === 'series' ? 'Save for every occurrence' : scope === 'following' ? 'Save for this and later ones' : 'Save changes'
}

/** "Tue, Oct 20, 10:00 AM" (all-day: "Tue, Oct 20"). */
export function startLabel(t: CalendarDraftTime): string {
  return isTimed(t) ? `${dateLabel(localDate(t))}, ${clock(t)}` : dateLabel(localDate(t))
}
