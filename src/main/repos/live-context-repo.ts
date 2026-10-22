// SPDX-License-Identifier: Apache-2.0
// Free slots: the storage-worker side of their StorageApi group. Worker-safe: no Electron imports.
//
// Busy = deduped `calendar_events` the user has not declined, not cancelled and not marked free
// (`transparency: transparent`). The slot is the first gap of the requested length at or after
// `from`, before `to`, on a weekday, inside the work hours of the local day (`tzOffsetMin` is the
// local offset east of UTC). Starts are rounded up to the next quarter hour.

import type { IsoTime } from '@shared/types/common'
import type { CalendarEvent } from '@shared/types/notes'
import { listEventsInRange } from '../storage/calendar-repo'
import { invalid, type StoreCtx } from '../storage/store'

const MIN_MS = 60_000
const DAY_MS = 86_400_000
const STEP_MS = 15 * MIN_MS

function hm(v: string, what: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(typeof v === 'string' ? v : '')
  if (!m) throw invalid(`${what} must be HH:MM`)
  return (Number(m[1]) * 60 + Number(m[2])) * MIN_MS
}

function timeOf(t: CalendarEvent['start']): number | null {
  const v = t?.dateTime ?? (t?.date ? `${t.date}T00:00:00` : undefined)
  const ms = v ? Date.parse(v) : NaN
  return Number.isNaN(ms) ? null : ms
}

function isBusy(ev: CalendarEvent, mine: ReadonlySet<string>): boolean {
  if (ev['status'] === 'cancelled' || ev['transparency'] === 'transparent') return false
  const self = (ev.attendees ?? []).find((a) => a && (a.self === true || mine.has(String(a.email ?? '').toLowerCase())))
  return self?.responseStatus !== 'declined'
}

export function findFreeSlot(
  s: StoreCtx,
  q: { from: IsoTime; to: IsoTime; durationMin: number; workHours: { start: string; end: string }; tzOffsetMin: number; myEmails: string[] }
): { start: IsoTime; end: IsoTime } | null {
  const from = Date.parse(q?.from)
  const to = Date.parse(q?.to)
  if (Number.isNaN(from) || Number.isNaN(to) || to <= from) throw invalid('from and to must be valid times, from first')
  const duration = Math.round(Number(q.durationMin)) * MIN_MS
  if (!Number.isFinite(duration) || duration <= 0) throw invalid('durationMin must be positive')
  const dayStart = hm(q.workHours?.start, 'workHours.start')
  const dayEnd = hm(q.workHours?.end, 'workHours.end')
  if (dayEnd - dayStart < duration) return null
  const offset = Math.round(Number(q.tzOffsetMin) || 0) * MIN_MS
  const mine = new Set((Array.isArray(q.myEmails) ? q.myEmails : []).map((e) => String(e).toLowerCase()))

  const busy = listEventsInRange(s, { from: new Date(from).toISOString(), to: new Date(to).toISOString() })
    .filter((ev) => isBusy(ev, mine))
    .map((ev) => ({ start: timeOf(ev.start), end: timeOf(ev.end) }))
    .filter((b): b is { start: number; end: number } => b.start !== null && b.end !== null && b.end > b.start)
    .sort((a, b) => a.start - b.start)

  // Walk local days (shifted clock: local wall time as if UTC).
  for (let localDay = Math.floor((from + offset) / DAY_MS) * DAY_MS; localDay - offset < to; localDay += DAY_MS) {
    const weekday = new Date(localDay).getUTCDay()
    if (weekday === 0 || weekday === 6) continue
    const open = localDay + dayStart - offset
    const close = localDay + dayEnd - offset
    let cursor = Math.max(open, from)
    cursor = Math.ceil(cursor / STEP_MS) * STEP_MS
    const limit = Math.min(close, to)
    for (const b of busy) {
      if (cursor + duration > limit) break
      if (b.end <= cursor) continue
      if (b.start >= cursor + duration) break
      cursor = Math.ceil(b.end / STEP_MS) * STEP_MS
    }
    if (cursor + duration <= limit) return { start: new Date(cursor).toISOString(), end: new Date(cursor + duration).toISOString() }
  }
  return null
}
