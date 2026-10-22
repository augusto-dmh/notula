// SPDX-License-Identifier: Apache-2.0
// Time-zone arithmetic for ICS feeds: IANA names
// through Intl (Electron's full ICU), Windows names through the CLDR table.

import { WINDOWS_ZONES } from './windows-zones'

/** A wall-clock time: month 1–12. */
export interface WallTime {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
}

const formatters = new Map<string, Intl.DateTimeFormat | null>()

function formatter(zone: string): Intl.DateTimeFormat | null {
  let f = formatters.get(zone)
  if (f !== undefined) return f
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
  } catch {
    f = null
  }
  formatters.set(zone, f)
  return f
}

/** True for a time-zone name Intl knows (IANA names and their aliases). */
export function isIanaZone(name: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_+\-/]*$/.test(name) && formatter(name) !== null
}

/** An IANA TZID as is, a Windows zone name through the CLDR table, else null. */
export function ianaZoneFor(tzid: string | null | undefined): string | null {
  const id = tzid?.trim().replace(/^"|"$/g, '')
  if (!id) return null
  if (isIanaZone(id)) return id
  const mapped = WINDOWS_ZONES[id]
  return mapped && isIanaZone(mapped) ? mapped : null
}

const DAY_MS = 86_400_000
const MAX_CACHED_DAYS = 100_000
/** The offset at each UTC midnight, by zone and day number. */
const midnights = new Map<string, number>()

function midnightOffsetMs(zone: string, f: Intl.DateTimeFormat, day: number): number {
  const key = `${zone}\n${day}`
  let v = midnights.get(key)
  if (v === undefined) {
    if (midnights.size >= MAX_CACHED_DAYS) midnights.clear()
    v = exactOffsetMs(f, day * DAY_MS)
    midnights.set(key, v)
  }
  return v
}

/**
 * The zone's UTC offset at an instant, in ms (positive east of Greenwich). Cached per UTC
 * day: a day whose two midnights have the same offset has no transition in it, because
 * zones change at most a few times a year. Only a transition day is computed exactly.
 */
export function zoneOffsetMs(zone: string, utcMs: number): number {
  const f = formatter(zone)
  if (!f) return 0
  const day = Math.floor(utcMs / DAY_MS)
  const offset = midnightOffsetMs(zone, f, day)
  return offset === midnightOffsetMs(zone, f, day + 1) ? offset : exactOffsetMs(f, utcMs)
}

function exactOffsetMs(f: Intl.DateTimeFormat, utcMs: number): number {
  const parts: Record<string, number> = {}
  for (const p of f.formatToParts(new Date(utcMs))) if (p.type !== 'literal') parts[p.type] = Number(p.value)
  const asUtc = Date.UTC(parts['year'] ?? 1970, (parts['month'] ?? 1) - 1, parts['day'] ?? 1, parts['hour'] ?? 0, parts['minute'] ?? 0, parts['second'] ?? 0)
  return asUtc - Math.floor(utcMs / 1000) * 1000
}

export function wallAsUtcMs(w: WallTime): number {
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second)
}

/** The instant of a wall-clock time in a zone. A time skipped by DST moves forward; a repeated one takes the first. */
export function zonedWallToUtcMs(w: WallTime, zone: string): number {
  const guess = wallAsUtcMs(w)
  const first = guess - zoneOffsetMs(zone, guess)
  const second = guess - zoneOffsetMs(zone, first)
  if (first === second) return first
  // Around a transition: prefer the candidate whose wall time matches.
  const matches = (t: number): boolean => t + zoneOffsetMs(zone, t) === guess
  if (matches(Math.min(first, second))) return Math.min(first, second)
  if (matches(Math.max(first, second))) return Math.max(first, second)
  return Math.max(first, second)
}

/** A floating time: the local zone. */
export function localWallToUtcMs(w: WallTime): number {
  return new Date(w.year, w.month - 1, w.day, w.hour, w.minute, w.second).getTime()
}

/** The wall-clock time of an instant in a zone. */
export function utcMsToZonedWall(utcMs: number, zone: string): WallTime {
  const t = utcMs + zoneOffsetMs(zone, utcMs)
  const d = new Date(t)
  return {
    year: d.getUTCFullYear(),
    month: d.getUTCMonth() + 1,
    day: d.getUTCDate(),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds()
  }
}

const pad = (n: number, w = 2): string => String(Math.abs(n)).padStart(w, '0')

/** `YYYY-MM-DDTHH:mm:ss±HH:MM` for an instant shown at a fixed offset (Z for 0). */
export function isoWithOffset(utcMs: number, offsetMs: number): string {
  const wall = new Date(utcMs + offsetMs)
  const date = `${pad(wall.getUTCFullYear(), 4)}-${pad(wall.getUTCMonth() + 1)}-${pad(wall.getUTCDate())}`
  const time = `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}:${pad(wall.getUTCSeconds())}`
  if (offsetMs === 0) return `${date}T${time}Z`
  const minutes = Math.round(offsetMs / 60_000)
  return `${date}T${time}${minutes < 0 ? '-' : '+'}${pad(Math.floor(Math.abs(minutes) / 60))}:${pad(Math.abs(minutes) % 60)}`
}

/** `YYYYMMDDTHHMMSSZ`: the UTC basic format of an instant (instance keys). */
export function utcBasic(utcMs: number): string {
  return new Date(utcMs).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')
}
