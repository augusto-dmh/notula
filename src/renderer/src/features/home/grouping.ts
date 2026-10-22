// SPDX-License-Identifier: Apache-2.0
// Day grouping for the home list: the local calendar day
// of the event start (dateTime, or an all-day date), else created_at. Everything
// from tomorrow on is one "Upcoming" group.

import type { CalendarEvent, NoteListItem } from '@shared/types/notes'

export type HomeRow =
  | { kind: 'header'; key: string; label: string }
  | { kind: 'note'; key: string; item: NoteListItem; time: Date }

const DAY_MS = 86_400_000

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** An all-day `date` (YYYY-MM-DD) is a local day, not UTC midnight. */
function localDate(date: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null
}

export function eventStart(event: CalendarEvent | null | undefined): Date | null {
  const start = event?.start
  if (start?.dateTime) {
    const d = new Date(start.dateTime)
    if (!Number.isNaN(d.getTime())) return d
  }
  if (start?.date) return localDate(start.date)
  return null
}

/** The time a note is listed under. */
export function noteTime(item: Pick<NoteListItem, 'linked_event' | 'sort_epoch' | 'created_at'>): Date {
  const fromEvent = eventStart(item.linked_event)
  if (fromEvent) return fromEvent
  if (Number.isFinite(item.sort_epoch) && item.sort_epoch > 0) {
    return new Date(item.sort_epoch * 1000)
  }
  return new Date(item.created_at)
}

export function isAllDay(item: Pick<NoteListItem, 'linked_event'>): boolean {
  const start = item.linked_event?.start
  return !!start?.date && !start.dateTime
}

export function dayLabel(day: Date, now: Date = new Date()): string {
  const today = startOfDay(now).getTime()
  const d = startOfDay(day).getTime()
  if (d >= today + DAY_MS) return 'Upcoming'
  if (d === today) return 'Today'
  if (d === today - DAY_MS) return 'Yesterday'
  return day.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    ...(day.getFullYear() !== now.getFullYear() ? { year: 'numeric' } : {})
  })
}

/** Header and note rows, in list order (the store already sorts by display time, newest first). */
export function groupRows(items: readonly NoteListItem[], now: Date = new Date()): HomeRow[] {
  const rows: HomeRow[] = []
  let current: string | null = null
  for (const item of items) {
    const time = noteTime(item)
    const label = dayLabel(time, now)
    if (label !== current) {
      current = label
      rows.push({ kind: 'header', key: `h:${label}:${rows.length}`, label })
    }
    rows.push({ kind: 'note', key: item.id, item, time })
  }
  return rows
}

export function formatTime(d: Date): string {
  return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
}
