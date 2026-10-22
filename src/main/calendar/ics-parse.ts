// SPDX-License-Identifier: Apache-2.0
// ICS parsing: ical.js, VEVENT only, recurrences
// expanded in the sync window, each instance mapped into the canonical Google-shaped
// event row.
//
// This runs only in the notula-ics utility process (ics-worker.ts), never on main: a
// feed with old recurring series or many events costs seconds of CPU. Nothing here imports
// Electron or the log; warnings travel back with the result.

import { createHash } from 'node:crypto'
import ICAL from 'ical.js'
import type { CalendarAttendee, CalendarEvent } from '@shared/types/notes'
import { CALENDAR_SYNC } from '@shared/types/calendar'
import { IcsError } from './ics'
import {
  ianaZoneFor,
  isoWithOffset,
  localWallToUtcMs,
  utcBasic,
  utcMsToZonedWall,
  wallAsUtcMs,
  zonedWallToUtcMs,
  type WallTime
} from './tz'

type IcalComponent = InstanceType<typeof ICAL.Component>
type IcalProperty = InstanceType<typeof ICAL.Property>
type IcalTime = InstanceType<typeof ICAL.Time>
type IcalRecur = InstanceType<typeof ICAL.Recur>

/** Recurrence steps per feed, all series together. Past it the refresh fails and deletes nothing. */
export const FEED_ITERATION_BUDGET = 200_000
/** Recurrence steps per series: past it the series is truncated (a rule that never reaches the window). */
const SERIES_ITERATION_CAP = 100_000
const DAY_MS = 86_400_000
/** No UTC offset is a day or more, so a wall time more than this outside the window is outside it. */
const WALL_SLACK_MS = 2 * DAY_MS
/** Seconds per FREQ unit, for the rules whose instances repeat exactly with their period. */
const PERIOD_S: Record<string, number> = { SECONDLY: 1, MINUTELY: 60, HOURLY: 3_600, DAILY: 86_400, WEEKLY: 604_800 }

export interface ParseOptions {
  sourceId: string
  /** The feed's calendar id, `ics:<sourceId>:<native id>`. */
  calendarId: string
  /** "My emails" (lower-cased): `self` on the organizer and attendees. */
  myEmails: ReadonlySet<string>
  window: { fromMs: number; toMs: number }
}

export interface ParsedFeed {
  /** X-WR-CALNAME, when present. */
  name: string | null
  /** X-APPLE-CALENDAR-COLOR / COLOR when it is a hex colour. */
  color: string | null
  /** Every instance in the window, mapped; the event filter is the caller's. */
  events: CalendarEvent[]
  skipped: number
  /**
   * False when ical.js rejected the feed and only its readable blocks were kept: the
   * refresh then adds and updates events but deletes none.
   */
  complete: boolean
  /** Log lines for main, which owns the log (no feed content, no URL). */
  warnings: ParseWarning[]
}

export interface ParseWarning {
  event: string
  data: Record<string, string | number>
}

/** True when the text is an iCalendar file at all (else `invalid_feed`). */
export function looksLikeIcs(text: string): boolean {
  return /BEGIN:VCALENDAR/i.test(text.slice(0, 64 * 1024)) || /BEGIN:VCALENDAR/i.test(text)
}

/**
 * True when the body ends with END:VCALENDAR. A server that times out while generating
 * can end the response early but cleanly; such a body must not count as the whole
 * calendar, or the events after the cut would be deleted.
 */
export function looksComplete(text: string): boolean {
  return /END:VCALENDAR\s*$/i.test(text.slice(-1_024))
}

/** Parses the feed; a syntax error in one VEVENT only skips that event. */
export function parseIcs(text: string, opts: ParseOptions): ParsedFeed {
  if (!looksLikeIcs(text)) throw new IcsError('invalid_feed', 'the address returned no calendar data')
  if (!looksComplete(text)) throw new IcsError('fetch_failed', 'the calendar arrived incomplete')
  const warnings: ParseWarning[] = []
  const { calendar, skipped: syntaxSkipped, complete } = parseCalendar(text)
  if (syntaxSkipped) warnings.push({ event: 'calendar:ics-events-skipped', data: { count: syntaxSkipped, reason: 'syntax' } })
  const name = textOf(calendar.getFirstPropertyValue('x-wr-calname'))
  const colorRaw = textOf(calendar.getFirstPropertyValue('x-apple-calendar-color')) ?? textOf(calendar.getFirstPropertyValue('color'))
  const color = colorRaw && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(colorRaw) ? colorRaw.slice(0, 7) : null
  const mapper = new FeedMapper(opts, warnings)
  for (const vevent of calendar.getAllSubcomponents('vevent')) mapper.add(vevent)
  const events = mapper.expand()
  return { name, color, events, skipped: syntaxSkipped + mapper.skipped, complete, warnings }
}

function parseCalendar(text: string): { calendar: IcalComponent; skipped: number; complete: boolean } {
  let parsed: { calendar: IcalComponent; skipped: number; complete: boolean }
  try {
    parsed = { calendar: rootOf(ICAL.parse(text)), skipped: 0, complete: true }
  } catch {
    // Isolate the broken parts: parse the calendar shell with its time zones, then each VEVENT alone.
    parsed = { ...parseResilient(text), complete: false }
  }
  memoizeZones(parsed.calendar)
  return parsed
}

/**
 * ical.js resolves a TZID on every read of a DTSTART, DTEND, EXDATE or RECURRENCE-ID and
 * caches only the zones it finds: a TZID the feed doesn't define (a bare IANA name, which
 * many exporters write without a VTIMEZONE) rescans every component of the calendar on
 * each read, which is quadratic in the number of events. The lookup
 * is memoized here, misses included; the calendar is complete by now, so a miss stays a
 * miss. instantOf resolves IANA and Windows names itself.
 */
function memoizeZones(calendar: IcalComponent): void {
  const lookup = calendar.getTimeZoneByID.bind(calendar)
  const memo = new Map<string, ReturnType<typeof lookup> | null>()
  calendar.getTimeZoneByID = (tzid: string) => {
    let zone = memo.get(tzid)
    if (zone === undefined) {
      zone = lookup(tzid) ?? null
      memo.set(tzid, zone)
    }
    return zone as ReturnType<typeof lookup>
  }
}

function rootOf(jcal: unknown): IcalComponent {
  const list = Array.isArray(jcal) && Array.isArray(jcal[0]) ? (jcal as unknown[]) : [jcal]
  const vcal = list.find((c) => Array.isArray(c) && typeof c[0] === 'string' && c[0].toLowerCase() === 'vcalendar')
  if (!vcal) throw new IcsError('invalid_feed', 'the address returned no calendar data')
  return new ICAL.Component(vcal as unknown[])
}

function parseResilient(text: string): { calendar: IcalComponent; skipped: number } {
  const lines = text.replace(/\r\n|\r/g, '\n').replace(/\n[ \t]/g, '').split('\n')
  const shell: string[] = []
  const blocks: { kind: string; lines: string[] }[] = []
  let current: { kind: string; lines: string[] } | null = null
  let depth = 0
  for (const line of lines) {
    const begin = /^BEGIN:(\w[\w-]*)/i.exec(line)
    const end = /^END:(\w[\w-]*)/i.exec(line)
    if (!current && begin && /^(VEVENT|VTIMEZONE)$/i.test(begin[1] as string)) {
      current = { kind: (begin[1] as string).toUpperCase(), lines: [line] }
      depth = 1
      continue
    }
    if (current) {
      current.lines.push(line)
      if (begin) depth++
      if (end) depth--
      if (depth === 0) {
        blocks.push(current)
        current = null
      }
      continue
    }
    if (/^(BEGIN|END):VCALENDAR/i.test(line) || /^[A-Z-]+[;:]/i.test(line)) shell.push(line)
  }
  // A block that never closed (it swallowed the rest of the body) is a lost event too.
  const unterminated = current?.kind === 'VEVENT' ? 1 : 0
  const head = shell.filter((l) => !/^END:VCALENDAR/i.test(l))
  if (!head.some((l) => /^BEGIN:VCALENDAR/i.test(l))) throw new IcsError('invalid_feed', 'the address returned no calendar data')
  let calendar: IcalComponent
  try {
    calendar = rootOf(ICAL.parse([...head, 'END:VCALENDAR'].join('\r\n')))
  } catch {
    calendar = new ICAL.Component(['vcalendar', [], []])
  }
  // Each block is parsed alone: ical.js reads a TZID only when a time is read, by then
  // under this calendar with its zones. (Parsing every zone again with each VEVENT made
  // this path cost events × zones.)
  let skipped = unterminated
  for (const block of [...blocks.filter((b) => b.kind === 'VTIMEZONE'), ...blocks.filter((b) => b.kind === 'VEVENT')]) {
    try {
      const comp = rootOf(ICAL.parse(['BEGIN:VCALENDAR', 'VERSION:2.0', ...block.lines, 'END:VCALENDAR'].join('\r\n')))
      for (const sub of comp.getAllSubcomponents(block.kind.toLowerCase())) calendar.addSubcomponent(sub)
    } catch {
      if (block.kind === 'VEVENT') skipped++
    }
  }
  return { calendar, skipped }
}

// ---------- mapping ----------

function textOf(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t ? t : null
}

function wallOf(t: IcalTime): WallTime {
  return { year: t.year, month: t.month, day: t.day, hour: t.isDate ? 0 : t.hour, minute: t.isDate ? 0 : t.minute, second: t.isDate ? 0 : t.second }
}

function tzidOf(prop: IcalProperty | null): string | null {
  const p = prop?.getParameter('tzid')
  return typeof p === 'string' ? p : Array.isArray(p) && typeof p[0] === 'string' ? p[0] : null
}

interface Instant {
  ms: number
  /** The wall-clock offset to show the time at (ms east of UTC). */
  offsetMs: number
  /** The IANA zone, when known. */
  zone: string | null
}

/**
 * Time zones, in order: a `Z` suffix → UTC; an IANA TZID; a Windows zone name
 * (CLDR); the feed's VTIMEZONE rules; else floating → the local zone.
 */
function instantOf(t: IcalTime, tzid: string | null): Instant {
  const wall = wallOf(t)
  const zoneId = t.zone?.tzid
  if (zoneId === 'UTC' || zoneId === 'Z' || zoneId === 'GMT') return { ms: wallAsUtcMs(wall), offsetMs: 0, zone: null }
  const iana = ianaZoneFor(tzid)
  if (iana) {
    const ms = zonedWallToUtcMs(wall, iana)
    return { ms, offsetMs: wallAsUtcMs(wall) - ms, zone: iana }
  }
  if (t.zone && zoneId && zoneId !== 'floating') {
    const ms = t.toUnixTime() * 1000
    return { ms, offsetMs: wallAsUtcMs(wall) - ms, zone: null }
  }
  const ms = localWallToUtcMs(wall)
  return { ms, offsetMs: wallAsUtcMs(wall) - ms, zone: null }
}

function dateKey(t: IcalTime): string {
  return `${t.year}${String(t.month).padStart(2, '0')}${String(t.day).padStart(2, '0')}`
}

/** `mailto:` → address. */
function addressOf(v: unknown): string | null {
  const s = textOf(v)
  if (!s) return null
  const a = s.replace(/^mailto:/i, '').trim()
  return a.includes('@') ? a : null
}

function paramOf(prop: IcalProperty, name: string): string | null {
  const p = prop.getParameter(name)
  const v = typeof p === 'string' ? p : Array.isArray(p) && typeof p[0] === 'string' ? p[0] : null
  return v ? v.trim() : null
}

const PARTSTAT: Record<string, string> = {
  'NEEDS-ACTION': 'needsAction',
  ACCEPTED: 'accepted',
  DECLINED: 'declined',
  TENTATIVE: 'tentative'
}

const VISIBILITY: Record<string, string> = { PUBLIC: 'public', PRIVATE: 'private', CONFIDENTIAL: 'confidential' }

/** The text of an HTML description: tags dropped, links kept as "text (url)". */
function htmlToText(html: string): string {
  return html
    .replace(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, label: string) => {
      const text = label.replace(/<[^>]+>/g, '').trim()
      return text && !text.includes(href) ? `${text} (${href})` : href
    })
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/gi, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * A series start moved forward by whole periods (× INTERVAL) to before `beforeMs`, so the
 * expansion walks the window and not the years since DTSTART. Moving by whole periods
 * keeps the rule's phase, so the instances from there on are the same. Only for rules
 * whose instances repeat exactly with their period:
 * - one RRULE, without COUNT (counted from the real start) or BYSETPOS;
 * - SECONDLY to WEEKLY; MONTHLY and YEARLY only from days 1–28, which every month has.
 *
 * Else null: the walk starts at DTSTART, bounded by the feed budget. The moved start may
 * not be an instance itself, but it lies before the window, so it is never emitted.
 */
function fastForward(master: IcalComponent, dtstart: IcalTime, beforeMs: number): IcalTime | null {
  const rules = master.getAllProperties('rrule')
  if (rules.length !== 1) return null
  const recur = rules[0]?.getFirstValue() as IcalRecur | null
  if (!recur || recur.count || recur.parts?.['BYSETPOS']) return null
  const interval = Math.max(1, recur.interval || 1)
  const startWall = wallAsUtcMs(wallOf(dtstart))
  const targetWall = beforeMs - WALL_SLACK_MS
  if (!(targetWall > startWall)) return null
  const moved = dtstart.clone()
  const unit = recur.freq ? PERIOD_S[recur.freq] : undefined
  if (unit) {
    const periodS = unit * interval
    const periods = Math.floor((targetWall - startWall) / 1000 / periodS) - 1
    if (periods <= 0) return null
    const seconds = periods * periodS
    moved.adjust(Math.floor(seconds / 86_400), 0, 0, seconds % 86_400)
    return moved
  }
  if ((recur.freq === 'MONTHLY' || recur.freq === 'YEARLY') && dtstart.day <= 28) {
    const target = new Date(targetWall)
    const months = (target.getUTCFullYear() - dtstart.year) * 12 + (target.getUTCMonth() + 1 - dtstart.month)
    const step = recur.freq === 'MONTHLY' ? interval : 12 * interval
    const periods = Math.floor(months / step) - 1
    if (periods <= 0) return null
    const total = dtstart.year * 12 + (dtstart.month - 1) + periods * step
    moved.year = Math.floor(total / 12)
    moved.month = (total % 12) + 1
    return moved
  }
  return null
}

const MONTH_DAYS = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

/**
 * Rules on which ical.js's own next() never returns, so no step cap can stop them: the
 * series is skipped as unsupported instead of the whole feed running out
 * of its time budget.
 * - BYHOUR, BYMINUTE or BYSECOND on an all-day start (RFC 5545 forbids them there);
 * - a daily-or-finer rule whose BYMONTHDAY fits none of its months (February 30).
 */
function neverEnds(recur: IcalRecur, dtstart: IcalTime): boolean {
  const parts = (recur.parts ?? {}) as Record<string, unknown[] | undefined>
  if (dtstart.isDate && (parts['BYHOUR'] || parts['BYMINUTE'] || parts['BYSECOND'])) return true
  const days = parts['BYMONTHDAY']?.map(Number).filter((d) => Number.isInteger(d) && d !== 0)
  if (!days?.length || !recur.freq || !(recur.freq in PERIOD_S)) return false
  const months = parts['BYMONTH']?.map(Number).filter((m) => m >= 1 && m <= 12) ?? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]
  return !months.some((m) => days.some((d) => Math.abs(d) <= (MONTH_DAYS[m - 1] ?? 31)))
}

interface Series {
  uid: string
  master: IcalComponent | null
  /** Overrides by the instant of their RECURRENCE-ID (ms), or `d:<date>` for a DATE id. */
  overrides: Map<string, IcalComponent>
}

class FeedMapper {
  skipped = 0
  private series = new Map<string, Series>()
  /** Recurrence steps so far, against FEED_ITERATION_BUDGET. */
  private iterations = 0

  constructor(
    private readonly opts: ParseOptions,
    private readonly warnings: ParseWarning[]
  ) {}

  add(vevent: IcalComponent): void {
    try {
      const uid = textOf(vevent.getFirstPropertyValue('uid')) ?? this.syntheticUid(vevent)
      const s = this.series.get(uid) ?? { uid, master: null, overrides: new Map() }
      this.series.set(uid, s)
      const rid = vevent.getFirstProperty('recurrence-id')
      if (rid) {
        const t = rid.getFirstValue() as IcalTime | null
        if (!t) throw new Error('bad RECURRENCE-ID')
        s.overrides.set(t.isDate ? `d:${dateKey(t)}` : String(instantOf(t, tzidOf(rid)).ms), vevent)
      } else if (!s.master) {
        s.master = vevent
      }
    } catch {
      this.skipped++
    }
  }

  /** A stable id for a VEVENT without UID: the hash of its start and title. */
  private syntheticUid(vevent: IcalComponent): string {
    const basis = `${String(vevent.getFirstProperty('dtstart')?.toICALString() ?? '')}\n${String(vevent.getFirstPropertyValue('summary') ?? '')}`
    return `notula-${createHash('sha256').update(basis).digest('hex').slice(0, 32)}`
  }

  expand(): CalendarEvent[] {
    const out: CalendarEvent[] = []
    for (const s of this.series.values()) {
      try {
        out.push(...this.expandSeries(s))
      } catch (err) {
        // Over the feed budget: the whole refresh fails, so nothing is deleted.
        if (err instanceof IcsError) throw err
        this.skipped++
        // The parser's message may quote feed content: quoted values are dropped.
        this.warnings.push({
          event: 'calendar:ics-series-skipped',
          data: { reason: err instanceof Error ? err.message.replace(/"[^"]*"/g, '"…"').slice(0, 120) : 'error' }
        })
      }
    }
    return out.sort((a, b) => Date.parse(String(a.start?.dateTime ?? '')) - Date.parse(String(b.start?.dateTime ?? '')))
  }

  private expandSeries(s: Series): CalendarEvent[] {
    const { fromMs, toMs } = this.opts.window
    const out: CalendarEvent[] = []
    const recurring = !!s.master && (s.master.hasProperty('rrule') || s.master.hasProperty('rdate'))
    const isSeries = recurring || s.overrides.size > 0
    const seriesId = isSeries ? `ics:${this.opts.sourceId}:${s.uid}` : null

    if (s.master) {
      const dtstartProp = s.master.getFirstProperty('dtstart')
      const dtstart = dtstartProp?.getFirstValue() as IcalTime | null | undefined
      if (dtstart) {
        const tzid = tzidOf(dtstartProp ?? null)
        const durationMs = this.durationMs(s.master, dtstart, tzid)
        if (!recurring) {
          const start = instantOf(dtstart, tzid)
          const replaced = s.overrides.has(String(start.ms)) || s.overrides.has(`d:${dateKey(dtstart)}`)
          if (!replaced && start.ms < toMs && start.ms + durationMs > fromMs) out.push(this.map(s.master, s.uid, seriesId, start, durationMs, dtstart, start.ms))
        } else {
          out.push(...this.expandMaster(s, dtstart, tzid, durationMs, seriesId))
        }
      }
    }

    for (const [key, vevent] of s.overrides) {
      const status = textOf(vevent.getFirstPropertyValue('status'))?.toUpperCase()
      if (status === 'CANCELLED') continue
      const prop = vevent.getFirstProperty('dtstart')
      const dt = prop?.getFirstValue() as IcalTime | null | undefined
      if (!dt) continue
      const tzid = tzidOf(prop ?? null)
      const start = instantOf(dt, tzid)
      const durationMs = this.durationMs(vevent, dt, tzid)
      if (!(start.ms < toMs && start.ms + durationMs > fromMs)) continue
      const rid = vevent.getFirstProperty('recurrence-id')?.getFirstValue() as IcalTime
      const originalMs = key.startsWith('d:') ? null : Number(key)
      out.push(this.map(vevent, s.uid, seriesId, start, durationMs, rid, originalMs))
    }
    return out
  }

  private expandMaster(s: Series, dtstart: IcalTime, tzid: string | null, durationMs: number, seriesId: string | null): CalendarEvent[] {
    const master = s.master as IcalComponent
    const { fromMs, toMs } = this.opts.window
    for (const prop of master.getAllProperties('rrule')) {
      const recur = prop.getFirstValue() as IcalRecur | null
      if (recur && neverEnds(recur, dtstart)) throw new Error('unsupported rule: it has no instances')
    }
    const floatingIana = (!dtstart.zone || dtstart.zone.tzid === 'floating') && !dtstart.isDate ? ianaZoneFor(tzid) : null
    if (floatingIana) this.alignUntil(master, floatingIana)

    // EXDATE, matched on the original start (DATE or DATE-TIME, with its TZID).
    const exInstants = new Set<number>()
    const exDates = new Set<string>()
    for (const prop of master.getAllProperties('exdate')) {
      const exTz = tzidOf(prop)
      for (const v of prop.getValues() as IcalTime[]) {
        if (!v) continue
        if (v.isDate) exDates.add(dateKey(v))
        else exInstants.add(instantOf(v, exTz ?? tzid).ms)
      }
    }

    // The walk starts just before the window where the rule allows it, not at DTSTART.
    const it = new ICAL.Event(master).iterator(fastForward(master, dtstart, fromMs - durationMs) ?? undefined)
    const out: CalendarEvent[] = []
    let iterations = 0
    for (let t = it.next(); t; t = it.next()) {
      if (++this.iterations > FEED_ITERATION_BUDGET) {
        throw new IcsError('invalid_feed', 'the calendar has too many repeating events to read')
      }
      if (++iterations > SERIES_ITERATION_CAP) {
        this.warnings.push({ event: 'calendar:ics-series-truncated', data: { reason: 'iterations' } })
        break
      }
      // The wall time alone settles most steps, without the zone arithmetic.
      const wall = wallAsUtcMs(wallOf(t))
      if (wall - WALL_SLACK_MS >= toMs) break
      if (wall + WALL_SLACK_MS + durationMs <= fromMs) continue
      const start = instantOf(t, tzid)
      if (start.ms >= toMs) break
      if (start.ms + durationMs <= fromMs) continue
      if (exInstants.has(start.ms) || exDates.has(dateKey(t))) continue
      if (s.overrides.has(String(start.ms)) || s.overrides.has(`d:${dateKey(t)}`)) continue
      out.push(this.map(master, s.uid, seriesId, start, durationMs, t, start.ms))
      if (out.length >= CALENDAR_SYNC.maxInstancesPerSeries) {
        this.warnings.push({ event: 'calendar:ics-series-truncated', data: { reason: 'instances', max: CALENDAR_SYNC.maxInstancesPerSeries } })
        break
      }
    }
    return out
  }

  /** A floating DTSTART with an IANA (or Windows) TZID: compare UNTIL in that zone's wall time. */
  private alignUntil(master: IcalComponent, zone: string): void {
    for (const prop of master.getAllProperties('rrule')) {
      const recur = prop.getFirstValue() as IcalRecur | null
      const until = recur?.until
      if (!recur || !until || until.isDate || until.zone?.tzid !== 'UTC') continue
      const w = utcMsToZonedWall(until.toUnixTime() * 1000, zone)
      recur.until = new ICAL.Time({ ...w, isDate: false }, ICAL.Timezone.localTimezone)
    }
  }

  private durationMs(vevent: IcalComponent, dtstart: IcalTime, tzid: string | null): number {
    const start = instantOf(dtstart, tzid).ms
    const endProp = vevent.getFirstProperty('dtend')
    const end = endProp?.getFirstValue() as IcalTime | null | undefined
    if (end) return Math.max(0, instantOf(end, tzidOf(endProp ?? null) ?? tzid).ms - start)
    const duration = vevent.getFirstPropertyValue('duration') as InstanceType<typeof ICAL.Duration> | null
    if (duration) return Math.max(0, duration.toSeconds() * 1000)
    return dtstart.isDate ? 86_400_000 : 0
  }

  private self(address: string | null): boolean {
    return !!address && this.opts.myEmails.has(address.toLowerCase())
  }

  private map(
    vevent: IcalComponent,
    uid: string,
    seriesId: string | null,
    start: Instant,
    durationMs: number,
    original: IcalTime,
    originalMs: number | null
  ): CalendarEvent {
    const { sourceId, calendarId } = this.opts
    const dtstart = vevent.getFirstPropertyValue('dtstart') as IcalTime | null
    const allDay = !!dtstart?.isDate
    // An instance of a series is keyed by its original start. A single event keeps
    // its UID alone, so moving it upstream keeps its id: its reminder is rescheduled and
    // its notes keep following it, as a Google event id would.
    const key = originalMs !== null && !original.isDate ? utcBasic(originalMs) : dateKey(original)

    const ev: CalendarEvent = {
      kind: 'calendar#event',
      id: seriesId ? `ics:${sourceId}:${uid}:${key}` : `ics:${sourceId}:${uid}`,
      iCalUID: uid,
      calendarId,
      primaryCalendar: true
    }
    const summary = textOf(vevent.getFirstPropertyValue('summary'))
    if (summary) ev.summary = summary
    let description = textOf(vevent.getFirstPropertyValue('description'))
    if (!description) {
      const alt = vevent.getAllProperties('x-alt-desc').find((p) => (paramOf(p, 'fmttype') ?? '').toLowerCase() === 'text/html')
      const html = textOf(alt?.getFirstValue())
      if (html) description = htmlToText(html) || null
    }
    if (description) ev['description'] = description
    const location = textOf(vevent.getFirstPropertyValue('location'))
    if (location) ev['location'] = location
    const url = textOf(vevent.getFirstPropertyValue('url'))
    if (url && /^https?:\/\//i.test(url)) ev['htmlLink'] = url

    if (allDay && dtstart) {
      const endDate = new Date(Date.UTC(dtstart.year, dtstart.month - 1, dtstart.day) + Math.max(durationMs, 86_400_000))
      ev.start = { date: `${dtstart.year}-${String(dtstart.month).padStart(2, '0')}-${String(dtstart.day).padStart(2, '0')}` }
      ev.end = { date: endDate.toISOString().slice(0, 10) }
    } else {
      ev.start = { dateTime: isoWithOffset(start.ms, start.offsetMs), ...(start.zone ? { timeZone: start.zone } : {}) }
      ev.end = { dateTime: isoWithOffset(start.ms + durationMs, start.offsetMs), ...(start.zone ? { timeZone: start.zone } : {}) }
    }

    const status = textOf(vevent.getFirstPropertyValue('status'))?.toUpperCase()
    ev['status'] = status === 'CANCELLED' ? 'cancelled' : status === 'TENTATIVE' ? 'tentative' : 'confirmed'

    const orgProp = vevent.getFirstProperty('organizer')
    const orgEmail = orgProp ? addressOf(orgProp.getFirstValue()) : null
    if (orgProp && orgEmail) {
      const cn = paramOf(orgProp, 'cn')
      ev['organizer'] = { email: orgEmail, ...(cn ? { displayName: cn } : {}), ...(this.self(orgEmail) ? { self: true } : {}) }
    }
    const attendees: CalendarAttendee[] = []
    for (const prop of vevent.getAllProperties('attendee')) {
      const email = addressOf(prop.getFirstValue())
      if (!email) continue
      const cn = paramOf(prop, 'cn')
      const partstat = (paramOf(prop, 'partstat') ?? '').toUpperCase()
      const cutype = (paramOf(prop, 'cutype') ?? '').toUpperCase()
      const role = (paramOf(prop, 'role') ?? '').toUpperCase()
      attendees.push({
        email,
        ...(cn ? { displayName: cn } : {}),
        responseStatus: PARTSTAT[partstat] ?? 'needsAction',
        ...(cutype === 'RESOURCE' || cutype === 'ROOM' ? { resource: true } : {}),
        ...(role === 'OPT-PARTICIPANT' ? { optional: true } : {}),
        ...(this.self(email) ? { self: true } : {}),
        ...(orgEmail && orgEmail.toLowerCase() === email.toLowerCase() ? { organizer: true } : {})
      })
    }
    if (attendees.length) ev.attendees = attendees

    if (seriesId) ev['recurringEventId'] = seriesId
    const stamp = (name: string): string | null => {
      const t = vevent.getFirstPropertyValue(name) as IcalTime | null
      if (!t || typeof t.toUnixTime !== 'function') return null
      return new Date(instantOf(t, tzidOf(vevent.getFirstProperty(name))).ms).toISOString()
    }
    const created = stamp('created')
    const updated = stamp('last-modified')
    if (created) ev['created'] = created
    if (updated) ev['updated'] = updated
    const sequence = vevent.getFirstPropertyValue('sequence')
    ev['etag'] = `${typeof sequence === 'number' ? sequence : 0}-${updated ?? ''}`
    const klass = textOf(vevent.getFirstPropertyValue('class'))?.toUpperCase()
    if (klass && VISIBILITY[klass]) ev['visibility'] = VISIBILITY[klass]
    const conference = textOf(vevent.getFirstPropertyValue('x-google-conference'))
    if (conference && /^https?:\/\//i.test(conference)) {
      ev['conferenceData'] = { entryPoints: [{ entryPointType: 'video', uri: conference }] }
    }
    return ev
  }
}
