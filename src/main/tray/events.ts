// SPDX-License-Identifier: Apache-2.0
// The tray's calendar logic: which events show, how they group,
// which one is highlighted, and how rows and the macOS menu-bar title read. Pure:
// every function takes `now`. Join links come from the calendar's `detectConferenceLink`.

import { detectConferenceLink, type ConferenceLink } from '@shared/lib/conference'
import type { CalendarEvent } from '@shared/types/notes'

export type JoinProvider = 'google_meet' | 'zoom' | 'teams'

export interface TrayEvent {
  event: CalendarEvent
  start: Date
  end: Date
  title: string | null
  location: string | null
  joinUrl: string | null
  provider: JoinProvider | null
  hasOtherAttendees: boolean
  ownDomainOrganizer: boolean
  primaryCalendar: boolean
}

export interface TrayGroups {
  highlighted: { event: TrayEvent; label: string; joinable: boolean } | null
  today: TrayEvent[]
  tomorrow: TrayEvent[]
}

/** Client defaults: Today's limit before Tomorrow hides, and locations on. */
export const TODAY_EVENTS_LIMIT = 8
export const SHOW_LOCATIONS = true
const UPCOMING_WINS_MS = 5 * 60_000
const JOINABLE_MS = 10 * 60_000
const LABEL_MAX = 60
const SUBLABEL_MAX = 50
const SUBLABEL_MAX_WITH_ICON = 42

const MINUTE = 60_000
const DAY = 24 * 3_600_000

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n)
}

function str(v: unknown): string | null {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null
}

function domainOf(email: string | null | undefined): string | null {
  const at = email?.lastIndexOf('@') ?? -1
  return at > 0 ? email!.slice(at + 1).toLowerCase() : null
}

/** The tray's join icons exist for these three; other providers join without an icon. */
function providerOf(link: ConferenceLink | null): JoinProvider | null {
  if (link?.type === 'zoom') return 'zoom'
  if (link?.type === 'meet') return 'google_meet'
  if (link?.type === 'teams') return 'teams'
  return null
}

function timeOf(t: CalendarEvent['start']): Date | null {
  const v = t?.dateTime
  if (!v) return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Events with a start and end time, as tray rows. All-day events (date only) drop out. */
export function toTrayEvents(events: readonly CalendarEvent[], ownEmail: string | null): TrayEvent[] {
  const out: TrayEvent[] = []
  for (const ev of events) {
    const start = timeOf(ev.start)
    const end = timeOf(ev.end)
    if (!start || !end) continue
    const self = ev.attendees?.find((a) => a.self)?.email ?? ownEmail
    const ownDomain = domainOf(self)
    const organizer = ev['organizer'] as { email?: unknown } | undefined
    const join = detectConferenceLink(ev, self ?? null)
    out.push({
      event: ev,
      start,
      end,
      title: str(ev.summary),
      location: str(ev['location']),
      joinUrl: join?.url ?? null,
      provider: providerOf(join),
      hasOtherAttendees: (ev.attendees ?? []).some((a) => !a.self && !a.resource && a.email && a.email !== self),
      ownDomainOrganizer: !!ownDomain && domainOf(typeof organizer?.email === 'string' ? organizer.email : null) === ownDomain,
      primaryCalendar: ev['primary'] === true || (organizer as { self?: unknown } | undefined)?.self === true
    })
  }
  return out
}

/** Overlapping today or tomorrow, not ended; optionally only meetings with others. */
export function filterEvents(events: readonly TrayEvent[], now: Date, onlyWithOthers: boolean): TrayEvent[] {
  const from = startOfDay(now)
  const to = addDays(from, 2)
  return events
    .filter((e) => e.start < to && e.end > from && e.end > now)
    .filter((e) => !onlyWithOthers || e.hasOtherAttendees || e.joinUrl !== null)
    .sort((a, b) => a.start.getTime() - b.start.getTime() || Number(b.ownDomainOrganizer) - Number(a.ownDomainOrganizer))
}

/** Whole minutes, at least 1: `Xm`, `Xh` or `Xh Ym`. */
export function formatDuration(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / MINUTE))
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h === 0) return `${m}m`
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

function tieBreak(a: TrayEvent, b: TrayEvent): number {
  return (
    Number(b.ownDomainOrganizer) - Number(a.ownDomainOrganizer) ||
    Number(b.hasOtherAttendees) - Number(a.hasOtherAttendees) ||
    Number(b.primaryCalendar) - Number(a.primaryCalendar)
  )
}

/**
 * Timed events starting today. The next upcoming one wins within 5 minutes;
 * otherwise the latest-starting ongoing one; otherwise the next upcoming one.
 */
export function highlightedEvent(events: readonly TrayEvent[], now: Date): TrayEvent | null {
  const from = startOfDay(now)
  const to = addDays(from, 1)
  const today = events.filter((e) => e.start >= from && e.start < to)
  const upcoming = today
    .filter((e) => e.start > now)
    .sort((a, b) => a.start.getTime() - b.start.getTime() || tieBreak(a, b))
  const ongoing = today
    .filter((e) => e.start <= now && e.end > now)
    .sort((a, b) => b.start.getTime() - a.start.getTime() || tieBreak(a, b))
  const next = upcoming[0] ?? null
  if (next && next.start.getTime() - now.getTime() <= UPCOMING_WINS_MS) return next
  return ongoing[0] ?? next
}

/** `Now` in the first minute, `Ends in <d>` while ongoing, `Starts in <d>` before. */
export function statusLabel(e: TrayEvent, now: Date): string {
  const t = now.getTime()
  if (e.start.getTime() > t) return `Starts in ${formatDuration(e.start.getTime() - t)}`
  if (t - e.start.getTime() < MINUTE) return 'Now'
  return `Ends in ${formatDuration(e.end.getTime() - t)}`
}

/** The join icon shows while ongoing or within 10 minutes of the start, with a link. */
export function isJoinable(e: TrayEvent, now: Date): boolean {
  return e.joinUrl !== null && e.start.getTime() - now.getTime() <= JOINABLE_MS && e.end > now
}

/**
 * The highlighted event alone, then Today (started today or still running from
 * before), then Tomorrow. Tomorrow is dropped on Windows, and above 8 events today.
 */
export function groupEvents(events: readonly TrayEvent[], now: Date, platform: NodeJS.Platform): TrayGroups {
  const tomorrowStart = addDays(startOfDay(now), 1)
  const highlighted = highlightedEvent(events, now)
  const rest = events.filter((e) => e !== highlighted)
  const today = rest.filter((e) => e.start < tomorrowStart)
  const tomorrow = rest.filter((e) => e.start >= tomorrowStart && e.start.getTime() < tomorrowStart.getTime() + DAY)
  const dropTomorrow = platform === 'win32' || today.length > TODAY_EVENTS_LIMIT
  return {
    highlighted: highlighted
      ? { event: highlighted, label: statusLabel(highlighted, now), joinable: isJoinable(highlighted, now) }
      : null,
    today,
    tomorrow: dropTomorrow ? [] : tomorrow
  }
}

function cut(text: string, max: number, ellipsis = '...'): string {
  return text.length > max ? `${text.slice(0, max - ellipsis.length)}${ellipsis}` : text
}

/** The title or "(No title)", at most 60 characters (57 + "..."). */
export function rowLabel(e: TrayEvent): string {
  return cut(e.title ?? '(No title)', LABEL_MAX)
}

/** Start and end in the app locale, then " · " and the location; 50 (42 with an icon). */
export function rowSublabel(e: TrayEvent, locale: string, withIcon: boolean): string {
  let fmt: Intl.DateTimeFormat
  try {
    fmt = new Intl.DateTimeFormat(locale, { hour: 'numeric', minute: '2-digit' })
  } catch {
    fmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' })
  }
  let text = `${fmt.format(e.start)} – ${fmt.format(e.end)}`
  if (SHOW_LOCATIONS && e.location) text += ` · ${e.location}`
  return cut(text, withIcon ? SUBLABEL_MAX_WITH_ICON : SUBLABEL_MAX)
}

const THIN = ' '

/**
 * macOS: `<title> • now` in the first minute, `<title> • <d> left` while ongoing,
 * `<title> • in <d>` before; the title is cut to 15 characters (8 on a lone built-in
 * display). Blank when nothing qualifies.
 */
export function menuBarTitle(e: TrayEvent | null, now: Date, shortTitles: boolean): string {
  if (!e) return ''
  const t = now.getTime()
  let status: string
  if (e.start.getTime() > t) status = `in ${formatDuration(e.start.getTime() - t)}`
  else if (t - e.start.getTime() < MINUTE) status = 'now'
  else status = `${formatDuration(e.end.getTime() - t)} left`
  const max = shortTitles ? 8 : 15
  const title = e.title ?? '(No title)'
  const short = title.length > max ? `${title.slice(0, max).trimEnd()}..` : title
  return `${short}${THIN}•${THIN}${status}`
}
