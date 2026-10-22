// SPDX-License-Identifier: Apache-2.0
// Calendar drafts: the `calendar_event` block shape, its
// validation messages, the repeat rule (one RRULE line) and the update diff. Pure: no Electron,
// no network.

import type { CalendarDraftTime, CalendarEventDraft } from '@shared/types/workflow-blocks'
import type { CalendarEvent } from '@shared/types/notes'
import { bad } from '../blocks'

type Obj = Record<string, unknown>
type TimeOption = { start: CalendarDraftTime; end: CalendarDraftTime }

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

export const NOT_AVAILABLE = 'Notula can only create regular events.'

// ---------- shape ----------

function time(v: unknown, what: string): CalendarDraftTime {
  const o = obj(v)
  if (typeof o['date'] === 'string') {
    if (!DATE.test(o['date'])) throw bad(`${what} needs a date like 2026-10-20`)
    return { date: o['date'] }
  }
  const dt = str(o['dateTime'])
  const tz = str(o['timeZone'])
  if (!DATETIME.test(dt) || Number.isNaN(Date.parse(dt))) throw bad(`${what} needs a time with its offset`)
  if (!tz || !validZone(tz)) throw bad(`${what} needs a time zone`)
  return { dateTime: dt, timeZone: tz }
}

function validZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz })
    return true
  } catch {
    return false
  }
}

function option(v: unknown): TimeOption {
  const o = obj(v)
  return { start: time(o['start'], 'The start'), end: time(o['end'], 'The end') }
}

function attendees(v: unknown): { email: string; resource?: boolean }[] {
  if (v === undefined || v === null) return []
  if (!Array.isArray(v)) throw bad('Guests must be a list')
  const seen = new Set<string>()
  const out: { email: string; resource?: boolean }[] = []
  for (const a of v) {
    const o = typeof a === 'string' ? { email: a } : obj(a)
    const email = str(o['email']).trim()
    if (!EMAIL.test(email)) throw bad(`${email || 'A guest'} isn’t a valid email address`)
    const key = email.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(o['resource'] === true ? { email, resource: true } : { email })
  }
  if (out.length > 200) throw bad('Too many guests')
  return out
}

/**
 * The stored content, from a block write or the tool's arguments. The tool also accepts the
 * simple shape {summary, start, end, withMeetLink}. Execution and dismissal live
 * on the block row, so they are null here.
 */
export function normalizeDraft(raw: unknown): CalendarEventDraft {
  const c = obj(raw)
  let timeOptions: TimeOption[]
  if (Array.isArray(c['timeOptions'])) timeOptions = (c['timeOptions'] as unknown[]).map(option)
  else if (c['start'] !== undefined) timeOptions = [{ start: time(c['start'], 'The start'), end: time(c['end'], 'The end') }]
  else timeOptions = []
  if (timeOptions.length < 1 || timeOptions.length > 3) throw bad('Propose one to three times')
  const conf = obj(c['conference'])
  let conference: CalendarEventDraft['conference'] = { kind: 'none' }
  if (conf['kind'] === 'googleMeet' || (c['conference'] === undefined && c['withMeetLink'] === true)) conference = { kind: 'googleMeet' }
  else if (conf['kind'] === 'custom') conference = { kind: 'custom', url: str(conf['url']).trim().slice(0, 2_048) }
  const eventType = c['eventType'] === 'focusTime' || c['eventType'] === 'outOfOffice' ? c['eventType'] : 'default'
  const d: CalendarEventDraft = {
    eventType,
    summary: str(c['summary']).trim().slice(0, 1_000),
    timeOptions,
    conference,
    attendees: attendees(c['attendees']),
    description: str(c['description']).slice(0, 8_000),
    addMeAsGuest: c['addMeAsGuest'] !== false,
    execution: null,
    dismissedAt: null
  }
  if (c['selectedTime'] !== undefined && c['selectedTime'] !== null) d.selectedTime = option(c['selectedTime'])
  if (typeof c['location'] === 'string') d.location = c['location'].slice(0, 500)
  if (typeof c['autoDeclineMode'] === 'string') d.autoDeclineMode = c['autoDeclineMode'] as NonNullable<CalendarEventDraft['autoDeclineMode']>
  if (typeof c['declineMessage'] === 'string') d.declineMessage = c['declineMessage']
  if (Array.isArray(c['recurrenceRules'])) {
    const rules = (c['recurrenceRules'] as unknown[]).filter((x): x is string => typeof x === 'string' && /^(RRULE|EXRULE|RDATE|EXDATE)[:;]/.test(x)).slice(0, 10)
    if (rules.length) d.recurrenceRules = rules
  }
  const from = obj(c['fromEvent'])
  if (str(from['eventId']) && str(from['calendarId'])) {
    d.fromEvent = { calendarId: str(from['calendarId']), eventId: str(from['eventId']), scope: from['scope'] === 'series' ? 'series' : 'occurrence' }
  }
  const ex = obj(c['existingEvent'])
  if (str(ex['eventId']) && str(ex['calendarId'])) {
    const original = normalizeDraft({ ...obj(ex['original']), existingEvent: undefined, fromEvent: undefined })
    const { execution: _e, dismissedAt: _d, existingEvent: _x, ...orig } = original
    d.existingEvent = { calendarId: str(ex['calendarId']), eventId: str(ex['eventId']), scope: ex['scope'] === 'series' ? 'series' : 'occurrence', etag: str(ex['etag']), original: orig }
  }
  return d
}

// ---------- validation ----------

const isTimed = (t: CalendarDraftTime): t is { dateTime: string; timeZone: string } => 'dateTime' in t
const DAY_MS = 86_400_000

/** The chosen time: the selected one, else the only option. */
export function chosenTime(d: CalendarEventDraft): TimeOption | null {
  if (d.selectedTime) return d.selectedTime
  return d.timeOptions.length === 1 ? (d.timeOptions[0] ?? null) : null
}

/** The first message that blocks the draft, or null. */
export function validateDraft(d: CalendarEventDraft): string | null {
  if (d.eventType && d.eventType !== 'default') return NOT_AVAILABLE
  if (d.autoDeclineMode || d.declineMessage) return 'Auto-decline settings can’t be set from Notula.'
  const allDay = d.timeOptions.some((o) => !isTimed(o.start) || !isTimed(o.end))
  if (allDay) {
    if (d.timeOptions.length !== 1 || d.timeOptions.some((o) => isTimed(o.start) || isTimed(o.end))) return 'An all-day event needs a single date range with no times.'
    const o = d.timeOptions[0]
    if (o && 'date' in o.start && 'date' in o.end && !(o.end.date > o.start.date)) return 'Pick an end date that comes after the start date.'
    if (d.recurrenceRules?.length) return 'All-day events can’t be set to repeat.'
  } else {
    for (const o of d.timeOptions) {
      if (!isTimed(o.start) || !isTimed(o.end)) continue
      if (o.start.timeZone !== o.end.timeZone) return 'Use one time zone for both the start and the end.'
      const ms = Date.parse(o.end.dateTime) - Date.parse(o.start.dateTime)
      if (!(ms > 0)) return 'The end time must be after the start time.'
      if (ms > DAY_MS) return 'Events can’t be longer than 24 hours.'
    }
    const zones = new Set(d.timeOptions.map((o) => (isTimed(o.start) ? o.start.timeZone : '')))
    if (zones.size > 1) return 'All time options must use the same time zone.'
    const sel = d.selectedTime
    if (sel && isTimed(sel.start) && !zones.has(sel.start.timeZone)) return 'The chosen time must use the same time zone as the options.'
  }
  if (d.recurrenceRules?.length) {
    if (d.timeOptions.length !== 1) return 'A repeating event can have only one time option.'
    const first = d.timeOptions[0]
    const rule = parseRule(d.recurrenceRules)
    if (first && rule) {
      const date = localDate(first.start)
      if (rule.until && rule.until < date) return 'The repeat end date is before the event’s first date.'
      if (!matchesRule(rule, date)) return 'The start date doesn’t match the repeat pattern.'
    }
  }
  if (d.conference.kind === 'custom' && !validLink(d.conference.url)) return 'Add a valid meeting link'
  return null
}

export function validLink(url: string): boolean {
  try {
    const u = new URL(url)
    return (u.protocol === 'https:' || u.protocol === 'http:') && !!u.hostname
  } catch {
    return false
  }
}

// ---------- the repeat rule ----------

export interface RepeatRule {
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY'
  interval: number
  /** Weekly: `MO`…`SU`. */
  weekdays: string[]
  /** Monthly by weekday: −5…5 except 0, with one weekday in `weekdays`. */
  weekOfMonth: number | null
  /** Monthly by day of month. */
  monthDay: number | null
  count: number | null
  /** `YYYY-MM-DD` in the event's zone. */
  until: string | null
}

export const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'] as const

/** The local `YYYY-MM-DD` of a draft time (the dateTime's own wall clock). */
export function localDate(t: CalendarDraftTime): string {
  return 'date' in t ? t.date : t.dateTime.slice(0, 10)
}

function weekdayOf(date: string): string {
  return WEEKDAYS[new Date(`${date}T12:00:00Z`).getUTCDay()] ?? 'MO'
}

/** The first RRULE line, parsed; null when it is missing or outside what Notula edits. */
export function parseRule(rules: string[]): RepeatRule | null {
  const line = rules.find((r) => r.startsWith('RRULE:'))
  if (!line) return null
  const parts = Object.fromEntries(
    line
      .slice(6)
      .split(';')
      .map((p) => p.split('=') as [string, string])
  )
  const freq = parts['FREQ']
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return null
  const rule: RepeatRule = {
    frequency: freq,
    interval: Math.max(1, Math.min(365, Number(parts['INTERVAL'] ?? 1) || 1)),
    weekdays: [],
    weekOfMonth: null,
    monthDay: null,
    count: parts['COUNT'] ? Math.max(1, Math.min(1_000, Number(parts['COUNT']) || 1)) : null,
    until: null
  }
  const until = parts['UNTIL']
  if (until && /^\d{8}/.test(until)) rule.until = `${until.slice(0, 4)}-${until.slice(4, 6)}-${until.slice(6, 8)}`
  const byday = parts['BYDAY']
  if (byday) {
    for (const p of byday.split(',')) {
      const m = /^([+-]?\d)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(p)
      if (!m) return null
      if (m[2]) rule.weekdays.push(m[2])
      if (m[1]) rule.weekOfMonth = Number(m[1])
    }
  }
  if (parts['BYMONTHDAY']) rule.monthDay = Number(parts['BYMONTHDAY']) || null
  return rule
}

function nthOfMonth(date: string): { ordinal: number; last: boolean } {
  const day = Number(date.slice(8, 10))
  const [y, m] = [Number(date.slice(0, 4)), Number(date.slice(5, 7))]
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { ordinal: Math.ceil(day / 7), last: day + 7 > days }
}

function matchesRule(r: RepeatRule, date: string): boolean {
  const wd = weekdayOf(date)
  if (r.frequency === 'WEEKLY') return !r.weekdays.length || r.weekdays.includes(wd)
  if (r.frequency === 'MONTHLY') {
    if (r.weekOfMonth !== null) {
      if (r.weekdays[0] !== wd) return false
      const n = nthOfMonth(date)
      return r.weekOfMonth === -1 ? n.last : r.weekOfMonth === n.ordinal
    }
    if (r.monthDay !== null) return Number(date.slice(8, 10)) === r.monthDay
  }
  return true
}

// ---------- updates ----------

export interface DraftDiff {
  title?: string
  description?: string
  time?: TimeOption
  location?: string
  addAttendees: { email: string; resource?: boolean }[]
  removeAttendees: string[]
  conference?: CalendarEventDraft['conference']
}

const SERIES_REFUSAL = 'To move a whole series, suggest a single time. Several time options only work for a one-off event.'

/** The changed fields of an update, or the refusal that blocks it. */
export function diffDraft(d: CalendarEventDraft): { diff: DraftDiff } | { refusal: string } {
  const ex = d.existingEvent
  if (!ex) return { refusal: 'This draft doesn’t edit an event.' }
  const o = ex.original
  if (d.eventType && d.eventType !== 'default') return { refusal: 'This kind of event, such as focus time or out of office, can’t be edited from Notula.' }
  if (JSON.stringify(d.recurrenceRules ?? []) !== JSON.stringify(o.recurrenceRules ?? [])) return { refusal: 'Repeat settings can’t be changed from Notula.' }
  if ((d.addMeAsGuest !== false) !== (o.addMeAsGuest !== false)) return { refusal: 'Notula can’t add or remove you as an attendee.' }
  const diff: DraftDiff = { addAttendees: [], removeAttendees: [] }
  if (d.summary !== o.summary) diff.title = d.summary
  if (d.description !== o.description) diff.description = d.description
  if ((d.location ?? '') !== (o.location ?? '')) diff.location = d.location ?? ''
  const t = chosenTime(d)
  const ot = chosenTime({ ...o, execution: null, dismissedAt: null })
  if (t && JSON.stringify(t) !== JSON.stringify(ot)) diff.time = t
  const before = new Set(o.attendees.map((a) => a.email.toLowerCase()))
  const after = new Set(d.attendees.map((a) => a.email.toLowerCase()))
  diff.addAttendees = d.attendees.filter((a) => !before.has(a.email.toLowerCase()))
  diff.removeAttendees = o.attendees.filter((a) => !after.has(a.email.toLowerCase())).map((a) => a.email)
  if (JSON.stringify(d.conference) !== JSON.stringify(o.conference)) diff.conference = d.conference
  const changed = diff.title !== undefined || diff.description !== undefined || diff.location !== undefined || diff.time || diff.conference || diff.addAttendees.length || diff.removeAttendees.length
  if (!changed) return { refusal: 'This draft doesn’t change the event.' }
  if (ex.scope === 'series' && d.selectedTime && d.timeOptions.length > 1) return { refusal: SERIES_REFUSAL }
  return { diff }
}

// ---------- an existing event as a draft (for `fromEvent`) ----------

function eventTime(v: unknown): CalendarDraftTime | null {
  const o = obj(v)
  if (typeof o['date'] === 'string') return { date: o['date'] }
  const dt = str(o['dateTime'])
  if (!dt) return null
  return { dateTime: dt, timeZone: str(o['timeZone']) || Intl.DateTimeFormat().resolvedOptions().timeZone }
}

/** A synced event (Google JSON shape) as the draft it would be. */
export function draftFromEvent(ev: CalendarEvent, myEmails: readonly string[]): Omit<CalendarEventDraft, 'existingEvent' | 'execution' | 'dismissedAt'> {
  const start = eventTime(ev.start)
  const end = eventTime(ev.end)
  const mine = new Set(myEmails.map((e) => e.toLowerCase()))
  const meet = !!obj(ev['conferenceData'])['conferenceId'] || typeof ev['hangoutLink'] === 'string'
  return {
    eventType: 'default',
    summary: str(ev.summary),
    timeOptions: start && end ? [{ start, end }] : [],
    conference: meet ? { kind: 'googleMeet' } : { kind: 'none' },
    ...(typeof ev['location'] === 'string' ? { location: ev['location'] } : {}),
    addMeAsGuest: true,
    attendees: (ev.attendees ?? [])
      .filter((a) => typeof a.email === 'string' && !mine.has(a.email.toLowerCase()))
      .map((a) => ((a as { resource?: unknown }).resource === true ? { email: String(a.email), resource: true } : { email: String(a.email) })),
    description: str(ev['description'])
  }
}
