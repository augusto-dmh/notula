// SPDX-License-Identifier: Apache-2.0
// Note tools: fetchMeetings, the people-and-companies search, exploreMeetings, screen
// captures, event notes (two ✱ writes), action items and the prep brief. exploreMeetings rows
// carry the note's source (a video or lesson) when it has one.

import type { ActionItem } from '@shared/types/action-items'
import type { CalendarEvent, NoteListItem } from '@shared/types/notes'
import { peopleForNote } from '@shared/lib/people'
import type { MainContext } from '../context'
import { attendeesOf, docRef, folders, loadPayload, noteTitle, noteWhen, type PayloadSource } from './library'
import { appendToNote, replaceInNote, UNSEEDED_MESSAGE } from './note-doc'
import { queryTerms } from './text'
import {
  allNotes,
  bound,
  fail,
  ftsNotes,
  inRange,
  okJson,
  parseDate,
  peopleText,
  P2_TOOLS,
  startOfDay,
  type LocalTool
} from './tools'

const DAY_MS = 86_400_000
const always = (): boolean => true

const RANGES = ['today', 'yesterday', 'this_week', 'last_week', 'past_month', 'past_quarter', 'custom'] as const

const stringOrList = (what: string): Record<string, unknown> => ({
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' }, maxItems: 20 }],
  description: what
})

function list(v: unknown): string[] {
  const raw = typeof v === 'string' ? [v] : Array.isArray(v) ? v : []
  return [...new Set(raw.filter((x): x is string => typeof x === 'string').map((x) => x.trim()).filter(Boolean))]
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

async function myContext(ctx: MainContext): Promise<{ myEmails: string[]; genericDomains: string[] }> {
  const [myEmails, genericDomains] = await Promise.all([
    ctx.calendar.myEmails().catch(() => [] as string[]),
    ctx.settings.get('people.genericEmailDomains').catch(() => [] as string[])
  ])
  return { myEmails, genericDomains }
}

/** Note ids of the companies that match a name or a domain (the people derivation). */
async function companyNoteIds(ctx: MainContext, query: string): Promise<Set<string>> {
  const me = await myContext(ctx)
  const q = query.toLowerCase().replace(/^@/, '')
  const rows = await ctx.storage.listCompanies({ filter: 'all', query: q, ...me }).catch(() => [])
  const ids = new Set<string>()
  for (const row of rows) {
    if (row.domain !== q && !row.domain.startsWith(`${q}.`) && row.name.toLowerCase() !== q && !row.domain.includes(q)) continue
    const detail = await ctx.storage.getCompany(row.domain, me).catch(() => null)
    for (const id of detail?.noteIds ?? []) ids.add(id)
  }
  return ids
}

// ---------- fetchMeetings ----------

const listMeetingsTool = P2_TOOLS.find((t) => t.def.name === 'listMeetings') as LocalTool

const fetchMeetings: LocalTool = {
  ...listMeetingsTool,
  def: { ...listMeetingsTool.def, name: 'fetchMeetings', description: `Same as listMeetings. ${listMeetingsTool.def.description}` },
  title: 'Fetch meetings',
  run: (args, env) => listMeetingsTool.run(args, env)
}

// ---------- findMeetingsWithPeopleOrCompanies ----------

const searchByPeopleAndCompanies: LocalTool = {
  def: {
    name: 'findMeetingsWithPeopleOrCompanies',
    description:
      'Finds the meetings held with given people or companies, newest first. ' +
      'People can be names or email addresses, companies names or email domains; give at least one.',
    inputSchema: {
      type: 'object',
      properties: {
        people: stringOrList('One person or several, as names or email addresses.'),
        companies: stringOrList('One company or several, as names or email domains.'),
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many meetings to return at most (default 20).' },
        include_shared: { type: 'boolean', description: 'Also include notes that other people shared with the user.' },
        from_date: { type: 'string', description: 'Earliest meeting date, as an ISO 8601 date.' },
        to_date: { type: 'string', description: 'Latest meeting date, as an ISO 8601 date.' }
      },
      additionalProperties: false
    }
  },
  category: 'search',
  title: 'Search meetings by people and companies',
  needsApproval: false,
  readOnly: true,
  available: always,
  validate: (args) => (list(args['people']).length + list(args['companies']).length === 0 ? 'Give at least one of people or companies.' : null),
  run: async (args, env) => {
    const people = list(args['people']).map((p) => p.toLowerCase())
    const companies = list(args['companies'])
    const from = parseDate(args['from_date'], false)
    const to = parseDate(args['to_date'], true)
    const notes = (await allNotes(env.ctx)).filter((n) => inRange(n, from, to))
    const companyHits = await Promise.all(companies.map((c) => companyNoteIds(env.ctx, c)))
    const scored = notes
      .map((n) => {
        const text = peopleText(n)
        let score = people.filter((p) => text.includes(p)).length
        for (const [i, c] of companies.entries()) {
          if (companyHits[i]?.has(n.id) || text.includes(c.toLowerCase())) score++
        }
        return { n, score }
      })
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || noteWhen(b.n).localeCompare(noteWhen(a.n)))
      .slice(0, bound(args['limit'], 30, 100))
    for (const { n } of scored) env.scanned.set(n.id, docRef(n))
    return okJson({ meetings: scored.map(({ n, score }) => ({ id: n.id, title: noteTitle(n), created_at: noteWhen(n), score })) })
  }
}

// ---------- exploreMeetings ----------

function rangeBounds(range: string, start: unknown, end: unknown): { from: Date | null; to: Date | null } {
  const now = new Date()
  const today = startOfDay(now)
  const week = new Date(today.getTime() - ((today.getDay() + 6) % 7) * DAY_MS)
  switch (range) {
    case 'today':
      return { from: today, to: now }
    case 'yesterday':
      return { from: new Date(today.getTime() - DAY_MS), to: new Date(today.getTime() - 1) }
    case 'this_week':
      return { from: week, to: now }
    case 'last_week':
      return { from: new Date(week.getTime() - 7 * DAY_MS), to: new Date(week.getTime() - 1) }
    case 'past_quarter':
      return { from: new Date(now.getTime() - 90 * DAY_MS), to: now }
    case 'custom':
      return { from: parseDate(start, false), to: parseDate(end, true) }
    default:
      return { from: new Date(now.getTime() - 30 * DAY_MS), to: now }
  }
}

interface ExploreRow {
  id: string
  title: string
  participants: string[]
  attendeeNames: string[]
  noteHeaders: string[]
  noteLength: number
  createdAt: string
  meetingAt: string
  updatedAt: string
  matchScore: number
  /** The video or lesson the note came from, or null. */
  source: PayloadSource | null
}

async function exploreRow(ctx: MainContext, n: NoteListItem, score: number): Promise<ExploreRow> {
  const p = await loadPayload(ctx, n.id, { transcript: false })
  const body = `${p?.summary ?? ''}\n${p?.notes ?? ''}`
  const headers = body
    .split('\n')
    .map((l) => /^#{1,6}\s+(.+)$/.exec(l.trim())?.[1]?.trim() ?? '')
    .filter(Boolean)
    .slice(0, 8)
  const emails = [
    ...new Set(
      [...(n.people?.attendees ?? []).map((a) => a.email ?? ''), ...(n.linked_event?.attendees ?? []).map((a) => a.email)]
        .map((e) => e.trim().toLowerCase())
        .filter(Boolean)
    )
  ]
  return {
    id: n.id,
    title: noteTitle(n),
    participants: emails.slice(0, 20),
    attendeeNames: attendeesOf(n, 12),
    noteHeaders: headers,
    noteLength: body.trim().length,
    createdAt: n.created_at,
    meetingAt: noteWhen(n),
    updatedAt: n.updated_at,
    matchScore: score,
    source: p?.source ?? null
  }
}

const exploreMeetings: LocalTool = {
  def: {
    name: 'exploreMeetings',
    description:
      'Gathers candidate meetings for an open-ended question in one call, grouped by how they were found: by words, by people or companies, by folder and by time window. ' +
      'Give at least one seed. Read the most relevant results with readMeetings afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        base_terms: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Words or phrases to search for.' },
        base_people: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'People or companies to match, as names, email addresses or domains.' },
        base_folder_ids: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Folders whose notes to include, by id.' },
        base_period: { type: 'string', enum: [...RANGES], description: 'A time window to include; custom uses custom_start and custom_end.' },
        custom_start: { type: 'string', description: 'Start of the custom window, as an ISO 8601 date.' },
        custom_end: { type: 'string', description: 'End of the custom window, as an ISO 8601 date.' },
        scope: { type: 'string', enum: ['attended', 'all'], description: 'attended: only meetings the user was in; all: also notes shared with them.' },
        query: { type: 'string', description: 'The question in plain words; its significant words are searched too.' },
        terms: { type: 'array', items: { type: 'string' }, maxItems: 20, description: 'More words to search for (added to base_terms).' },
        folder_ids: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'More folders to include, by id (added to base_folder_ids).' },
        time_range: { type: 'string', enum: [...RANGES], description: 'Same as base_period.' },
        folder_id: { type: 'string', description: 'One more folder to include, by id.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'How many meetings to return per group at most (default 10).' }
      },
      additionalProperties: false
    }
  },
  category: 'search',
  title: 'Explore meetings',
  needsApproval: false,
  readOnly: true,
  renderInline: true,
  available: always,
  run: async (args, env) => {
    const limit = bound(args['limit'], 10, 50)
    const all = await allNotes(env.ctx)
    const byId = new Map(all.map((n) => [n.id, n]))
    const groups: Record<string, unknown>[] = []
    const coverageNotes: string[] = []
    let examined = 0
    let returned = 0
    const pack = async (rows: { n: NoteListItem; score: number }[]): Promise<{ results: ExploreRow[]; returned: number; totalAvailable: number }> => {
      const top = rows.slice(0, limit)
      const results: ExploreRow[] = []
      for (const r of top) {
        results.push(await exploreRow(env.ctx, r.n, r.score))
        env.scanned.set(r.n.id, docRef(r.n))
      }
      examined += rows.length
      returned += results.length
      return { results, returned: results.length, totalAvailable: rows.length }
    }

    const terms = [...list(args['base_terms']), ...list(args['terms']), ...queryTerms(str(args['query']))]
    if (terms.length) {
      const hits = await ftsNotes(env.ctx, terms)
      groups.push({ type: 'term_search', terms, ...(await pack(hits.map((n, i) => ({ n, score: hits.length - i })))) })
    }
    const entities = list(args['base_people'])
    if (entities.length) {
      const sets = await Promise.all(entities.map((e) => companyNoteIds(env.ctx, e)))
      const rows = all
        .map((n) => {
          const text = peopleText(n)
          const score = entities.filter((e, i) => text.includes(e.toLowerCase()) || sets[i]?.has(n.id)).length
          return { n, score }
        })
        .filter((r) => r.score > 0)
        .sort((a, b) => b.score - a.score || noteWhen(b.n).localeCompare(noteWhen(a.n)))
      groups.push({ type: 'entity_match', entities, ...(await pack(rows)) })
    }
    const folderIds = [...new Set([...list(args['base_folder_ids']), ...list(args['folder_ids']), ...list(args['folder_id'])])]
    if (folderIds.length) {
      const state = await folders(env.ctx)
      const ids = new Set(folderIds.flatMap((f) => state?.membership[f] ?? []))
      if (!state) coverageNotes.push('Folders are not available.')
      const rows = [...ids]
        .map((id) => byId.get(id))
        .filter((n): n is NoteListItem => !!n)
        .sort((a, b) => noteWhen(b).localeCompare(noteWhen(a)))
        .map((n) => ({ n, score: 1 }))
      groups.push({ type: 'folder', folder_ids: folderIds, ...(await pack(rows)) })
    }
    const range = str(args['base_period']) || str(args['time_range'])
    if (range) {
      const { from, to } = rangeBounds(range, args['custom_start'], args['custom_end'])
      const rows = all.filter((n) => inRange(n, from, to)).map((n) => ({ n, score: 1 }))
      groups.push({ type: 'date_range', time_range: range, from: from?.toISOString() ?? null, to: to?.toISOString() ?? null, ...(await pack(rows)) })
    }
    if (groups.length === 0) return fail('Give at least one seed: keywords, people or companies, folders, or a time range.')
    if (returned < examined) coverageNotes.push(`Showing up to ${limit} meetings per group; read more with readMeetings.`)
    return okJson({ groups, metadata: { totalExamined: examined, totalReturned: returned, coverageNotes } })
  }
}

// ---------- openAttachment ----------

const openAttachment: LocalTool = {
  def: {
    name: 'openAttachment',
    description: "Reads an attachment of a meeting (an image or a document the user added to the note) and returns its text or description.",
    inputSchema: {
      type: 'object',
      properties: {
        meeting_id: { type: 'string', description: 'The id of the meeting.' },
        attachment_id: { type: 'string', description: "The id of the attachment, as listed in the meeting's content." }
      },
      required: ['meeting_id', 'attachment_id'],
      additionalProperties: false
    }
  },
  category: 'notes',
  title: 'Read a screen capture',
  needsApproval: false,
  readOnly: true,
  available: (a) => a.captures,
  run: async (args, env) => {
    const meetingId = str(args['meeting_id']).toLowerCase()
    const attachmentId = str(args['attachment_id']).toLowerCase()
    const note = await env.ctx.storage.getNote(meetingId).catch(() => null)
    if (!note || note.deleted_at) return fail('That meeting was not found.')
    const a = (note.attachments ?? []).find((x) => x.id.toLowerCase() === attachmentId && x.screen_capture_info)
    if (!a?.screen_capture_info) return fail('That meeting has no screen capture with that id.')
    env.scanned.set(note.id, docRef(note))
    return okJson({
      meeting_id: note.id,
      attachment_id: a.id,
      captured_at: a.screen_capture_info.captured_at,
      description: a.screen_capture_info.description
    })
  }
}

// ---------- event notes ----------

const eventArgs = {
  event_id: { type: 'string', minLength: 1, maxLength: 1_024, description: 'The id of the calendar event.' },
  event_start: { type: 'string', description: "The event's start time, as an ISO 8601 date-time, exactly as the calendar returned it." }
}

async function eventOf(ctx: MainContext, eventId: string): Promise<CalendarEvent | null> {
  return (await ctx.calendar.getEvent(eventId).catch(() => null)) ?? (await ctx.storage.getCalendarEvent(eventId).catch(() => null))
}

function eventTitle(e: CalendarEvent | null): string {
  return e?.summary?.trim() || 'Untitled event'
}

async function eventNote(ctx: MainContext, eventId: string, start: string): Promise<Awaited<ReturnType<MainContext['storage']['findNoteByEvent']>>> {
  return ctx.storage.findNoteByEvent(eventId, start || undefined).catch(() => null)
}

function eventResult(note: { id: string; title: string | null; notes_md: string | null } | null, event: CalendarEvent | null, created: boolean): Record<string, unknown> {
  return {
    document_id: note?.id ?? null,
    title: note?.title?.trim() || eventTitle(event),
    notes: note?.notes_md ?? '',
    created
  }
}

const readEventNote: LocalTool = {
  def: {
    name: 'readEventNote',
    description: "Reads the notes the user prepared for an upcoming calendar event (the note linked to that event), if there are any.",
    inputSchema: { type: 'object', properties: eventArgs, required: ['event_id', 'event_start'], additionalProperties: false }
  },
  category: 'calendar',
  title: 'Read notes for an event',
  needsApproval: false,
  readOnly: true,
  available: (a) => a.calendar,
  run: async (args, env) => {
    const eventId = str(args['event_id'])
    const note = await eventNote(env.ctx, eventId, str(args['event_start']))
    if (note) env.scanned.set(note.id, docRef(note))
    return okJson(eventResult(note, await eventOf(env.ctx, eventId), false))
  }
}

function previewLines(markdown: string): string[] {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n').filter((l) => l.trim())
  return lines.length > 6 ? [...lines.slice(0, 6), '…'] : lines
}

const appendToEventNote: LocalTool = {
  def: {
    name: 'appendToEventNote',
    description:
      "Adds Markdown to the end of the user's notes for a calendar event, creating the note if the event has none yet. " +
      "Use it for agendas or prep the user asked for. Waits for the user's approval.",
    inputSchema: {
      type: 'object',
      properties: { ...eventArgs, markdown: { type: 'string', minLength: 1, description: 'The Markdown to add.' } },
      required: ['event_id', 'event_start', 'markdown'],
      additionalProperties: false
    }
  },
  category: 'calendar',
  title: 'Add to notes for an event',
  needsApproval: true,
  readOnly: false,
  available: (a) => a.calendar,
  preview: async (args, env) => ({
    title: `Add to notes for “${eventTitle(await eventOf(env.ctx, str(args['event_id'])))}”?`,
    lines: previewLines(String(args['markdown'] ?? ''))
  }),
  run: async (args, env) => {
    const ctx = env.ctx
    const eventId = str(args['event_id'])
    const start = str(args['event_start'])
    const markdown = String(args['markdown'] ?? '')
    if (!markdown.trim()) return fail('markdown is empty.')
    const event = await eventOf(ctx, eventId)
    let note = await eventNote(ctx, eventId, start)
    let created = false
    if (!note) {
      if (!event) return fail('That calendar event was not found.')
      // A note for the event, titled with its summary, with `people` filled.
      note = await ctx.storage.createNote({
        origin: 'chat_tool',
        title: event.summary?.trim() || null,
        calendarEvent: event,
        transcribe: false,
        created_via: 'chat_tool'
      })
      const all = await ctx.settings.getAll()
      const people = peopleForNote({
        event,
        profile: { name: all['profile.name'].trim(), email: all['profile.email'].trim() },
        myEmails: await ctx.calendar.myEmails().catch(() => [all['profile.email']])
      })
      note = await ctx.storage.updateNote(note.id, { people })
      created = true
    }
    const r = await appendToNote(ctx, note.id, markdown)
    if (r === 'unseeded') return fail(UNSEEDED_MESSAGE)
    if (r === 'empty') return fail('markdown has no content.')
    const fresh = (await ctx.storage.getNote(note.id).catch(() => null)) ?? note
    env.scanned.set(fresh.id, docRef(fresh))
    return okJson(eventResult(fresh, event, created))
  }
}

const editEventNote: LocalTool = {
  def: {
    name: 'editEventNote',
    description:
      "Changes the user's notes for a calendar event by replacing one exact passage. " +
      'find_text must be copied character for character from the notes (read them first with readEventNote) ' +
      "and occur once. Waits for the user's approval.",
    inputSchema: {
      type: 'object',
      properties: {
        ...eventArgs,
        find_text: { type: 'string', minLength: 1, description: 'The exact passage to replace.' },
        replacement_text: { type: 'string', description: 'The text that takes its place; empty to delete the passage.' }
      },
      required: ['event_id', 'event_start', 'find_text', 'replacement_text'],
      additionalProperties: false
    }
  },
  category: 'calendar',
  title: 'Edit notes for an event',
  needsApproval: true,
  readOnly: false,
  available: (a) => a.calendar,
  preview: async (args, env) => ({
    title: `Edit notes for “${eventTitle(await eventOf(env.ctx, str(args['event_id'])))}”?`,
    lines: [],
    replace: { before: String(args['find_text'] ?? ''), after: String(args['replacement_text'] ?? '') }
  }),
  run: async (args, env) => {
    const eventId = str(args['event_id'])
    const note = await eventNote(env.ctx, eventId, str(args['event_start']))
    if (!note) return fail('There are no notes for that event yet. Use appendToEventNote to start them.')
    const r = await replaceInNote(env.ctx, note.id, String(args['find_text'] ?? ''), String(args['replacement_text'] ?? ''))
    if (r === 'unseeded') return fail(UNSEEDED_MESSAGE)
    if (r === 'multi-block') return fail('Copy a passage from a single paragraph or list item, without line breaks.')
    if (r === 'not-found') return fail('The text to replace was not found in those notes. Copy it exactly from readEventNote and try again.')
    const fresh = (await env.ctx.storage.getNote(note.id).catch(() => null)) ?? note
    env.scanned.set(fresh.id, docRef(fresh))
    return okJson(eventResult(fresh, await eventOf(env.ctx, eventId), false))
  }
}

// ---------- action items ----------

async function actionItemRows(ctx: MainContext, items: ActionItem[]): Promise<Record<string, unknown>[]> {
  const ids = [...new Set(items.map((i) => i.sourceNoteId).filter((id): id is string => !!id))]
  const notes = ids.length ? await ctx.storage.queryNotes({ ids }).catch(() => [] as NoteListItem[]) : []
  const titles = new Map(notes.map((n) => [n.id, noteTitle(n)]))
  return items.map((i) => ({
    id: i.id,
    intent: i.intent,
    detail: i.detail,
    status: i.status,
    attribution: i.attribution.map((a) => a.name),
    sourceNoteId: i.sourceNoteId,
    sourceTitle: i.sourceNoteId ? (titles.get(i.sourceNoteId) ?? null) : null,
    createdAt: i.createdAt,
    archivedAt: i.archivedAt,
    reviewStatus: i.reviewStatus
  }))
}

const getActionItems: LocalTool = {
  def: {
    name: 'list_todos',
    description: "Returns the user's action items (to-dos found in their meetings), newest first, with ids, owners and the meeting each came from.",
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many items to return at most (default 20).' },
        created_after: { type: 'string', description: 'Only items created on or after this date (ISO 8601).' },
        created_before: { type: 'string', description: 'Only items created on or before this date (ISO 8601).' },
        include_archived: { type: 'boolean', description: 'Also return items the user completed or archived.' }
      },
      additionalProperties: false
    }
  },
  category: 'notes',
  title: 'Get action items',
  needsApproval: false,
  readOnly: true,
  available: (a) => a.settings['actionItems.enabled'] === true,
  run: async (args, env) => {
    const after = parseDate(args['created_after'], false)
    const before = parseDate(args['created_before'], true)
    const items = await env.ctx.storage.listActionItems({
      includeArchived: args['include_archived'] === true,
      limit: bound(args['limit'], 20, 100),
      ...(after ? { createdAfter: after.toISOString() } : {}),
      ...(before ? { createdBefore: before.toISOString() } : {})
    })
    for (const i of items) if (i.sourceNoteId) env.scanned.set(i.sourceNoteId, { id: i.sourceNoteId, title: '' })
    return okJson({ items: await actionItemRows(env.ctx, items) })
  }
}

const renderActionItems: LocalTool = {
  def: {
    name: 'show_todo_cards',
    description: 'Shows the given action items to the user as interactive cards in your answer (they can tick them off there). Use ids from list_todos.',
    inputSchema: {
      type: 'object',
      properties: { todo_ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 } },
      required: ['todo_ids'],
      additionalProperties: false
    }
  },
  category: 'notes',
  title: 'Show action items',
  needsApproval: false,
  readOnly: true,
  renderInline: true,
  available: (a) => a.settings['actionItems.enabled'] === true,
  run: async (args, env) => {
    const ids = list(args['todo_ids']).map((id) => id.toLowerCase())
    const items = await env.ctx.storage.listActionItems({ ids, includeArchived: true })
    return okJson({ items: await actionItemRows(env.ctx, items) })
  }
}

// ---------- readPrepBrief ----------

const readPrepBrief: LocalTool = {
  def: {
    name: 'readPrepBrief',
    description: "Returns the prep brief prepared for the meeting the user is in or about to join, if there is one.",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  category: 'calendar',
  title: 'Read the prep brief',
  needsApproval: false,
  readOnly: true,
  available: (a) => a.brief && a.settings['prepBrief.enabled'] === true,
  run: async (_args, env) => {
    const note = env.noteId ? await env.ctx.storage.getNote(env.noteId).catch(() => null) : null
    const brief = note?.event_id ? await env.ctx.storage.getBrief(note.event_id).catch(() => null) : null
    if (!brief || brief.status !== 'completed') return fail('This meeting has no completed brief.')
    return okJson({
      briefId: brief.id,
      content: brief.content ?? '',
      shortBrief: brief.headline,
      references: brief.brief_sources,
      createdAt: brief.created_at,
      updatedAt: brief.updated_at
    })
  }
}

export const NOTE_TOOLS_P3: readonly LocalTool[] = [
  fetchMeetings,
  searchByPeopleAndCompanies,
  exploreMeetings,
  openAttachment,
  readEventNote,
  appendToEventNote,
  editEventNote,
  getActionItems,
  renderActionItems,
  readPrepBrief
]
