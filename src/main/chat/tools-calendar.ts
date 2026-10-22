// SPDX-License-Identifier: Apache-2.0
// Calendar tools: read-only over the local
// `calendar_events` rows, in Google event shape. Offered while at least one
// calendar source exists.

import type { CalendarEvent } from '@shared/types/notes'
import type { MainContext } from '../context'
import { bound, fail, okJson, parseDate, type LocalTool } from './tools'

const DAY_MS = 86_400_000
const SEARCH_BACK_DAYS = 90
const SEARCH_AHEAD_DAYS = 90
const LIST_AHEAD_DAYS = 14
const UPCOMING_DAYS = 7
const MAX_EVENTS = 100

function startOf(e: CalendarEvent): string {
  return e.start?.dateTime ?? e.start?.date ?? ''
}

function endOf(e: CalendarEvent): string {
  return e.end?.dateTime ?? e.end?.date ?? ''
}

function allDay(e: CalendarEvent): boolean {
  return !e.start?.dateTime && !!e.start?.date
}

function attendeeEmails(e: CalendarEvent): string[] {
  return (e.attendees ?? []).map((a) => a.email?.trim().toLowerCase()).filter((x): x is string => !!x)
}

function timeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

async function eventsBetween(ctx: MainContext, from: Date, to: Date): Promise<CalendarEvent[]> {
  return (await ctx.calendar.listEvents({ from: from.toISOString(), to: to.toISOString() })).filter((e) => e['status'] !== 'cancelled')
}

/** One event as the search tools return it. */
function searchRow(e: CalendarEvent): Record<string, unknown> {
  return {
    id: e.id,
    calendarId: typeof e['calendarId'] === 'string' ? e['calendarId'] : '',
    etag: typeof e['etag'] === 'string' ? e['etag'] : '',
    title: e.summary?.trim() || 'Untitled event',
    startTime: startOf(e),
    endTime: endOf(e),
    can_edit: false
  }
}

/** One event as listUpcomingEvents returns it, for its card. */
function upcomingRow(e: CalendarEvent): Record<string, unknown> {
  return {
    id: e.id,
    title: e.summary?.trim() || 'Untitled event',
    start: startOf(e),
    end: endOf(e),
    allDay: allDay(e),
    attendees: (e.attendees ?? [])
      .filter((a) => !a.self && !a.resource)
      .map((a) => a.displayName?.trim() || a.email)
      .slice(0, 12),
    location: typeof e['location'] === 'string' ? e['location'] : null
  }
}

const listUpcomingEvents: LocalTool = {
  def: {
    name: 'listUpcomingEvents',
    description: "Returns the user's next calendar events, soonest first: timed events and all-day events counted separately.",
    inputSchema: {
      type: 'object',
      properties: {
        max_timed: { type: 'integer', minimum: 1, maximum: 50, description: 'How many timed events to return at most (default 10).' },
        max_all_day: { type: 'integer', minimum: 0, maximum: 50, description: 'How many all-day events to return at most (default 5; 0 for none).' }
      },
      additionalProperties: false
    }
  },
  category: 'calendar',
  title: 'Get upcoming calendar events',
  needsApproval: false,
  readOnly: true,
  available: (a) => a.calendar,
  run: async (args, env) => {
    const now = new Date()
    const end = new Date(now.getFullYear(), now.getMonth(), now.getDate() + UPCOMING_DAYS + 1)
    const events = (await eventsBetween(env.ctx, now, end)).filter((e) => Date.parse(endOf(e)) > now.getTime() || allDay(e))
    const timed = events.filter((e) => !allDay(e))
    const days = events.filter(allDay)
    const timedLimit = bound(args['max_timed'], 10, 50)
    const dayLimit = typeof args['max_all_day'] === 'number' ? Math.max(0, Math.min(50, Math.floor(args['max_all_day']))) : 5
    const out = [...timed.slice(0, timedLimit), ...days.slice(0, dayLimit)]
    return okJson({
      events: out.map(upcomingRow),
      event_count: events.length,
      timed_count: timed.length,
      all_day_count: days.length,
      from: now.toISOString(),
      to: end.toISOString()
    })
  }
}

const searchArgs = {
  query: { type: 'string', description: 'Words to match in the event title, description or location.' },
  attendeeEmail: { type: 'string', description: "Only events with this attendee (an email address)." },
  attendeeEmails: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'Only events with these attendees (email addresses); see attendeeMatch.' },
  attendeeMatch: { type: 'string', enum: ['all', 'any'], description: 'all: every listed attendee must be invited; any: at least one of them (default all).' },
  startDate: { type: 'string', description: 'Earliest start, as an ISO 8601 date or date-time.' },
  endDate: { type: 'string', description: 'Latest start, as an ISO 8601 date or date-time.' }
}

function searchTool(name: 'searchCalendar' | 'listEventsInRange' | 'findEvents'): LocalTool {
  const listing = name === 'listEventsInRange'
  return {
    def: {
      name,
      description: listing
        ? "Lists the user's calendar events in a date range, optionally filtered by attendees or words, in start order."
        : "Searches the user's calendar for events by words, attendees and dates, past or future. Returns each event's ids, title, time and attendees.",
      inputSchema: { type: 'object', properties: searchArgs, additionalProperties: false }
    },
    category: 'calendar',
    title: listing ? 'List calendar events' : 'Search the calendar',
    needsApproval: false,
    readOnly: true,
    available: (a) => a.calendar,
    run: async (args, env) => {
      const now = new Date()
      const from = parseDate(args['startDate'], false) ?? (listing ? now : new Date(now.getTime() - SEARCH_BACK_DAYS * DAY_MS))
      const to = parseDate(args['endDate'], true) ?? new Date(now.getTime() + (listing ? LIST_AHEAD_DAYS : SEARCH_AHEAD_DAYS) * DAY_MS)
      if (to.getTime() < from.getTime()) return fail('endDate is before startDate.')
      const words = (typeof args['query'] === 'string' ? args['query'] : '').toLowerCase().split(/\s+/).filter(Boolean)
      const wanted = [
        ...(typeof args['attendeeEmail'] === 'string' ? [args['attendeeEmail']] : []),
        ...(Array.isArray(args['attendeeEmails']) ? (args['attendeeEmails'] as string[]) : [])
      ]
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
      const any = args['attendeeMatch'] === 'any'
      const events = (await eventsBetween(env.ctx, from, to)).filter((e) => {
        const title = (e.summary ?? '').toLowerCase()
        if (!words.every((w) => title.includes(w))) return false
        if (wanted.length === 0) return true
        const emails = attendeeEmails(e)
        return any ? wanted.some((w) => emails.includes(w)) : wanted.every((w) => emails.includes(w))
      })
      const shown = events.slice(0, MAX_EVENTS)
      const message =
        events.length === 0 ? 'No events matched.' : events.length > shown.length ? `Showing the first ${shown.length} of ${events.length} events.` : ''
      return okJson({ events: shown.map(searchRow), timezone: timeZone(), message })
    }
  }
}

const readEvent: LocalTool = {
  def: {
    name: 'readEvent',
    description: 'Reads one calendar event in full: time, attendees with their responses, location, description and conferencing links.',
    inputSchema: {
      type: 'object',
      properties: {
        calendar_id: { type: 'string', minLength: 1, maxLength: 1_024, description: "The calendar the event belongs to, as returned by a calendar search; leave it out for the primary calendar." },
        event_id: { type: 'string', minLength: 1, maxLength: 1_024, description: "The event's id, as returned by a calendar search." }
      },
      required: ['event_id'],
      additionalProperties: false
    }
  },
  category: 'calendar',
  title: 'Read a calendar event',
  needsApproval: false,
  readOnly: true,
  available: (a) => a.calendar,
  run: async (args, env) => {
    const event = await env.ctx.calendar.getEvent(String(args['event_id']))
    if (!event) return fail('That calendar event was not found.')
    return okJson(event)
  }
}

export const CALENDAR_TOOLS: readonly LocalTool[] = [
  listUpcomingEvents,
  searchTool('searchCalendar'),
  searchTool('listEventsInRange'),
  searchTool('findEvents'),
  readEvent
]
