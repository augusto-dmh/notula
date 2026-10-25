// SPDX-License-Identifier: Apache-2.0
// Calendar writes: `calendar:set-grant`, `calendar:event-colors`, the
// `calendar_event` block executor and the `proposeEvent` chat tool.
//
// - Gate: `calendarWrite.enabled` (Labs, off). The tool is offered only with an OAuth account
//   (ICS feeds never write) and needs no approval: the card is the approval, and nothing is written
//   until the user clicks Create event.
// - The write runs on the account's `calendar-write` grant. Local-only mode refuses it.
// - Tokens, event bodies and guest lists never reach a log.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes } from '@shared/ipc'
import type { CalendarGrant, CalendarSource } from '@shared/types/calendar'
import type { CalendarEventDraft, WorkflowBlock } from '@shared/types/workflow-blocks'
import type { CalendarEvent } from '@shared/types/notes'
import type { MainContext } from '../context'
import { log } from '../log'
import { egressBlocked } from '../privacy'
import { blockStore, registerBlockType, type ExecResult } from '../blocks'
import type { ChatToolResult, ChatToolSpec } from '../chat/tool-api'
import { AVAILABILITY_SPECS, AVAILABILITY_TOOL, PERSON_CALENDAR_TOOL, runCheckAvailability, runReadPersonCalendar } from '../chat/tools-availability'
import { cancelEvent } from './cancel'
import { respondRefusal, respondToInvite, type InviteResponse } from './respond'
import { availabilitySource, busyTimes, overlaps, without } from './availability'
import { eventColors } from './colors'
import { chosenTime, diffDraft, draftFromEvent, eventTime, NO_CHANGE, NOT_AVAILABLE, normalizeDraft, validateDraft } from './draft'
import { COPY, eventRef, googleCreate, googleSplit, googleUpdate, graphCreate, graphSplit, graphUpdate, seriesMaster, writeToken, type WriteTarget } from './providers'

export const DRAFT_TOOL = 'proposeEvent'
const REPLY_TOOL = 'replyToInvite'
const CANCEL_TOOL = 'cancelEvent'
const NEED_WRITE = 'Grant Notula permission to change this calendar in Settings ▸ Calendar first.'
const GRANTS: readonly CalendarGrant[] = ['calendar-write', 'mail-read', 'mail-send', 'files-read']

/** The account a Create event used last, for the "Add to" default (this session). */
let lastTarget: string | null = null

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {})

async function oauthSources(ctx: MainContext): Promise<CalendarSource[]> {
  const st = await ctx.storage.listCalendarSources().catch(() => [])
  return st.filter((s) => s.kind === 'google' || s.kind === 'microsoft') as CalendarSource[]
}

/** The chosen account, else the last used, else the one matching the profile email, else the first. */
async function resolveTarget(ctx: MainContext, wanted: string | undefined): Promise<WriteTarget | { error: ExecResult }> {
  const sources = await oauthSources(ctx)
  if (!sources.length) return { error: { status: 'failed', errorCode: 'no_account', error: 'Connect Google Calendar or Microsoft to create events.' } }
  const writable = sources.filter((s) => s.grants.includes('calendar-write'))
  const pool = writable.length ? writable : sources
  const profile = String((await ctx.settings.get('profile.email').catch(() => '')) ?? '').toLowerCase()
  const src =
    (wanted ? sources.find((s) => s.id === wanted) : undefined) ??
    (lastTarget ? pool.find((s) => s.id === lastTarget) : undefined) ??
    pool.find((s) => !!profile && s.accountEmail?.toLowerCase() === profile) ??
    pool[0]
  if (!src) return { error: { status: 'failed', errorCode: 'no_account', error: 'Connect Google Calendar or Microsoft to create events.' } }
  const provider = src.kind as 'google' | 'microsoft'
  const primary = (await ctx.storage.listCalendars().catch(() => [])).find((c) => c.sourceId === src.id && c.primary)
  const nativeId = primary ? primary.id.split(':').slice(2).join(':') : ''
  if (provider === 'microsoft' && !nativeId) return { error: { status: 'failed', errorCode: 'no_calendar', error: 'Notula hasn’t synced this account’s calendar yet. Try again in a minute.' } }
  return { sourceId: src.id, provider, accountEmail: src.accountEmail, calendarNativeId: provider === 'google' ? nativeId || 'primary' : nativeId }
}

async function executeDraft(ctx: MainContext, block: WorkflowBlock, targetSourceId: string | undefined): Promise<ExecResult> {
  if (await egressBlocked(ctx, { kind: 'calendar' })) return { status: 'failed', errorCode: 'local_only', error: COPY.localOnly }
  const d = block.content as CalendarEventDraft
  const invalid = validateDraft(d)
  if (invalid) return { status: 'failed', errorCode: 'invalid', error: invalid }
  if (!chosenTime(d)) return { status: 'failed', errorCode: 'invalid', error: 'Choose a time' }
  // An update writes to the account the event belongs to.
  const fromSource = d.existingEvent ? d.existingEvent.calendarId.split(':')[1] : undefined
  const resolved = await resolveTarget(ctx, fromSource ?? targetSourceId)
  if ('error' in resolved) return resolved.error
  const token = await writeToken(ctx, resolved.sourceId)
  if (typeof token !== 'string') return token
  const edit = d.existingEvent ? { ...d.existingEvent, eventId: d.existingEvent.eventId.split(':').slice(2).join(':') || d.existingEvent.eventId } : undefined
  const draft = edit ? { ...d, existingEvent: edit } : d
  // An edit writes to the event's own calendar.
  const eventCalendar = edit ? edit.calendarId.split(':').slice(2).join(':') : ''
  const t = eventCalendar ? { ...resolved, calendarNativeId: eventCalendar } : resolved
  const out =
    t.provider === 'google'
      ? edit
        ? edit.scope === 'following'
          ? await googleSplit(ctx, token, t, draft, block.id)
          : await googleUpdate(ctx, token, t, draft)
        : await googleCreate(ctx, token, t, draft, block.id)
      : edit
        ? edit.scope === 'following'
          ? await graphSplit(ctx, token, t, draft, block.id)
          : await graphUpdate(ctx, token, t, draft)
        : await graphCreate(ctx, token, t, draft, block.id)
  if (out.status === 'created' || out.status === 'updated') {
    lastTarget = t.sourceId
    ctx.calendar.refreshSource(t.sourceId)
    out.fields = { ...out.fields, sourceId: t.sourceId, provider: t.provider }
  }
  log('info', 'calendar-write:result', { provider: t.provider, update: !!edit, scope: edit?.scope ?? null, status: out.status, code: out.errorCode ?? null })
  return out
}

// ---------- the tool ----------

const TIME_SCHEMA = {
  type: 'object',
  description:
    "Timed: {dateTime, timeZone}. dateTime is ISO 8601; without an offset it is read in timeZone (IANA), or in the user's zone when timeZone is left out. Give the offset or the zone, not two that disagree. All-day: {date (YYYY-MM-DD, end exclusive)}.",
  properties: { dateTime: { type: 'string' }, timeZone: { type: 'string' }, date: { type: 'string' } },
  additionalProperties: false
}

const DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'The event title.' },
    timeOptions: {
      type: 'array',
      minItems: 1,
      maxItems: 3,
      description: 'One to three proposed times, all in the same time zone. A repeating event has exactly one (its first occurrence). On an edit, leaving out end keeps the event’s length.',
      items: { type: 'object', properties: { start: TIME_SCHEMA, end: TIME_SCHEMA }, required: ['start'], additionalProperties: false }
    },
    start: { ...TIME_SCHEMA, description: 'Simple form: one start (instead of timeOptions).' },
    end: { ...TIME_SCHEMA, description: 'Simple form: one end.' },
    withMeetLink: { type: 'boolean', description: 'Simple form: add a video link.' },
    conference: {
      type: 'object',
      description: '{kind: "none"}, {kind: "googleMeet"} (Microsoft Teams on Microsoft accounts) or {kind: "custom", url}.',
      properties: { kind: { type: 'string', enum: ['none', 'googleMeet', 'custom'] }, url: { type: 'string' } },
      required: ['kind'],
      additionalProperties: false
    },
    attendees: {
      type: 'array',
      description: 'Guests by email. Set resource true to book a room.',
      items: { type: 'object', properties: { email: { type: 'string' }, resource: { type: 'boolean' } }, required: ['email'], additionalProperties: false }
    },
    location: { type: 'string' },
    description: { type: 'string' },
    addMeAsGuest: { type: 'boolean', description: 'Default true.' },
    recurrenceRules: {
      type: 'array',
      items: { type: 'string' },
      description:
        'One RRULE line, e.g. "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=WE;COUNT=5", for a new event or to change how a series repeats (scope series or following). Leave it out on an edit to keep the series’ own rule.'
    },
    colorId: { type: 'string', enum: ['default', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'], description: 'Google event color 1–11; default is the calendar’s color. Not available on Microsoft calendars.' },
    visibility: { type: 'string', enum: ['default', 'public', 'private'], description: 'Who can see the event: the calendar’s setting, anyone who can see the calendar, or only the user and the guests.' },
    fromEvent: {
      type: 'object',
      description:
        'To change an existing event: its calendarId and id from a calendar search, and the scope: occurrence (this one), series (every occurrence) or following (this one and the later ones, which become a new series).',
      properties: { calendarId: { type: 'string' }, eventId: { type: 'string' }, scope: { type: 'string', enum: ['occurrence', 'series', 'following'] } },
      required: ['calendarId', 'eventId'],
      additionalProperties: false
    }
  },
  additionalProperties: false
} as const

function attends(ev: CalendarEvent, mine: ReadonlySet<string>): boolean {
  if (ev['transparency'] === 'transparent' || ev['status'] === 'cancelled') return false
  const me = (ev.attendees ?? []).find((a) => typeof a.email === 'string' && mine.has(a.email.toLowerCase()))
  return !me || (me as { responseStatus?: unknown }).responseStatus !== 'declined'
}

/** Per time option, the titles of the user's own busy events it overlaps. */
async function conflicts(ctx: MainContext, d: CalendarEventDraft): Promise<string[][]> {
  const mine = new Set((await ctx.calendar.myEmails()).map((e) => e.toLowerCase()))
  return Promise.all(
    d.timeOptions.map(async (o) => {
      if (!('dateTime' in o.start) || !('dateTime' in o.end)) return []
      const from = new Date(Date.parse(o.start.dateTime)).toISOString()
      const to = new Date(Date.parse(o.end.dateTime)).toISOString()
      const events = await ctx.calendar.listEvents({ from: new Date(Date.parse(from) - 86_400_000).toISOString(), to })
      return events
        .filter((ev) => {
          const s = Date.parse(String(ev.start?.dateTime ?? ''))
          const e = Date.parse(String(ev.end?.dateTime ?? ''))
          return s < Date.parse(to) && e > Date.parse(from) && attends(ev, mine)
        })
        .map((ev) => String(ev.summary ?? 'Busy'))
        .slice(0, 3)
    })
  )
}

/** `fromEvent` → the update's `existingEvent`, from the synced copy of the event (and its series, for series edits). */
async function withExisting(ctx: MainContext, d: CalendarEventDraft): Promise<CalendarEventDraft | string> {
  if (!d.fromEvent) return d
  const ev = await ctx.calendar.getEvent(d.fromEvent.eventId)
  if (!ev) return 'That event isn’t in your synced calendar. Search the calendar again and use its id.'
  const calendarId = typeof ev['calendarId'] === 'string' ? ev['calendarId'] : d.fromEvent.calendarId
  if (!/^(google|microsoft):/.test(calendarId)) return 'Calendar feeds are read-only, so this event can’t be changed from Notula.'
  const scope = d.fromEvent.scope
  const original = draftFromEvent(ev, await ctx.calendar.myEmails())
  const ref = eventRef(ev)
  const occurrenceStart = ref?.seriesId ? (eventTime(ev['originalStartTime']) ?? eventTime(ev.start)) : null
  let seriesEtag: string | null = null
  if (ref?.seriesId && scope !== 'occurrence') {
    const master = await seriesMaster(ctx, ref)
    if (master) {
      seriesEtag = master.etag || null
      if (master.rules.length) original.recurrenceRules = master.rules
    }
  }
  // A series edit that leaves out the rule keeps the series' own.
  const rules = scope !== 'occurrence' && !d.recurrenceRules?.length && original.recurrenceRules?.length ? { recurrenceRules: original.recurrenceRules } : {}
  return {
    ...d,
    ...rules,
    existingEvent: {
      calendarId,
      eventId: ev.id,
      scope,
      etag: typeof ev['etag'] === 'string' ? ev['etag'] : '',
      ...(seriesEtag ? { seriesEtag } : {}),
      ...(occurrenceStart ? { occurrenceStart } : {}),
      original
    }
  }
}

export interface MoveAvailability {
  /** Guests whose calendars were read. */
  checked: number
  unknown: string[]
  conflicts: { email: string; name: string }[]
}

/** An update that moves the time: who among the guests is busy then. It never blocks the update. */
async function moveAvailability(ctx: MainContext, d: CalendarEventDraft): Promise<MoveAvailability | null> {
  const ex = d.existingEvent
  if (!ex) return null
  const r = diffDraft(d)
  if ('refusal' in r || !r.diff.time || !('dateTime' in r.diff.time.start) || !('dateTime' in r.diff.time.end)) return null
  const mine = new Set((await ctx.calendar.myEmails()).map((e) => e.toLowerCase()))
  const guests = d.attendees.filter((a) => !a.resource && !mine.has(a.email.toLowerCase())).slice(0, 50)
  if (!guests.length) return null
  const sourceId = ex.calendarId.split(':')[1]
  const src = (await oauthSources(ctx)).find((s) => s.id === sourceId) ?? (await availabilitySource(ctx))
  if (!src) return null
  const from = Date.parse(r.diff.time.start.dateTime)
  const to = Date.parse(r.diff.time.end.dateTime)
  const busy = await busyTimes(ctx, src, guests.map((g) => g.email), new Date(from), new Date(to), r.diff.time.start.timeZone)
  if (typeof busy === 'string') return null
  // The event's current slot is the event itself, not a conflict.
  const before = ex.original.timeOptions[0]
  const ignore = before && 'dateTime' in before.start && 'dateTime' in before.end ? { startMs: Date.parse(before.start.dateTime), endMs: Date.parse(before.end.dateTime) } : null
  const ev = await ctx.calendar.getEvent(ex.eventId).catch(() => null)
  const nameOf = (email: string): string => ev?.attendees?.find((a) => a.email?.toLowerCase() === email.toLowerCase())?.displayName || email
  return {
    checked: busy.filter((b) => b.known).length,
    unknown: busy.filter((b) => !b.known).map((b) => b.email),
    conflicts: busy.filter((b) => b.known && overlaps(without(b.busy, ignore), from, to)).map((b) => ({ email: b.email, name: nameOf(b.email) }))
  }
}

/** Whether a draft writes to a Microsoft calendar: an edit's own account, else the default "Add to". */
async function writesToMicrosoft(ctx: MainContext, d: CalendarEventDraft): Promise<boolean> {
  if (d.existingEvent) return d.existingEvent.calendarId.startsWith('microsoft:')
  const t = await resolveTarget(ctx, undefined).catch(() => null)
  return !!t && !('error' in t) && t.provider === 'microsoft'
}

/** An edit's current length, for a time the tool gave without an end. */
async function editLength(ctx: MainContext, args: Record<string, unknown>): Promise<{ length?: { ms: number } | { days: number } }> {
  const id = obj(args['fromEvent'])['eventId']
  if (typeof id !== 'string' || !id) return {}
  const ev = await ctx.calendar.getEvent(id).catch(() => null)
  if (!ev) return {}
  if (ev.start?.date && ev.end?.date) return { length: { days: Math.max(1, Math.round((Date.parse(ev.end.date) - Date.parse(ev.start.date)) / 86_400_000)) } }
  const ms = Date.parse(String(ev.end?.dateTime ?? '')) - Date.parse(String(ev.start?.dateTime ?? ''))
  return ms > 0 ? { length: { ms } } : {}
}

const REPLY_WORDS: Record<InviteResponse, string> = { accepted: 'Going', tentative: 'Maybe', declined: 'Not going' }

/** "Thu, Oct 22, 10:00 AM – 10:30 AM" in the user's zone (all-day: the date). */
function eventWhen(ev: CalendarEvent): string {
  if (ev.start?.date) return new Date(`${ev.start.date}T12:00:00Z`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })
  const s = new Date(String(ev.start?.dateTime ?? ''))
  const e = new Date(String(ev.end?.dateTime ?? ''))
  if (Number.isNaN(s.getTime())) return ''
  const day = s.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
  const clock = (d: Date): string => d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
  return Number.isNaN(e.getTime()) ? `${day}, ${clock(s)}` : `${day}, ${clock(s)} – ${clock(e)}`
}

/** "Oct 22". */
function eventDay(ev: CalendarEvent): string {
  if (ev.start?.date) return new Date(`${ev.start.date}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' })
  const s = new Date(String(ev.start?.dateTime ?? ''))
  return Number.isNaN(s.getTime()) ? 'that day' : s.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/** The synced event a reply or cancel acts on, or why it can't run (checked before the approval card too). */
async function eventProblem(ctx: MainContext, name: string, args: Record<string, unknown>): Promise<{ event: CalendarEvent } | string> {
  const id = typeof args['event_id'] === 'string' ? args['event_id'] : ''
  const event = id ? await ctx.calendar.getEvent(id).catch(() => null) : null
  if (!event) return 'That event isn’t in your synced calendar. Search the calendar again and use its id.'
  const ref = eventRef(event)
  if (!ref) return 'Calendar feeds are read-only, so this event can’t be changed from Notula.'
  const source = (await oauthSources(ctx)).find((s) => s.id === ref.sourceId)
  if (!source?.grants.includes('calendar-write')) return NEED_WRITE
  if (name === REPLY_TOOL) {
    if (!['accepted', 'tentative', 'declined'].includes(String(args['response']))) return 'Answer with accepted, tentative or declined.'
    if (typeof args['note'] === 'string' && args['note'].length > 500) return 'Keep the note to 500 characters.'
    const refusal = respondRefusal(event)
    if (refusal) return refusal
  }
  return { event }
}

async function runEventChange(ctx: MainContext, name: string, args: Record<string, unknown>): Promise<ChatToolResult> {
  const r = await eventProblem(ctx, name, args)
  if (typeof r === 'string') return { content: r, isError: true }
  const out =
    name === REPLY_TOOL
      ? await respondToInvite(ctx, r.event, args['response'] as InviteResponse, args['scope'] === 'series' ? 'series' : 'occurrence', typeof args['note'] === 'string' ? args['note'].slice(0, 500) : undefined)
      : await cancelEvent(ctx, r.event, args['scope'] === 'following' ? 'following' : 'occurrence', args['tellGuests'] !== false)
  if (out.status !== 'updated') return { content: out.error ?? COPY.other, isError: true }
  const notice = typeof out.fields?.['notice'] === 'string' ? out.fields['notice'] : null
  return {
    content: JSON.stringify(name === REPLY_TOOL ? { replied: true, response: args['response'] } : { cancelled: true, ...(notice ? { notice } : {}) }),
    data: { done: true, ...(notice ? { notice } : {}) },
    isError: false
  }
}

export function registerCalendarWrite(ctx: MainContext): void {
  registerBlockType({
    type: 'calendar_event',
    normalize: normalizeDraft,
    inProgress: 'creating',
    idempotent: true,
    execute: (block, options) => executeDraft(ctx, block, options.targetSourceId)
  })

  ipcMain.handle('calendar:event-colors' satisfies InvokeChannel, async (_e, req: InvokeReq<'calendar:event-colors'>): Promise<InvokeRes<'calendar:event-colors'>> => {
    const id = obj(req)['sourceId']
    if (typeof id !== 'string' || !id) throw notulaError('invalid-input', 'sourceId is required')
    return eventColors(ctx, id)
  })

  ipcMain.handle('calendar:set-grant' satisfies InvokeChannel, async (_e, req: InvokeReq<'calendar:set-grant'>): Promise<InvokeRes<'calendar:set-grant'>> => {
    const r = obj(req)
    if (typeof r['sourceId'] !== 'string' || !r['sourceId']) throw notulaError('invalid-input', 'sourceId is required')
    if (!GRANTS.includes(r['grant'] as CalendarGrant)) throw notulaError('invalid-input', 'Unknown permission')
    if (typeof r['enabled'] !== 'boolean') throw notulaError('invalid-input', 'enabled is required')
    return ctx.calendar.setGrant(r['sourceId'], r['grant'] as CalendarGrant, r['enabled'])
  })

  ctx.chat.registerToolProvider({
    id: 'calendar-write',
    async tools(): Promise<ChatToolSpec[]> {
      if (!(await ctx.settings.get('calendarWrite.enabled'))) return []
      if (await egressBlocked(ctx, { kind: 'calendar' })) return []
      if (!(await oauthSources(ctx)).length) return []
      return [
        {
          def: {
            name: DRAFT_TOOL,
            description:
              'Drafts a new calendar event, or a change to an existing one, for the user to review: title, one to three proposed times, attendees, video link, location, description, repeat rule, color and visibility. ' +
              'For a repeating event, a change can cover one occurrence, the whole series, or this occurrence and the later ones. ' +
              'Nothing is written until the user confirms it on the card this shows, so draft it as soon as the request is clear.',
            inputSchema: DRAFT_SCHEMA as unknown as ChatToolSpec['def']['inputSchema']
          },
          category: 'calendar',
          needsApproval: false,
          readOnly: true,
          title: 'Calendar draft'
        },
        ...AVAILABILITY_SPECS,
        {
          def: {
            name: REPLY_TOOL,
            description:
              "Answers an invitation for the user: going, maybe or not going, for one occurrence or the whole series, optionally with a short note to the organizer. The user approves it on a card before anything is sent.",
            inputSchema: {
              type: 'object',
              properties: {
                calendar_id: { type: 'string', description: 'The calendarId from a calendar search.' },
                event_id: { type: 'string', description: 'The event id from a calendar search.' },
                response: { type: 'string', enum: ['accepted', 'tentative', 'declined'] },
                scope: { type: 'string', enum: ['occurrence', 'series'], description: 'Default occurrence.' },
                note: { type: 'string', maxLength: 500, description: 'A short note for the organizer.' }
              },
              required: ['calendar_id', 'event_id', 'response'],
              additionalProperties: false
            }
          },
          category: 'calendar',
          needsApproval: true,
          readOnly: false,
          title: 'Reply to an invitation'
        },
        {
          def: {
            name: CANCEL_TOOL,
            description:
              'Cancels an event the user owns: one occurrence, or this occurrence and the later ones of a series. Guests get a cancellation unless tellGuests is false. The user approves it on a card first.',
            inputSchema: {
              type: 'object',
              properties: {
                calendar_id: { type: 'string', description: 'The calendarId from a calendar search.' },
                event_id: { type: 'string', description: 'The event id from a calendar search.' },
                scope: { type: 'string', enum: ['occurrence', 'following'], description: 'Default occurrence.' },
                tellGuests: { type: 'boolean', description: 'Default true.' }
              },
              required: ['calendar_id', 'event_id'],
              additionalProperties: false
            }
          },
          category: 'calendar',
          needsApproval: true,
          readOnly: false,
          title: 'Cancel an event'
        }
      ]
    },
    check: (name, args) => (name === REPLY_TOOL || name === CANCEL_TOOL ? eventProblem(ctx, name, args).then((r) => (typeof r === 'string' ? r : null)) : Promise.resolve(null)),
    async preview(name, args) {
      const r = await eventProblem(ctx, name, args)
      if (typeof r === 'string') return null
      const title = r.event.summary?.trim() || 'Untitled event'
      const when = eventWhen(r.event)
      if (name === REPLY_TOOL) {
        const answer = REPLY_WORDS[args['response'] as InviteResponse] ?? 'Going'
        const note = typeof args['note'] === 'string' ? args['note'].trim() : ''
        return { title: `Reply “${answer}” to “${title}”?`, lines: [when, ...(args['scope'] === 'series' ? ['Every occurrence'] : []), ...(note ? [`“${note}”`] : [])] }
      }
      if (name === CANCEL_TOOL) {
        const day = eventDay(r.event)
        const following = args['scope'] === 'following' && typeof r.event['recurringEventId'] === 'string'
        return {
          title: following ? `Cancel “${title}” from ${day} on?` : `Cancel “${title}” on ${day}?`,
          lines: [when, args['tellGuests'] === false ? 'Guests won’t be told.' : 'Guests will get a cancellation.']
        }
      }
      return null
    },
    async run(name, args, opts) {
      if (!(await ctx.settings.get('calendarWrite.enabled'))) return { content: 'Creating calendar events is turned off.', isError: true }
      if (name === AVAILABILITY_TOOL) return runCheckAvailability(ctx, args)
      if (name === PERSON_CALENDAR_TOOL) return runReadPersonCalendar(ctx, args)
      if (name === REPLY_TOOL || name === CANCEL_TOOL) return runEventChange(ctx, name, args)
      if (name !== DRAFT_TOOL) return { content: `Unknown tool ${name}.`, isError: true }
      let draft: CalendarEventDraft
      try {
        draft = normalizeDraft(args, { tool: true, ...(await editLength(ctx, args)) })
      } catch (err) {
        return { content: err instanceof Error ? err.message.replace(/^[a-z-]+: /, '') : 'Invalid draft.', isError: true }
      }
      if (draft.eventType !== 'default') return { content: NOT_AVAILABLE, isError: true }
      const full = await withExisting(ctx, draft)
      if (typeof full === 'string') return { content: full, isError: true }
      // Microsoft calendars have no event colors: the draft drops it, and the result says so.
      const noColor = full.colorId !== undefined && (await writesToMicrosoft(ctx, full))
      if (noColor) delete full.colorId
      const invalid = validateDraft(full)
      if (invalid) return { content: invalid, isError: true }
      if (full.existingEvent) {
        const r = diffDraft(full)
        if ('refusal' in r && r.refusal !== NO_CHANGE) return { content: r.refusal, isError: true }
      }
      const block = await blockStore().create({ type: 'calendar_event', threadId: opts.threadId, content: full })
      const busy = await conflicts(ctx, full).catch(() => [] as string[][])
      const availability = await moveAvailability(ctx, full).catch(() => null)
      return {
        content: JSON.stringify({
          draft: { ...full, blockId: block.id },
          conflicts: busy,
          ...(availability ? { guestAvailability: availability } : {}),
          ...(noColor ? { colorNote: 'Color isn’t available for Microsoft calendars, so the event keeps its calendar’s color.' } : {}),
          note: 'The draft is shown to the user as a card, where they can adjust it and create the event. It has not been created: do not say it was. Mention any conflicts briefly.'
        }),
        data: { blockId: block.id, conflicts: busy, ...(availability ? { availability } : {}) },
        isError: false
      }
    }
  })
}
