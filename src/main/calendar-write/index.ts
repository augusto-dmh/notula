// SPDX-License-Identifier: Apache-2.0
// Calendar writes: `calendar:set-grant`, the
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
import type { ChatToolSpec } from '../chat/tool-api'
import { chosenTime, draftFromEvent, NOT_AVAILABLE, normalizeDraft, validateDraft } from './draft'
import { COPY, googleCreate, googleUpdate, graphCreate, graphUpdate, type WriteTarget } from './providers'

export const DRAFT_TOOL = 'proposeEvent'
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
  const t = await resolveTarget(ctx, fromSource ?? targetSourceId)
  if ('error' in t) return t.error
  let token: string
  try {
    token = await ctx.calendar.accessToken(t.sourceId, 'calendar-write')
  } catch (err) {
    const code = err instanceof Error && /missing_scopes/.test(err.message) ? 'missing_scopes' : 'missing_token'
    return { status: 'failed', errorCode: code, error: code === 'missing_scopes' ? COPY.missingScopes : COPY.reconnect }
  }
  const edit = d.existingEvent ? { ...d.existingEvent, eventId: d.existingEvent.eventId.split(':').slice(2).join(':') || d.existingEvent.eventId } : undefined
  const draft = edit ? { ...d, existingEvent: edit } : d
  const out =
    t.provider === 'google'
      ? edit
        ? await googleUpdate(ctx, token, t, draft)
        : await googleCreate(ctx, token, t, draft, block.id)
      : edit
        ? await graphUpdate(ctx, token, t, draft)
        : await graphCreate(ctx, token, t, draft, block.id)
  if (out.status === 'created' || out.status === 'updated') {
    lastTarget = t.sourceId
    ctx.calendar.refreshSource(t.sourceId)
    out.fields = { ...out.fields, sourceId: t.sourceId, provider: t.provider }
  }
  log('info', 'calendar-write:result', { provider: t.provider, update: !!edit, status: out.status, code: out.errorCode ?? null })
  return out
}

// ---------- the tool ----------

const TIME_SCHEMA = {
  type: 'object',
  description: 'Timed: {dateTime (ISO 8601 with offset), timeZone (IANA)}. All-day: {date (YYYY-MM-DD, end exclusive)}.',
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
      description: 'One to three proposed times, all in the same time zone. A repeating event has exactly one (its first occurrence).',
      items: { type: 'object', properties: { start: TIME_SCHEMA, end: TIME_SCHEMA }, required: ['start', 'end'], additionalProperties: false }
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
      description: 'New events only: one RRULE line, e.g. "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;COUNT=5".'
    },
    fromEvent: {
      type: 'object',
      description: 'To change an existing event: its calendarId and id from a calendar search, and scope occurrence or series.',
      properties: { calendarId: { type: 'string' }, eventId: { type: 'string' }, scope: { type: 'string', enum: ['occurrence', 'series'] } },
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

/** `fromEvent` → the update's `existingEvent`, from the synced copy of the event. */
async function withExisting(ctx: MainContext, d: CalendarEventDraft): Promise<CalendarEventDraft | string> {
  if (!d.fromEvent) return d
  const ev = await ctx.calendar.getEvent(d.fromEvent.eventId)
  if (!ev) return 'That event isn’t in your synced calendar. Search the calendar again and use its id.'
  const calendarId = typeof ev['calendarId'] === 'string' ? ev['calendarId'] : d.fromEvent.calendarId
  if (!/^(google|microsoft):/.test(calendarId)) return 'Calendar feeds are read-only, so this event can’t be changed from Notula.'
  if (d.recurrenceRules?.length) return 'Repeat settings can’t be changed from Notula.'
  const original = draftFromEvent(ev, await ctx.calendar.myEmails())
  return {
    ...d,
    existingEvent: { calendarId, eventId: ev.id, scope: d.fromEvent.scope, etag: typeof ev['etag'] === 'string' ? ev['etag'] : '', original }
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
              'Drafts a calendar event for the user to review: title, one to three proposed times, attendees, video link, location and description. Nothing is created until the user confirms it on the card this shows, so draft it as soon as the request is clear.',
            inputSchema: DRAFT_SCHEMA as unknown as ChatToolSpec['def']['inputSchema']
          },
          category: 'calendar',
          needsApproval: false,
          readOnly: true,
          title: 'Calendar draft'
        }
      ]
    },
    async run(name, args, opts) {
      if (name !== DRAFT_TOOL) return { content: `Unknown tool ${name}.`, isError: true }
      if (!(await ctx.settings.get('calendarWrite.enabled'))) return { content: 'Creating calendar events is turned off.', isError: true }
      let draft: CalendarEventDraft
      try {
        draft = normalizeDraft(args)
      } catch (err) {
        return { content: err instanceof Error ? err.message.replace(/^[a-z-]+: /, '') : 'Invalid draft.', isError: true }
      }
      if (draft.eventType !== 'default') return { content: NOT_AVAILABLE, isError: true }
      const full = await withExisting(ctx, draft)
      if (typeof full === 'string') return { content: full, isError: true }
      const invalid = validateDraft(full)
      if (invalid) return { content: invalid, isError: true }
      const block = await blockStore().create({ type: 'calendar_event', threadId: opts.threadId, content: full })
      const busy = await conflicts(ctx, full).catch(() => [] as string[][])
      return {
        content: JSON.stringify({
          draft: { ...full, blockId: block.id },
          conflicts: busy,
          note: 'The draft is shown to the user as a card, where they can adjust it and create the event. It has not been created: do not say it was. Mention any conflicts briefly.'
        }),
        data: { blockId: block.id, conflicts: busy },
        isError: false
      }
    }
  })
}
