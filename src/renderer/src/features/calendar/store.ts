// SPDX-License-Identifier: Apache-2.0
// Renderer state for calendar and people: a preferences mirror, the
// sources and calendars (re-read on `calendar:changed`), and small formatting helpers.

import { useEffect, useState, useSyncExternalStore } from 'react'
import type { CalendarInfo, CalendarSourcesState } from '@shared/types/calendar'
import type { CalendarEvent } from '@shared/types/notes'
import type { Settings, SettingsPatch } from '@shared/types/settings'

// ---------- preferences ----------

let prefs: Settings | null = null
let prefsStarted = false
const prefListeners = new Set<() => void>()

function emitPrefs(): void {
  for (const l of prefListeners) l()
}

function startPrefs(): void {
  if (prefsStarted) return
  prefsStarted = true
  window.notula.prefs.onChanged(({ settings }) => {
    prefs = settings
    emitPrefs()
  })
  void window.notula.prefs
    .get()
    .then((s) => {
      prefs ??= s
      emitPrefs()
    })
    .catch(() => undefined)
}

/** The preferences, or null until the first read. */
export function usePrefs(): Settings | null {
  return useSyncExternalStore(
    (cb) => {
      startPrefs()
      prefListeners.add(cb)
      return () => prefListeners.delete(cb)
    },
    () => prefs
  )
}

/** A per-key change, shown at once; main confirms with `prefs:changed`. */
export function setPrefs(patch: SettingsPatch): void {
  if (prefs) {
    prefs = { ...prefs, ...patch }
    emitPrefs()
  }
  window.notula.prefs.set(patch)
}

// ---------- sources and calendars ----------

export interface CalendarData {
  state: CalendarSourcesState | null
  calendars: CalendarInfo[]
  error: string | null
  reload(): void
}

/** Sources, client flags and calendars; re-read on `calendar:changed`. */
export function useCalendarData(): CalendarData {
  const [state, setState] = useState<CalendarSourcesState | null>(null)
  const [calendars, setCalendars] = useState<CalendarInfo[]>([])
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  useEffect(() => {
    let alive = true
    Promise.all([window.notula.calendar.sources(), window.notula.calendar.calendars()])
      .then(([s, c]) => {
        if (!alive) return
        setState(s)
        setCalendars(c)
        setError(null)
      })
      .catch(() => alive && setError('Calendar settings could not be loaded.'))
    return () => {
      alive = false
    }
  }, [tick])
  useEffect(() => window.notula.calendar.onChanged(() => setTick((t) => t + 1)), [])
  return { state, calendars, error, reload: () => setTick((t) => t + 1) }
}

/** "My emails" as the renderer knows them: the profile email and each source's address. */
export function myEmailsFrom(settings: Settings | null, state: CalendarSourcesState | null): string[] {
  const out = new Set<string>()
  const add = (e: string | null | undefined): void => {
    const v = e?.trim().toLowerCase()
    if (v) out.add(v)
  }
  add(settings?.['profile.email'])
  for (const s of state?.sources ?? []) {
    add(s.accountEmail)
    add(s.myEmail)
  }
  return [...out]
}

// ---------- time ----------

export function eventStartMs(ev: CalendarEvent | null | undefined): number | null {
  const v = ev?.start?.dateTime ?? ev?.start?.date
  if (!v) return null
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? null : ms
}

export function eventEndMs(ev: CalendarEvent | null | undefined): number | null {
  const v = ev?.end?.dateTime ?? ev?.end?.date
  if (!v) return null
  const ms = Date.parse(v)
  return Number.isNaN(ms) ? null : ms
}

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' })

export function formatClock(ms: number): string {
  return timeFmt.format(new Date(ms))
}

/** "10:00 – 10:30" in the user's locale. */
export function formatRange(startMs: number, endMs: number | null): string {
  return endMs === null ? formatClock(startMs) : `${formatClock(startMs)} – ${formatClock(endMs)}`
}

/** "Synced 3 min ago". */
export function syncedAgo(iso: string | null, now = Date.now()): string {
  if (!iso) return 'Not synced yet'
  const ms = now - Date.parse(iso)
  if (!Number.isFinite(ms) || ms < 60_000) return 'Synced just now'
  const min = Math.round(ms / 60_000)
  if (min < 60) return `Synced ${min} min ago`
  const h = Math.round(min / 60)
  if (h < 24) return `Synced ${h} h ago`
  return `Synced ${new Date(Date.parse(iso)).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}`
}

/** True when the event qualifies for Start now and reminders. */
export function qualifies(ev: CalendarEvent, mine: ReadonlySet<string>): boolean {
  if (!ev.id || !ev.start?.dateTime || !ev.end?.dateTime) return false
  if (typeof ev.summary !== 'string' || !ev.summary.trim()) return false
  const attendees = Array.isArray(ev.attendees) ? ev.attendees : []
  if (!attendees.length) return false
  return !attendees.some(
    (a) => (a.self === true || (typeof a.email === 'string' && mine.has(a.email.toLowerCase()))) && a.responseStatus === 'declined'
  )
}
