// SPDX-License-Identifier: Apache-2.0
// Meeting rooms for calendar drafts (`calendar:rooms`): the rooms on past events in the local
// calendar (no new permission, works offline, Google and Microsoft), and the Google Workspace room
// directory behind the opt-in `rooms-read` grant. The directory stays in memory for the session
// and is never written to disk. Nothing here logs a room name or address.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes } from '@shared/ipc'
import type { CalendarRoom, CalendarSource } from '@shared/types/calendar'
import type { MainContext } from '../context'
import { log } from '../log'
import { egressBlocked } from '../privacy'
import { busyTimes } from './availability'
import { exchange, providerHttp } from './http'

type Obj = Record<string, unknown>
const obj = (v: unknown): Obj => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Obj) : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const DAY_MS = 86_400_000
/** How far back past events are read for rooms. */
const HISTORY_DAYS = 365
/** Free/busy is read for at most this many listed rooms. */
const BUSY_MAX = 100
const DIRECTORY_PAGES = 10

export const ROOMS_COPY = {
  googleOnly: 'Your organization’s room list is available for Google Workspace accounts only.',
  needGrant: 'Let Notula see your organization’s rooms first.',
  forbidden: 'Your organization doesn’t let Notula list its rooms. You can still add a room by its calendar address.',
  localOnly: 'Your organization’s room list isn’t available while Local-only mode is on.',
  reconnect: 'Reconnect your calendar to continue.',
  failed: 'Couldn’t load your organization’s rooms. Try again.'
} as const

/** Per account, the directory read this session. */
const directoryCache = new Map<string, CalendarRoom[]>()

/** Rooms on the account's past and coming events, the most used first. */
export async function pastRooms(ctx: MainContext, src: CalendarSource): Promise<CalendarRoom[]> {
  const now = Date.now()
  const events = await ctx.storage.listEventsInRange({ from: new Date(now - HISTORY_DAYS * DAY_MS).toISOString(), to: new Date(now + 90 * DAY_MS).toISOString() }).catch(() => [])
  const prefix = `${src.kind}:${src.id}:`
  const seen = new Map<string, { room: CalendarRoom; uses: number }>()
  for (const ev of events) {
    if (!ev.id.startsWith(prefix)) continue
    for (const a of ev.attendees ?? []) {
      if (a.resource !== true || !a.email) continue
      const key = a.email.toLowerCase()
      const cur = seen.get(key)
      if (cur) cur.uses++
      else seen.set(key, { room: { email: a.email, name: a.displayName?.trim() || a.email, building: null, capacity: null, busy: null }, uses: 1 })
    }
  }
  return [...seen.values()].sort((a, b) => b.uses - a.uses || a.room.name.localeCompare(b.room.name)).map((x) => x.room)
}

/** The Google Workspace room directory; a string is the message to show instead. */
export async function directoryRooms(ctx: MainContext, src: CalendarSource): Promise<CalendarRoom[] | string> {
  if (src.kind !== 'google') return ROOMS_COPY.googleOnly
  if (!src.grants.includes('rooms-read')) return ROOMS_COPY.needGrant
  const cached = directoryCache.get(src.id)
  if (cached) return cached
  let token: string
  try {
    token = await ctx.calendar.accessToken(src.id, 'rooms-read')
  } catch (err) {
    return err instanceof Error && /missing_scopes/.test(err.message) ? ROOMS_COPY.needGrant : ROOMS_COPY.reconnect
  }
  const http = providerHttp(ctx, 'calendar', 'calendar-rooms')
  const rooms: CalendarRoom[] = []
  let pageToken = ''
  for (let page = 0; page < DIRECTORY_PAGES; page++) {
    const x = await exchange(() =>
      http.fetch('https://admin.googleapis.com/admin/directory/v1/customer/my_customer/resources/calendars', {
        query: { maxResults: '500', ...(pageToken ? { pageToken } : {}) },
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' }
      })
    )
    if (!x.ok) {
      if (x.kind === 'local-only') return ROOMS_COPY.localOnly
      if (x.kind === 'http' && x.status === 403) return ROOMS_COPY.forbidden
      if (x.kind === 'http' && x.status === 401) return ROOMS_COPY.reconnect
      return ROOMS_COPY.failed
    }
    for (const r of Array.isArray(x.body['items']) ? (x.body['items'] as unknown[]).map(obj) : []) {
      const email = str(r['resourceEmail'])
      if (!email) continue
      const capacity = Number(r['capacity'])
      rooms.push({
        email,
        name: str(r['resourceName']) || str(r['generatedResourceName']) || email,
        building: str(r['buildingId']) || null,
        capacity: Number.isFinite(capacity) && capacity > 0 ? capacity : null,
        busy: null
      })
    }
    pageToken = str(x.body['nextPageToken'])
    if (!pageToken) break
  }
  rooms.sort((a, b) => (a.building ?? '').localeCompare(b.building ?? '') || a.name.localeCompare(b.name))
  directoryCache.set(src.id, rooms)
  return rooms
}

/** The first rooms marked busy or free in the slot; the rest, and any the provider can't show, stay unknown. */
async function withBusy(ctx: MainContext, src: CalendarSource, rooms: CalendarRoom[], slot: { start: string; end: string }): Promise<CalendarRoom[]> {
  const from = Date.parse(slot.start)
  const to = Date.parse(slot.end)
  if (!(to > from) || !rooms.length) return rooms
  const asked = rooms.slice(0, BUSY_MAX)
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  const busy = await busyTimes(ctx, src, asked.map((r) => r.email), new Date(from), new Date(to), zone)
  if (typeof busy === 'string') return rooms
  const by = new Map(busy.map((b) => [b.email.toLowerCase(), b]))
  return rooms.map((r) => {
    const b = by.get(r.email.toLowerCase())
    return b?.known ? { ...r, busy: b.busy.some((x) => Date.parse(x.start) < to && Date.parse(x.end) > from) } : r
  })
}

export function registerRooms(ctx: MainContext): void {
  ipcMain.handle('calendar:rooms' satisfies InvokeChannel, async (_e, req: InvokeReq<'calendar:rooms'>): Promise<InvokeRes<'calendar:rooms'>> => {
    const r = obj(req)
    const sourceId = str(r['sourceId'])
    if (!sourceId) throw notulaError('invalid-input', 'sourceId is required')
    if (r['source'] !== 'history' && r['source'] !== 'directory') throw notulaError('invalid-input', 'source must be history or directory')
    if (!(await ctx.settings.get('calendarWrite.enabled'))) throw notulaError('invalid-input', 'Creating calendar events is turned off.')
    const src = ((await ctx.storage.listCalendarSources().catch(() => [])) as CalendarSource[]).find((s) => s.id === sourceId && (s.kind === 'google' || s.kind === 'microsoft'))
    if (!src) throw notulaError('not-found', 'That account is no longer connected.')
    const source = r['source']
    const blocked = await egressBlocked(ctx, { kind: 'calendar' })
    const found = source === 'history' ? await pastRooms(ctx, src) : blocked ? ROOMS_COPY.localOnly : await directoryRooms(ctx, src)
    log('info', 'calendar-write:rooms', { provider: src.kind, source, ok: typeof found !== 'string' })
    if (typeof found === 'string') return { rooms: [], error: found }
    const slot = obj(r['slot'])
    const rooms = !blocked && str(slot['start']) && str(slot['end']) ? await withBusy(ctx, src, found, { start: str(slot['start']), end: str(slot['end']) }).catch(() => found) : found
    return { rooms, error: null }
  })
}
