// SPDX-License-Identifier: Apache-2.0
// Google Calendar and Microsoft Graph reads: calendar
// lists, the account email, events in the sync window, and the Graph → canonical map.

import type { CalendarInfo } from '@shared/types/calendar'
import type { CalendarAttendee, CalendarEvent } from '@shared/types/notes'
import { bearer, calendarHttp, endpoint, isDevMock, readJson } from './oauth'
import { ianaZoneFor } from './tz'

export type ProviderCalendar = Omit<CalendarInfo, 'visible'> & { nativeId: string }

const MAX_PAGES = 50
/** Google event types that are not meetings. */
const DROPPED_GOOGLE_TYPES = new Set(['outOfOffice', 'focusTime', 'workingLocation', 'birthday'])

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

// ---------- Google ----------

export async function googleCalendars(sourceId: string, token: string): Promise<{ calendars: ProviderCalendar[]; accountEmail: string | null }> {
  const calendars: ProviderCalendar[] = []
  let accountEmail: string | null = null
  let pageToken: string | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = new URLSearchParams({ maxResults: '250' })
    if (pageToken) q.set('pageToken', pageToken)
    const body = await readJson(calendarHttp.fetch('https://www.googleapis.com/calendar/v3/users/me/calendarList', { query: q, headers: bearer(token) }))
    for (const item of Array.isArray(body['items']) ? (body['items'] as Record<string, unknown>[]) : []) {
      const nativeId = str(item['id'])
      if (!nativeId) continue
      const primary = item['primary'] === true
      // The primary calendar's id is the account email.
      if (primary) accountEmail = nativeId
      calendars.push({
        id: `google:${sourceId}:${nativeId}`,
        nativeId,
        sourceId,
        name: str(item['summaryOverride']) ?? str(item['summary']) ?? nativeId,
        color: str(item['backgroundColor']),
        primary,
        accessRole: str(item['accessRole'])
      })
    }
    pageToken = str(body['nextPageToken'])
    if (!pageToken) break
  }
  return { calendars, accountEmail }
}

export async function googleEvents(
  sourceId: string,
  token: string,
  calendar: { id: string; nativeId: string; primary: boolean },
  window: { fromMs: number; toMs: number }
): Promise<CalendarEvent[]> {
  const out: CalendarEvent[] = []
  let pageToken: string | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const q = new URLSearchParams({
      timeMin: new Date(window.fromMs).toISOString(),
      timeMax: new Date(window.toMs).toISOString(),
      singleEvents: 'true',
      orderBy: 'startTime',
      maxResults: '2500'
    })
    if (pageToken) q.set('pageToken', pageToken)
    const body = await readJson(
      calendarHttp.fetch('https://www.googleapis.com/calendar/v3/calendars/{calendarId}/events', {
        params: { calendarId: calendar.nativeId },
        query: q,
        headers: bearer(token)
      })
    )
    for (const item of Array.isArray(body['items']) ? (body['items'] as Record<string, unknown>[]) : []) {
      const id = str(item['id'])
      if (!id) continue
      if (typeof item['eventType'] === 'string' && DROPPED_GOOGLE_TYPES.has(item['eventType'])) continue
      out.push({ ...item, id: `google:${sourceId}:${id}`, calendarId: calendar.id, primaryCalendar: calendar.primary })
    }
    pageToken = str(body['nextPageToken'])
    if (!pageToken) break
  }
  return out
}

// ---------- Microsoft ----------

export async function graphAccountEmail(token: string): Promise<string | null> {
  const me = await readJson(calendarHttp.fetch('https://graph.microsoft.com/v1.0/me', { headers: bearer(token) }))
  return str(me['mail']) ?? str(me['userPrincipalName'])
}

/** `@odata.nextLink` must stay on Graph (or the dev mock). */
function nextLink(body: Record<string, unknown>): string | null {
  const link = str(body['@odata.nextLink'])
  if (!link) return null
  try {
    const u = new URL(link)
    if (u.protocol === 'https:' && u.hostname === 'graph.microsoft.com') return link
    if (isDevMock() && link.startsWith(endpoint('https://graph.microsoft.com/'))) return link
  } catch {
    // Not a URL: stop paging.
  }
  return null
}

export async function graphCalendars(sourceId: string, token: string, accountEmail: string | null): Promise<ProviderCalendar[]> {
  const out: ProviderCalendar[] = []
  let next: string | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const body: Record<string, unknown> = await readJson(
      next
        ? calendarHttp.fetchUrl(next, { headers: bearer(token) })
        : calendarHttp.fetch('https://graph.microsoft.com/v1.0/me/calendars', { query: { $top: '100' }, headers: bearer(token) })
    )
    for (const item of Array.isArray(body['value']) ? (body['value'] as Record<string, unknown>[]) : []) {
      const nativeId = str(item['id'])
      if (!nativeId) continue
      const owner = (item['owner'] as { address?: unknown } | undefined)?.address
      const ownsIt = typeof owner === 'string' && !!accountEmail && owner.toLowerCase() === accountEmail.toLowerCase()
      const color = str(item['hexColor'])
      out.push({
        id: `microsoft:${sourceId}:${nativeId}`,
        nativeId,
        sourceId,
        name: str(item['name']) ?? 'Calendar',
        color: color && /^#[0-9a-f]{6}$/i.test(color) ? color : null,
        primary: item['isDefaultCalendar'] === true,
        accessRole: ownsIt ? 'owner' : item['canEdit'] === true ? 'writer' : 'reader'
      })
    }
    next = nextLink(body)
    if (!next) break
  }
  return out
}

export async function graphEvents(
  sourceId: string,
  token: string,
  calendar: { id: string; nativeId: string; primary: boolean },
  accountEmail: string | null,
  window: { fromMs: number; toMs: number }
): Promise<CalendarEvent[]> {
  const q = new URLSearchParams({
    startDateTime: new Date(window.fromMs).toISOString(),
    endDateTime: new Date(window.toMs).toISOString(),
    $top: '250'
  })
  const headers = bearer(token, { prefer: 'outlook.timezone="UTC", outlook.body-content-type="text"' })
  const out: CalendarEvent[] = []
  let next: string | null = null
  for (let i = 0; i < MAX_PAGES; i++) {
    const body: Record<string, unknown> = await readJson(
      next
        ? calendarHttp.fetchUrl(next, { headers })
        : calendarHttp.fetch('https://graph.microsoft.com/v1.0/me/calendars/{calendarId}/calendarView', {
            params: { calendarId: calendar.nativeId },
            query: q,
            headers
          })
    )
    for (const item of Array.isArray(body['value']) ? (body['value'] as Record<string, unknown>[]) : []) {
      const ev = graphToCanonical(item, sourceId, calendar, accountEmail)
      if (ev) out.push(ev)
    }
    next = nextLink(body)
    if (!next) break
  }
  return out
}

const RESPONSE: Record<string, string> = {
  accepted: 'accepted',
  organizer: 'accepted',
  tentativelyAccepted: 'tentative',
  declined: 'declined',
  none: 'needsAction',
  notResponded: 'needsAction'
}

const SENSITIVITY: Record<string, string> = { normal: 'default', personal: 'private', private: 'private', confidential: 'confidential' }

/** Graph returns UTC wall times (`Prefer: outlook.timezone="UTC"`) with up to 7 fraction digits. */
function utcIso(v: unknown): string | null {
  const s = str(v)
  if (!s) return null
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})/.exec(s)
  return m ? `${m[1]}Z` : null
}

/** The Graph → canonical event mapping. */
export function graphToCanonical(
  g: Record<string, unknown>,
  sourceId: string,
  calendar: { id: string; primary: boolean },
  accountEmail: string | null
): CalendarEvent | null {
  const id = str(g['id'])
  if (!id) return null
  const me = accountEmail?.toLowerCase() ?? null
  const ev: CalendarEvent = { id: `microsoft:${sourceId}:${id}`, calendarId: calendar.id, primaryCalendar: calendar.primary }
  // Graph's `iCalUId` differs per occurrence of a series; `uid` is the series-wide UID an
  // Outlook-published ICS gives every instance, so the ICS↔OAuth dedupe (uid + start) holds.
  const uid = str(g['uid']) ?? str(g['iCalUId'])
  if (uid) ev.iCalUID = uid
  const subject = str(g['subject'])
  if (subject) ev.summary = subject
  const body = g['body'] as { content?: unknown } | undefined
  const description = str(body?.content)?.trim() || str(g['bodyPreview'])
  if (description) ev['description'] = description
  const names = new Set<string>()
  const loc = str((g['location'] as { displayName?: unknown } | undefined)?.displayName)?.trim()
  if (loc) names.add(loc)
  for (const l of Array.isArray(g['locations']) ? (g['locations'] as { displayName?: unknown }[]) : []) {
    const n = str(l?.displayName)?.trim()
    if (n) names.add(n)
  }
  if (names.size) ev['location'] = [...names].join('; ')
  const webLink = str(g['webLink'])
  if (webLink) ev['htmlLink'] = webLink

  const start = g['start'] as { dateTime?: unknown } | undefined
  const end = g['end'] as { dateTime?: unknown } | undefined
  if (g['isAllDay'] === true) {
    const s = str(start?.dateTime)?.slice(0, 10)
    const e = str(end?.dateTime)?.slice(0, 10)
    if (s) ev.start = { date: s }
    if (e) ev.end = { date: e }
  } else {
    const zone = ianaZoneFor(str(g['originalStartTimeZone']))
    const s = utcIso(start?.dateTime)
    const e = utcIso(end?.dateTime)
    if (s) ev.start = { dateTime: s, ...(zone ? { timeZone: zone } : {}) }
    if (e) ev.end = { dateTime: e, ...(zone ? { timeZone: zone } : {}) }
  }
  ev['status'] = g['isCancelled'] === true ? 'cancelled' : 'confirmed'

  const organizer = (g['organizer'] as { emailAddress?: { address?: unknown; name?: unknown } } | undefined)?.emailAddress
  const orgEmail = str(organizer?.address)
  const isOrganizer = g['isOrganizer'] === true
  if (orgEmail) {
    const name = str(organizer?.name)
    ev['organizer'] = { email: orgEmail, ...(name ? { displayName: name } : {}), ...(isOrganizer ? { self: true } : {}) }
  }

  const myResponse = RESPONSE[str((g['responseStatus'] as { response?: unknown } | undefined)?.response) ?? ''] ?? null
  const attendees: CalendarAttendee[] = []
  let selfListed = false
  for (const a of Array.isArray(g['attendees']) ? (g['attendees'] as Record<string, unknown>[]) : []) {
    const addr = a['emailAddress'] as { address?: unknown; name?: unknown } | undefined
    const email = str(addr?.address)
    if (!email) continue
    const name = str(addr?.name)
    const type = str(a['type'])
    const self = !!me && email.toLowerCase() === me
    if (self) selfListed = true
    const response = RESPONSE[str((a['status'] as { response?: unknown } | undefined)?.response) ?? ''] ?? 'needsAction'
    attendees.push({
      email,
      ...(name ? { displayName: name } : {}),
      responseStatus: self && myResponse ? myResponse : response,
      ...(type === 'resource' ? { resource: true } : {}),
      ...(type === 'optional' ? { optional: true } : {}),
      ...(self ? { self: true } : {}),
      ...(orgEmail && orgEmail.toLowerCase() === email.toLowerCase() ? { organizer: true } : {})
    })
  }
  if (!selfListed && !isOrganizer && accountEmail && myResponse) {
    attendees.push({ email: accountEmail, self: true, responseStatus: myResponse })
  }
  if (attendees.length) ev.attendees = attendees

  const joinUrl = str((g['onlineMeeting'] as { joinUrl?: unknown } | undefined)?.joinUrl) ?? str(g['onlineMeetingUrl'])
  if (joinUrl) {
    const provider = str(g['onlineMeetingProvider'])
    const name =
      provider === 'teamsForBusiness' ? 'Microsoft Teams' : provider === 'skypeForBusiness' || provider === 'skypeForConsumer' ? 'Skype' : null
    ev['conferenceData'] = {
      entryPoints: [{ entryPointType: 'video', uri: joinUrl }],
      ...(name ? { conferenceSolution: { name } } : {})
    }
  }
  const series = str(g['seriesMasterId'])
  if (series) ev['recurringEventId'] = series
  const created = str(g['createdDateTime'])
  const updated = str(g['lastModifiedDateTime'])
  const etag = str(g['changeKey'])
  if (created) ev['created'] = created
  if (updated) ev['updated'] = updated
  if (etag) ev['etag'] = etag
  const visibility = SENSITIVITY[str(g['sensitivity']) ?? '']
  if (visibility) ev['visibility'] = visibility
  return ev
}

