// SPDX-License-Identifier: Apache-2.0
// Calendar drafts: the `calendar_event` block shape, its
// validation messages, the repeat rule (one RRULE line) and the update diff. Pure: no Electron,
// no network.

import type { CalendarColorId, CalendarDraftTime, CalendarEditScope, CalendarEventDraft } from '@shared/types/workflow-blocks'
import type { CalendarEvent } from '@shared/types/notes'
import { bad } from '../blocks'
import { isoWithOffset, zonedWallToUtcMs, zoneOffsetMs } from '../calendar/tz'

type Obj = Record<string, unknown>
type TimeOption = { start: CalendarDraftTime; end: CalendarDraftTime }

const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})?$/
const COLORS: readonly CalendarColorId[] = ['default', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11']
const VISIBILITY = ['default', 'public', 'private'] as const
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const scopeOf = (v: unknown): CalendarEditScope => (v === 'series' || v === 'following' ? v : 'occurrence')
const userZone = (): string => Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'

export const NOT_AVAILABLE = 'Notula can only create regular events.'
export const OFFSET_AND_ZONE = 'Give the time either with its offset or with a time zone, not both.'

export interface NormalizeOptions {
  /** The tool's arguments: a time may leave out its offset, and a given offset must agree with a given zone. */
  tool?: boolean
  /** An edit's current length, which fills an end the tool left out. */
  length?: { ms: number } | { days: number }
}

// ---------- shape ----------

/** An instant as ISO 8601 with the zone's own offset at that instant. */
function zoned(ms: number, tz: string): string {
  return isoWithOffset(ms, zoneOffsetMs(tz, ms))
}

function time(v: unknown, what: string, opts: NormalizeOptions): CalendarDraftTime {
  const o = obj(v)
  if (typeof o['date'] === 'string') {
    if (!DATE.test(o['date'])) throw bad(`${what} needs a date like 2026-10-20`)
    return { date: o['date'] }
  }
  const dt = str(o['dateTime'])
  const given = str(o['timeZone'])
  const m = DATETIME.exec(dt)
  if (!m || (m[7] && Number.isNaN(Date.parse(dt)))) throw bad(`${what} needs a time like 2026-10-20T10:00`)
  const tz = given || (opts.tool ? userZone() : '')
  if (!tz || !validZone(tz)) throw bad(`${what} needs a time zone`)
  if (!m[7]) {
    // A wall-clock time: read in its zone.
    const ms = zonedWallToUtcMs({ year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? 0) }, tz)
    return { dateTime: zoned(ms, tz), timeZone: tz }
  }
  if (opts.tool) {
    const ms = Date.parse(dt)
    const offset = m[7] === 'Z' ? 0 : (m[7].startsWith('-') ? -1 : 1) * (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(4, 6))) * 60_000
    if (offset !== zoneOffsetMs(tz, ms)) {
      if (given) throw bad(OFFSET_AND_ZONE)
      // Only an offset: the same instant, shown in the user's zone.
      return { dateTime: zoned(ms, tz), timeZone: tz }
    }
  }
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

function option(v: unknown, opts: NormalizeOptions): TimeOption {
  const o = obj(v)
  const start = time(o['start'], 'The start', opts)
  if (o['end'] === undefined && opts.length) return { start, end: endAfter(start, opts.length) }
  return { start, end: time(o['end'], 'The end', opts) }
}

/** The end that keeps an edit's length. */
function endAfter(start: CalendarDraftTime, length: NonNullable<NormalizeOptions['length']>): CalendarDraftTime {
  if ('date' in start) {
    const days = 'days' in length ? length.days : Math.max(1, Math.round(length.ms / DAY_MS))
    return { date: new Date(Date.parse(`${start.date}T12:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10) }
  }
  const ms = 'ms' in length ? length.ms : length.days * DAY_MS
  return { dateTime: zoned(Date.parse(start.dateTime) + ms, start.timeZone), timeZone: start.timeZone }
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
export function normalizeDraft(raw: unknown, opts: NormalizeOptions = {}): CalendarEventDraft {
  const c = obj(raw)
  let timeOptions: TimeOption[]
  if (Array.isArray(c['timeOptions'])) timeOptions = (c['timeOptions'] as unknown[]).map((o) => option(o, opts))
  else if (c['start'] !== undefined) timeOptions = [option({ start: c['start'], end: c['end'] }, opts)]
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
  if (c['selectedTime'] !== undefined && c['selectedTime'] !== null) d.selectedTime = option(c['selectedTime'], {})
  if (typeof c['location'] === 'string') d.location = c['location'].slice(0, 500)
  if (typeof c['autoDeclineMode'] === 'string') d.autoDeclineMode = c['autoDeclineMode'] as NonNullable<CalendarEventDraft['autoDeclineMode']>
  if (typeof c['declineMessage'] === 'string') d.declineMessage = c['declineMessage']
  if (Array.isArray(c['recurrenceRules'])) {
    const rules = (c['recurrenceRules'] as unknown[]).filter((x): x is string => typeof x === 'string' && /^(RRULE|EXRULE|RDATE|EXDATE)[:;]/.test(x)).slice(0, 10)
    if (rules.length) d.recurrenceRules = rules
  }
  if (c['colorId'] !== undefined) {
    const color = String(c['colorId'])
    if (!COLORS.includes(color as CalendarColorId)) throw bad('Use a color from 1 to 11, or default')
    d.colorId = color as CalendarColorId
  }
  if (c['visibility'] !== undefined) {
    if (!VISIBILITY.includes(c['visibility'] as (typeof VISIBILITY)[number])) throw bad('Visibility must be default, public or private')
    d.visibility = c['visibility'] as (typeof VISIBILITY)[number]
  }
  const from = obj(c['fromEvent'])
  if (str(from['eventId']) && str(from['calendarId'])) {
    d.fromEvent = { calendarId: str(from['calendarId']), eventId: str(from['eventId']), scope: scopeOf(from['scope']) }
  }
  const ex = obj(c['existingEvent'])
  if (str(ex['eventId']) && str(ex['calendarId'])) {
    const original = normalizeDraft({ ...obj(ex['original']), existingEvent: undefined, fromEvent: undefined })
    const { execution: _e, dismissedAt: _d, existingEvent: _x, ...orig } = original
    d.existingEvent = { calendarId: str(ex['calendarId']), eventId: str(ex['eventId']), scope: scopeOf(ex['scope']), etag: str(ex['etag']), original: orig }
    if (str(ex['seriesEtag'])) d.existingEvent.seriesEtag = str(ex['seriesEtag'])
    if (ex['occurrenceStart'] !== undefined && ex['occurrenceStart'] !== null) d.existingEvent.occurrenceStart = time(ex['occurrenceStart'], 'The occurrence', {})
  }
  return d
}

// ---------- validation ----------

const isTimed = (t: CalendarDraftTime): t is { dateTime: string; timeZone: string } => 'dateTime' in t
const DAY_MS = 86_400_000
const DECLINE_REFUSAL = 'Auto-decline settings can’t be set from Notula.'

/** The chosen time: the selected one, else the only option. */
export function chosenTime(d: CalendarEventDraft): TimeOption | null {
  if (d.selectedTime) return d.selectedTime
  return d.timeOptions.length === 1 ? (d.timeOptions[0] ?? null) : null
}

/** The first message that blocks the draft, or null. */
export function validateDraft(d: CalendarEventDraft): string | null {
  if (d.eventType && d.eventType !== 'default') return NOT_AVAILABLE
  if (d.autoDeclineMode || d.declineMessage) return DECLINE_REFUSAL
  const allDay = d.timeOptions.some((o) => !isTimed(o.start) || !isTimed(o.end))
  if (allDay) {
    if (d.timeOptions.length !== 1 || d.timeOptions.some((o) => isTimed(o.start) || isTimed(o.end))) return 'An all-day event needs a single date range with no times.'
    const o = d.timeOptions[0]
    if (o && 'date' in o.start && 'date' in o.end && !(o.end.date > o.start.date)) return 'Pick an end date that comes after the start date.'
    const allDayRules = allDayRepeatProblem(d.recurrenceRules ?? [])
    if (allDayRules) return allDayRules
  } else {
    for (const o of d.timeOptions) {
      if (!isTimed(o.start) || !isTimed(o.end)) continue
      if (o.start.timeZone !== o.end.timeZone) return 'Use one time zone for both the start and the end.'
      const ms = Date.parse(o.end.dateTime) - Date.parse(o.start.dateTime)
      if (!(ms > 0)) return 'The end time must be after the start time.'
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

/** An all-day series ends on a date, and its extra or skipped dates are dates too. */
function allDayRepeatProblem(rules: string[]): string | null {
  const rrule = rules.find((r) => r.startsWith('RRULE:'))
  const until = rrule ? /(?:^|;)UNTIL=([^;]+)/.exec(rrule.slice(6))?.[1] : undefined
  if (until !== undefined && !/^\d{8}$/.test(until)) return 'Use a date (YYYYMMDD) for the end of an all-day series.'
  for (const line of rules) {
    if (!/^(RDATE|EXDATE)/.test(line)) continue
    const head = line.slice(0, Math.max(0, line.indexOf(':')))
    if (!/;VALUE=DATE(;|$)/.test(head)) return 'Extra or skipped dates of an all-day series must be dates, not times.'
  }
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
  frequency: 'DAILY' | 'WEEKLY' | 'MONTHLY' | 'YEARLY'
  interval: number
  /** Weekly: `MO`…`SU`. */
  weekdays: string[]
  /** Monthly by weekday: −5…5 except 0, with one weekday in `weekdays`. */
  weekOfMonth: number | null
  /** Monthly or yearly by day of month: 1…31, or −1 for the last day. */
  monthDay: number | null
  /** Yearly: 1…12. */
  month: number | null
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
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY' && freq !== 'YEARLY') return null
  const rule: RepeatRule = {
    frequency: freq,
    interval: Math.max(1, Math.min(365, Number(parts['INTERVAL'] ?? 1) || 1)),
    weekdays: [],
    weekOfMonth: null,
    monthDay: null,
    month: null,
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
      if (m[1]) {
        const n = Number(m[1])
        if (n === 0 || n < -5 || n > 5) return null
        rule.weekOfMonth = n
      }
    }
  }
  if (parts['BYMONTHDAY']) {
    const n = Number(parts['BYMONTHDAY'])
    if (!Number.isInteger(n) || n === 0 || n > 31 || n < -1) return null
    rule.monthDay = n
  }
  if (parts['BYMONTH']) {
    const n = Number(parts['BYMONTH'])
    if (!Number.isInteger(n) || n < 1 || n > 12) return null
    rule.month = n
  }
  return rule
}

function monthDays(date: string): number {
  return new Date(Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)), 0)).getUTCDate()
}

function matchesDay(monthDay: number, date: string): boolean {
  const day = Number(date.slice(8, 10))
  return monthDay < 0 ? day === monthDays(date) + monthDay + 1 : day === monthDay
}

function matchesRule(r: RepeatRule, date: string): boolean {
  const wd = weekdayOf(date)
  if (r.frequency === 'WEEKLY') return !r.weekdays.length || r.weekdays.includes(wd)
  if (r.frequency === 'MONTHLY' || r.frequency === 'YEARLY') {
    if (r.month !== null && Number(date.slice(5, 7)) !== r.month) return false
    if (r.weekOfMonth !== null) {
      if (r.weekdays[0] !== wd) return false
      const day = Number(date.slice(8, 10))
      return r.weekOfMonth < 0 ? Math.ceil((monthDays(date) - day + 1) / 7) === -r.weekOfMonth : Math.ceil(day / 7) === r.weekOfMonth
    }
    if (r.monthDay !== null) return matchesDay(r.monthDay, date)
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
  /** The new recurrence lines (series and following edits). */
  recurrence?: string[]
  colorId?: CalendarColorId
  visibility?: 'default' | 'public' | 'private'
}

export const NO_CHANGE = 'This draft doesn’t change the event.'
const SERIES_REFUSAL = 'To move a whole series, suggest a single time. Several time options only work for a one-off event.'

/** The changed fields of an update, or the refusal that blocks it. */
export function diffDraft(d: CalendarEventDraft): { diff: DraftDiff } | { refusal: string } {
  const ex = d.existingEvent
  if (!ex) return { refusal: 'This draft doesn’t edit an event.' }
  const o = ex.original
  if (d.eventType && d.eventType !== 'default') return { refusal: 'Notula can’t turn an event into a different kind of event.' }
  if (d.autoDeclineMode || d.declineMessage) return { refusal: DECLINE_REFUSAL }
  const rules = d.recurrenceRules ?? []
  const before = o.recurrenceRules ?? []
  const rulesChanged = JSON.stringify(rules) !== JSON.stringify(before)
  if (ex.scope === 'occurrence' && rulesChanged) return { refusal: 'Pick the whole series, or this and the later ones, to change how it repeats.' }
  if ((d.addMeAsGuest !== false) !== (o.addMeAsGuest !== false)) return { refusal: 'Notula can’t add or remove you as an attendee.' }
  if (before.length && !rules.length) return { refusal: 'Notula can’t stop a series from repeating. Change it in your calendar app.' }
  const diff: DraftDiff = { addAttendees: [], removeAttendees: [] }
  if (d.summary !== o.summary) diff.title = d.summary
  if (d.description !== o.description) diff.description = d.description
  if ((d.location ?? '') !== (o.location ?? '')) diff.location = d.location ?? ''
  const t = chosenTime(d)
  const ot = chosenTime({ ...o, execution: null, dismissedAt: null })
  if (t && JSON.stringify(t) !== JSON.stringify(ot)) diff.time = t
  const had = new Set(o.attendees.map((a) => a.email.toLowerCase()))
  const has = new Set(d.attendees.map((a) => a.email.toLowerCase()))
  diff.addAttendees = d.attendees.filter((a) => !had.has(a.email.toLowerCase()))
  diff.removeAttendees = o.attendees.filter((a) => !has.has(a.email.toLowerCase())).map((a) => a.email)
  if (JSON.stringify(d.conference) !== JSON.stringify(o.conference)) diff.conference = d.conference
  if (rulesChanged) diff.recurrence = rules
  // Left out means unchanged; `default` is the calendar's own setting.
  if (d.colorId !== undefined && d.colorId !== (o.colorId ?? 'default')) diff.colorId = d.colorId
  if (d.visibility !== undefined && d.visibility !== (o.visibility ?? 'default')) diff.visibility = d.visibility
  if (diff.visibility !== undefined && ex.scope === 'occurrence' && ex.occurrenceStart) {
    return { refusal: 'Your calendar only lets you change who can see this for the whole series.' }
  }
  const changed =
    diff.title !== undefined ||
    diff.description !== undefined ||
    diff.location !== undefined ||
    diff.time ||
    diff.conference ||
    diff.recurrence ||
    diff.colorId !== undefined ||
    diff.visibility !== undefined ||
    diff.addAttendees.length ||
    diff.removeAttendees.length
  if (!changed) return { refusal: NO_CHANGE }
  if (ex.scope !== 'occurrence' && d.selectedTime && d.timeOptions.length > 1) return { refusal: SERIES_REFUSAL }
  return { diff }
}

// ---------- an existing event as a draft (for `fromEvent`) ----------

/** A synced event time; a timed one is shown in its own zone, so the card reads its wall clock. */
export function eventTime(v: unknown): CalendarDraftTime | null {
  const o = obj(v)
  if (typeof o['date'] === 'string') return { date: o['date'] }
  const dt = str(o['dateTime'])
  if (!dt) return null
  const tz = str(o['timeZone']) && validZone(str(o['timeZone'])) ? str(o['timeZone']) : userZone()
  const ms = Date.parse(dt)
  return { dateTime: Number.isNaN(ms) ? dt : zoned(ms, tz), timeZone: tz }
}

/** A synced event (Google JSON shape) as the draft it would be. */
export function draftFromEvent(ev: CalendarEvent, myEmails: readonly string[]): Omit<CalendarEventDraft, 'existingEvent' | 'execution' | 'dismissedAt'> {
  const start = eventTime(ev.start)
  const end = eventTime(ev.end)
  const mine = new Set(myEmails.map((e) => e.toLowerCase()))
  const meet = !!obj(ev['conferenceData'])['conferenceId'] || typeof ev['hangoutLink'] === 'string'
  const color = str(ev['colorId'])
  const visibility = str(ev['visibility'])
  const recurrence = Array.isArray(ev['recurrence']) ? (ev['recurrence'] as unknown[]).filter((x): x is string => typeof x === 'string' && /^(RRULE|EXRULE|RDATE|EXDATE)[:;]/.test(x)) : []
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
    description: str(ev['description']),
    ...(COLORS.includes(color as CalendarColorId) ? { colorId: color as CalendarColorId } : {}),
    ...(VISIBILITY.includes(visibility as (typeof VISIBILITY)[number]) ? { visibility: visibility as (typeof VISIBILITY)[number] } : {}),
    ...(recurrence.length ? { recurrenceRules: recurrence.slice(0, 10) } : {})
  }
}
