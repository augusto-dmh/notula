// SPDX-License-Identifier: Apache-2.0
// The chat tools' framework and the core tools, run locally in main against the user's own
// notes. Results stay on this machine: only the model call leaves it, and with a local model
// nothing does.
//
// Every local tool is a `LocalTool` with its category,
// approval rule and availability rule; the agentic tools live in tools-*.ts and the registry
// (registry.ts) assembles one answer's set.

import { app } from 'electron'
import { parseError } from '@shared/errors'
import { CHAT_LIMITS, type ChatPlace, type ChatToolCategory, type DocRef } from '@shared/types/chat'
import type { NoteListItem } from '@shared/types/notes'
import type { Settings } from '@shared/types/settings'
import { speakerTurns } from '@shared/lib/speakers'
import type { MainContext } from '../context'
import type { LlmToolDef } from '../llm/types'
import { log } from '../log'
import { readerTranscript } from '../sources/reader'
import { transcriptionControl } from '../transcription'
import { attendeesOf, docRef, folders, loadPayload, noteTitle, noteWhen, renderPayload, type PayloadSource } from './library'
import { shortDate } from './text'
import { fitTranscript, renderWindow, transcriptWindows, type TranscriptWindow } from './windows'

export const LIBRARY_TOOLS = [
  'getCurrentTime',
  'findMeetingsByTerms',
  'findMeetingsWithPeople',
  'gatherMeetingContext',
  'listMeetings',
  'getMeetings',
  'readMeetings',
  'readTranscript'
] as const
export const NOTE_TOOLS = ['editNote', 'rewriteNote'] as const
/** Dev builds only, with `NOTULA_DEV_CHAT_APPROVAL_FIXTURE=1`: a tool that waits for the user's approval. */
export const APPROVAL_FIXTURE_TOOL = 'devApprovalFixture'

const DAY_MS = 86_400_000

type JsonSchema = LlmToolDef['inputSchema']

const isoDateProp = (what: string): Record<string, unknown> => ({
  type: 'string',
  description: `${what}, as an ISO 8601 date (YYYY-MM-DD).`
})

const DEFS: Record<string, LlmToolDef> = {
  getCurrentTime: {
    name: 'getCurrentTime',
    description: "Returns the current date, time and time zone. Use it to resolve relative dates such as \"last Tuesday\" or \"next week\".",
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  findMeetingsByTerms: {
    name: 'findMeetingsByTerms',
    description:
      "Full-text search over the user's meetings (titles, notes, summaries and transcripts). Returns matching meetings with their ids, titles and dates, newest first. " +
      'Pass the distinctive words of the question, including likely synonyms, as separate keywords.',
    inputSchema: {
      type: 'object',
      properties: {
        keywords: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10, description: 'Words or short phrases to look for; a meeting matches when it contains any of them.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many meetings to return at most (default 20).' },
        includeShared: { type: 'boolean', description: 'Also search notes that other people shared with the user.' },
        startDate: isoDateProp('Earliest meeting date'),
        endDate: isoDateProp('Latest meeting date')
      },
      required: ['keywords'],
      additionalProperties: false
    }
  },
  findMeetingsWithPeople: {
    name: 'findMeetingsWithPeople',
    description:
      'Finds meetings attended by given people or companies, newest first. ' +
      'Give names or email addresses for people, and names or email domains for companies; at least one of the two.',
    inputSchema: {
      type: 'object',
      properties: {
        people: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'People to match, as names or email addresses.' },
        companies: { type: 'array', items: { type: 'string' }, maxItems: 10, description: 'Companies to match, as names or email domains (for example acme.com).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'How many meetings to return at most (default 20).' },
        includeShared: { type: 'boolean', description: 'Also include notes that other people shared with the user.' },
        startDate: isoDateProp('Earliest meeting date'),
        endDate: isoDateProp('Latest meeting date')
      },
      additionalProperties: false
    }
  },
  gatherMeetingContext: {
    name: 'gatherMeetingContext',
    description: "Loads the summaries of every meeting in a time window, for questions about a period (\"what happened this week\", \"recap my last month\").",
    inputSchema: {
      type: 'object',
      properties: {
        range: {
          type: 'string',
          enum: ['today', 'yesterday', 'this_week', 'last_week', 'past_month', 'past_quarter', 'custom'],
          description: 'The time window. Use custom with startDate and endDate for anything else.'
        },
        startDate: isoDateProp('First day of the custom window'),
        endDate: isoDateProp('Last day of the custom window'),
        limit: { type: 'integer', minimum: 1, maximum: 150, description: 'How many meetings to load at most (default 50).' },
        includeShared: { type: 'boolean', description: 'Also include notes that other people shared with the user.' }
      },
      additionalProperties: false
    }
  },
  listMeetings: {
    name: 'listMeetings',
    description:
      "Lists the user's meetings by title, folder, participant or date, newest first, without their content. " +
      'Use it to find candidates, then readMeetings for what they say.',
    inputSchema: {
      type: 'object',
      properties: {
        keyword: { type: 'string', description: 'Only meetings whose title contains this text.' },
        scope: { type: 'string', enum: ['owned', 'attended', 'all', 'folder'], description: 'owned: notes the user created; attended: meetings the user was in; all: both, plus notes shared with them; folder: the notes of folderId.' },
        folderId: { type: 'string', description: 'The folder whose notes to list, with scope folder.' },
        participant: { type: 'string', description: 'Only meetings with this participant (a name or an email address).' },
        startDate: isoDateProp('Earliest meeting date'),
        endDate: isoDateProp('Latest meeting date'),
        limit: { type: 'integer', minimum: 1, maximum: 150, description: 'How many meetings to return at most (default 50).' }
      },
      additionalProperties: false
    }
  },
  getMeetings: {
    name: 'getMeetings',
    description: 'Returns the title, date, participants and folders of the given meetings, without their content.',
    inputSchema: {
      type: 'object',
      properties: { meetingIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 50 } },
      required: ['meetingIds'],
      additionalProperties: false
    }
  },
  readMeetings: {
    name: 'readMeetings',
    description:
      "Reads the given meetings in full: the user's notes and the latest summary of each. Use it after a search or a listing to answer from the content. " +
      `Returns at most ${CHAT_LIMITS.readMeetingsChars.toLocaleString('en-US')} characters per meeting.`,
    inputSchema: {
      type: 'object',
      properties: { meetingIds: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 20 } },
      required: ['meetingIds'],
      additionalProperties: false
    }
  },
  readTranscript: {
    name: 'readTranscript',
    description:
      "Reads the transcript of one meeting, with speaker labels and the key of each passage for citations. With a query, returns the passages that match it first. " +
      `Returns at most ${CHAT_LIMITS.readTranscriptChars.toLocaleString('en-US')} characters.`,
    inputSchema: {
      type: 'object',
      properties: {
        meetingId: { type: 'string', description: 'The id of the meeting.' },
        query: { type: 'string', description: 'Words to look for in the transcript; leave it out to read from the start.' }
      },
      required: ['meetingId'],
      additionalProperties: false
    }
  },
  editNote: {
    name: 'editNote',
    description:
      'Edits the document the user is looking at (the summary or their notes) by replacing one exact passage. ' +
      'findText must be copied character for character from the document and occur in it once; ' +
      'make one call per separate change. To add text, replace a nearby passage with itself plus the new text.',
    inputSchema: {
      type: 'object',
      properties: {
        findText: { type: 'string', description: 'The exact passage to replace, copied from the document.' },
        newText: { type: 'string', description: "The text that takes its place, in the document's Markdown; empty to delete the passage." }
      },
      additionalProperties: false
    }
  },
  rewriteNote: {
    name: 'rewriteNote',
    description:
      'Regenerates the whole summary from the meeting following the given instructions, for changes too broad for editNote ' +
      '(another length, structure, focus or language). The new version replaces the summary the user is looking at.',
    inputSchema: {
      type: 'object',
      properties: { rewriteInstructions: { type: 'string', description: 'What to change, stated fully, for example: "Shorter, only decisions and next steps, in Spanish".' } },
      required: ['rewriteInstructions'],
      additionalProperties: false
    }
  },
  [APPROVAL_FIXTURE_TOOL]: {
    name: APPROVAL_FIXTURE_TOOL,
    description: "Development fixture: a harmless action that waits for the user's approval.",
    inputSchema: {
      type: 'object',
      properties: { action: { type: 'string', description: 'A short description of the pretend action.' } },
      required: ['action'],
      additionalProperties: false
    }
  }
}

export function approvalFixtureEnabled(): boolean {
  return !app.isPackaged && process.env['NOTULA_DEV_CHAT_APPROVAL_FIXTURE'] === '1'
}

// ---------- the local tool contract ----------

/** What decides which tools one answer is offered; computed once per answer (registry.ts). */
export interface ToolAvailability {
  place: ChatPlace
  /** The note of a one-note chat. */
  noteId: string | null
  /** A note editor is the target (editNote). */
  noteEdit: boolean
  /** The note has a summary to rewrite (rewriteNote). */
  rewrite: boolean
  settings: Settings
  /** At least one calendar source. */
  calendar: boolean
  /** One-note chat: the note has screen captures. Library chats: always (readMeetings lists them). */
  captures: boolean
  /** One-note chat: a completed brief exists for the note's event. */
  brief: boolean
  /** Folder files exist (the place's folder, or any folder for a library chat). */
  folderFiles: boolean
  /** The user has recipes to load as skills. */
  recipes: boolean
}

/** A tool Notula runs itself, in main. */
export interface LocalTool {
  def: LlmToolDef
  category: ChatToolCategory
  /** Short human title (the local MCP server lists it). */
  title: string
  /** ✱ tools and `askUser`. */
  needsApproval: boolean
  readOnly: boolean
  /** Rendered on its own, outside the thought group. */
  renderInline?: boolean
  available(a: ToolAvailability): boolean
  /** Checks beyond the schema subset; a problem goes back to the model as a tool error. */
  validate?(args: Record<string, unknown>): string | null
  run(args: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome>
  /** ✱ tools: what the approval card shows, resolved by main (titles of notes, folders, events). */
  preview?(args: Record<string, unknown>, env: ToolEnv): Promise<ApprovalPreview>
}

/** The approval card's facts, stored in the call's `result` while it waits. */
export interface ApprovalPreview {
  title: string
  /** Up to the first 6 lines of the markdown, or a location line. */
  lines: string[]
  /** editEventNote: the replaced and the new text. */
  replace?: { before: string; after: string }
  /** createFolder: the title the user may edit before approving. */
  editableTitle?: string
}

/** Validates `args` against the tool's schema subset, then its own rule. */
export function validateLocal(tool: LocalTool, args: Record<string, unknown> | null): string | null {
  if (args === null) return 'The tool input was not valid JSON. Send the arguments again as one JSON object.'
  return checkObject(tool.def.inputSchema, args) ?? tool.validate?.(args) ?? null
}

/** Runs one validated call; a failure goes back to the model as the tool's error text. */
export async function runLocalTool(tool: LocalTool, args: Record<string, unknown> | null, env: ToolEnv): Promise<ToolOutcome> {
  const problem = validateLocal(tool, args)
  if (problem) return fail(problem)
  try {
    return await tool.run(args as Record<string, unknown>, env)
  } catch (err) {
    log('warn', 'chat:tool-failed', { tool: tool.def.name, err: parseError(err).message })
    return fail(parseError(err).message || 'The tool failed.')
  }
}

const always = (): boolean => true

const P2_CATEGORY: Record<string, ChatToolCategory> = {
  getCurrentTime: 'calendar',
  findMeetingsByTerms: 'search',
  findMeetingsWithPeople: 'search',
  gatherMeetingContext: 'search',
  listMeetings: 'notes',
  getMeetings: 'notes',
  readMeetings: 'notes',
  readTranscript: 'notes',
  editNote: 'notes',
  rewriteNote: 'notes',
  [APPROVAL_FIXTURE_TOOL]: 'generic'
}

const P2_TITLE: Record<string, string> = {
  getCurrentTime: 'Get the current time',
  findMeetingsByTerms: 'Search meetings by keywords',
  findMeetingsWithPeople: 'Search meetings by people',
  gatherMeetingContext: 'List meetings in a time range',
  listMeetings: 'List meetings',
  getMeetings: 'Look up meetings',
  readMeetings: 'Read meetings',
  readTranscript: 'Read a transcript',
  editNote: 'Edit the open notes',
  rewriteNote: 'Rewrite the summary',
  [APPROVAL_FIXTURE_TOOL]: 'Approval fixture'
}

function p2Tool(name: string, available: (a: ToolAvailability) => boolean, opts: { readOnly: boolean; needsApproval?: boolean }): LocalTool {
  return {
    def: DEFS[name] as LlmToolDef,
    category: P2_CATEGORY[name] ?? 'generic',
    title: P2_TITLE[name] ?? name,
    needsApproval: opts.needsApproval ?? false,
    readOnly: opts.readOnly,
    available,
    run: (args, env) => runP2(name, args, env)
  }
}

/** The core tools. */
export const P2_TOOLS: readonly LocalTool[] = [
  ...LIBRARY_TOOLS.map((n) => p2Tool(n, always, { readOnly: true })),
  p2Tool('editNote', (a) => a.noteEdit, { readOnly: false }),
  p2Tool('rewriteNote', (a) => a.noteEdit && a.rewrite, { readOnly: false }),
  p2Tool(APPROVAL_FIXTURE_TOOL, approvalFixtureEnabled, { readOnly: false, needsApproval: true })
]

// ---------- argument validation ----------

/**
 * The schema subset the tools use: object, string (enum, length), integer and number
 * (bounds), boolean, arrays of strings or objects (item counts), `anyOf`, nested objects.
 */
export function validateArgs(name: string, args: Record<string, unknown> | null): string | null {
  if (args === null) return 'The tool input was not valid JSON. Send the arguments again as one JSON object.'
  const def = DEFS[name]
  if (!def) return `Unknown tool ${name}.`
  return checkObject(def.inputSchema, args)
}

export function checkObject(schema: JsonSchema, args: Record<string, unknown>): string | null {
  for (const key of schema.required ?? []) {
    if (args[key] === undefined || args[key] === null) return `Missing required argument "${key}".`
  }
  for (const [key, value] of Object.entries(args)) {
    const prop = (schema.properties ?? {})[key] as Record<string, unknown> | undefined
    if (!prop) {
      if (schema.additionalProperties === false) return `Unknown argument "${key}".`
      continue
    }
    if (value === null || value === undefined) continue
    const problem = checkValue(key, prop, value)
    if (problem) return problem
  }
  return null
}

function checkValue(key: string, prop: Record<string, unknown>, value: unknown): string | null {
  const anyOf = prop['anyOf']
  if (Array.isArray(anyOf)) {
    let first: string | null = null
    for (const alt of anyOf) {
      const problem = checkValue(key, alt as Record<string, unknown>, value)
      if (problem === null) return null
      first ??= problem
    }
    return first
  }
  const type = prop['type']
  if (type === 'string') {
    if (typeof value !== 'string') return `"${key}" must be a string.`
    const allowed = prop['enum']
    if (Array.isArray(allowed) && !allowed.includes(value)) return `"${key}" must be one of ${allowed.join(', ')}.`
    if (value.length > 100_000) return `"${key}" is too long.`
    const minLength = prop['minLength']
    const maxLength = prop['maxLength']
    if (typeof minLength === 'number' && value.length < minLength) return `"${key}" must be at least ${minLength} characters.`
    if (typeof maxLength === 'number' && value.length > maxLength) return `"${key}" must be at most ${maxLength} characters.`
  } else if (type === 'integer' || type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value) || (type === 'integer' && !Number.isInteger(value))) {
      return `"${key}" must be ${type === 'integer' ? 'an integer' : 'a number'}.`
    }
    const min = prop['minimum']
    const max = prop['maximum']
    if (typeof min === 'number' && value < min) return `"${key}" must be at least ${min}.`
    if (typeof max === 'number' && value > max) return `"${key}" must be at most ${max}.`
  } else if (type === 'boolean') {
    if (typeof value !== 'boolean') return `"${key}" must be true or false.`
  } else if (type === 'array') {
    const items = (prop['items'] ?? { type: 'string' }) as Record<string, unknown>
    if (!Array.isArray(value)) return `"${key}" must be a list.`
    if (items['type'] === 'string' && value.some((v) => typeof v !== 'string')) return `"${key}" must be a list of strings.`
    const min = prop['minItems']
    const max = prop['maxItems']
    if (typeof min === 'number' && value.length < min) return `"${key}" needs at least ${min} item${min === 1 ? '' : 's'}.`
    if (typeof max === 'number' && value.length > max) return `"${key}" takes at most ${max} items.`
    if (items['type'] === 'object') {
      for (const [i, v] of value.entries()) {
        if (!v || typeof v !== 'object' || Array.isArray(v)) return `"${key}[${i}]" must be an object.`
        const problem = checkObject(items as JsonSchema, v as Record<string, unknown>)
        if (problem) return `"${key}[${i}]": ${problem}`
      }
    } else if (items['type'] === 'string') {
      for (const v of value as string[]) {
        const problem = checkValue(key, items, v)
        if (problem) return problem
      }
    }
  } else if (type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return `"${key}" must be an object.`
    if (prop['properties']) return checkObject(prop as JsonSchema, value as Record<string, unknown>)
  }
  return null
}

// ---------- running ----------

export interface NoteTarget {
  noteId: string
  kind: 'summary' | 'notes'
  panelId: string | null
  /** The target markdown as changed by the earlier edits of this answer. */
  markdown: string
}

export interface ToolEnv {
  ctx: MainContext
  place: ChatPlace
  threadId: string
  signal: AbortSignal
  /** The note of a one-note chat. */
  noteId: string | null
  target: NoteTarget | null
  latestSummaryPanelId: string | null
  rewriteStarted: boolean
  /** Meetings the tools have surfaced, for "Searched N notes". */
  scanned: Map<string, DocRef>
  /** Transcript windows `readTranscript` showed, so their keys can be cited. */
  windows: Map<string, TranscriptWindow[]>
}

export interface ToolOutcome {
  /** What the model reads. */
  content: string
  isError: boolean
  /** What the stored tool call keeps (small). */
  result: unknown
}

export const ok = (content: string, result: unknown = null): ToolOutcome => ({ content, isError: false, result })
export const fail = (content: string): ToolOutcome => ({ content, isError: true, result: null })
/** A JSON result: the model reads it as JSON and the card keeps the same object. */
export const okJson = (result: unknown): ToolOutcome => ({ content: JSON.stringify(result), isError: false, result })

export function bound(v: unknown, def: number, max: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(1, Math.min(max, Math.floor(v))) : def
}

export function parseDate(v: unknown, end: boolean): Date | null {
  if (typeof v !== 'string' || !v.trim()) return null
  const s = v.trim()
  const d = /^\d{4}-\d{2}-\d{2}$/.test(s) ? new Date(`${s}T${end ? '23:59:59.999' : '00:00:00'}`) : new Date(s)
  return Number.isNaN(d.getTime()) ? null : d
}

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

/** Monday 00:00 of the week holding `d`. */
function startOfWeek(d: Date): Date {
  const day = startOfDay(d)
  const back = (day.getDay() + 6) % 7
  return new Date(day.getTime() - back * DAY_MS)
}

function rangeOf(args: Record<string, unknown>): { from: Date | null; to: Date | null; label: string } {
  const now = new Date()
  const range = typeof args['range'] === 'string' ? args['range'] : 'past_month'
  switch (range) {
    case 'today':
      return { from: startOfDay(now), to: now, label: 'today' }
    case 'yesterday': {
      const today = startOfDay(now)
      return { from: new Date(today.getTime() - DAY_MS), to: new Date(today.getTime() - 1), label: 'yesterday' }
    }
    case 'this_week':
      return { from: startOfWeek(now), to: now, label: 'this week' }
    case 'last_week': {
      const week = startOfWeek(now)
      return { from: new Date(week.getTime() - 7 * DAY_MS), to: new Date(week.getTime() - 1), label: 'last week' }
    }
    case 'past_quarter':
      return { from: new Date(now.getTime() - 90 * DAY_MS), to: now, label: 'the last 90 days' }
    case 'custom':
      return { from: parseDate(args['startDate'], false), to: parseDate(args['endDate'], true), label: 'the custom range' }
    default:
      return { from: new Date(now.getTime() - 30 * DAY_MS), to: now, label: 'the last 30 days' }
  }
}

export function inRange(n: NoteListItem, from: Date | null, to: Date | null): boolean {
  const t = Date.parse(noteWhen(n))
  if (from && t < from.getTime()) return false
  if (to && t > to.getTime()) return false
  return true
}

function meetingLine(n: NoteListItem): string {
  const who = attendeesOf(n, 8)
  return `- [${n.id}] ${noteTitle(n)} — ${shortDate(noteWhen(n))}${who.length ? ` · with ${who.join(', ')}` : ''}`
}

/** A meeting row of the list cards and the local MCP server (at most 50 per result). */
export interface MeetingRow {
  id: string
  title: string
  date: string
  attendees: string[]
}

export function meetingRow(n: NoteListItem): MeetingRow {
  return { id: n.id, title: noteTitle(n), date: noteWhen(n), attendees: attendeesOf(n, 8) }
}

export function listResult(env: ToolEnv, notes: NoteListItem[], empty: string): ToolOutcome {
  for (const n of notes) env.scanned.set(n.id, docRef(n))
  if (notes.length === 0) return ok(empty, { count: 0, meetings: [] })
  return ok(
    `${notes.length} meeting${notes.length === 1 ? '' : 's'}:\n${notes.map(meetingLine).join('\n')}`,
    { count: notes.length, meetings: notes.slice(0, 50).map(meetingRow) }
  )
}

export async function allNotes(ctx: MainContext): Promise<NoteListItem[]> {
  return ctx.storage.queryNotes({ order: 'newest' })
}

/** Notes matching FTS terms, best match first, then newest. */
export async function ftsNotes(ctx: MainContext, terms: string[]): Promise<NoteListItem[]> {
  const clean = [...new Set(terms.map((t) => t.trim().toLowerCase()).filter((t) => [...t].length >= 3))].slice(0, 32)
  if (clean.length === 0) return []
  const hits = await ctx.storage.searchFts({ terms: clean, limit: 500, sources: ['documents', 'panels'] })
  const score = new Map<string, number>()
  for (const h of hits) score.set(h.documentId, Math.max(score.get(h.documentId) ?? 0, h.matchedTerms + (h.inTitle ? 0.5 : 0)))
  if (score.size === 0) return []
  const notes = await ctx.storage.queryNotes({ ids: [...score.keys()].slice(0, 500) })
  return notes.sort((a, b) => (score.get(b.id) ?? 0) - (score.get(a.id) ?? 0) || noteWhen(b).localeCompare(noteWhen(a)))
}

export function peopleText(n: NoteListItem): string {
  const parts: string[] = []
  for (const p of n.people?.attendees ?? []) parts.push(p.name ?? '', p.email ?? '', p.company ?? '')
  const c = n.people?.creator
  if (c) parts.push(c.name ?? '', c.email ?? '', c.company ?? '')
  for (const a of n.linked_event?.attendees ?? []) parts.push(a.displayName ?? '', a.email ?? '')
  return parts.join(' ').toLowerCase()
}

export function idsArg(v: unknown): string[] {
  return Array.isArray(v) ? [...new Set(v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().toLowerCase()))] : []
}

async function runP2(name: string, args: Record<string, unknown>, env: ToolEnv): Promise<ToolOutcome> {
  const { ctx } = env
  switch (name) {
    case 'getCurrentTime': {
      const now = new Date()
      const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
      const local = now.toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' })
      return ok(`It is ${local} (${zone}). ISO: ${now.toISOString()}.`, { iso: now.toISOString(), timeZone: zone, local })
    }
    case 'findMeetingsByTerms': {
      const keywords = idsArg(args['keywords'])
      const from = parseDate(args['startDate'], false)
      const to = parseDate(args['endDate'], true)
      const notes = (await ftsNotes(ctx, keywords)).filter((n) => inRange(n, from, to)).slice(0, bound(args['limit'], 30, 100))
      return listResult(env, notes, 'No meetings matched those keywords.')
    }
    case 'findMeetingsWithPeople': {
      const people = idsArg(args['people'])
      const companies = idsArg(args['companies'])
      if (people.length === 0 && companies.length === 0) return fail('Give at least one of people or companies.')
      const from = parseDate(args['startDate'], false)
      const to = parseDate(args['endDate'], true)
      const notes = (await allNotes(ctx))
        .filter((n) => inRange(n, from, to))
        .filter((n) => {
          const text = peopleText(n)
          return people.some((p) => text.includes(p)) || companies.some((c) => text.includes(c))
        })
        .slice(0, bound(args['limit'], 30, 100))
      return listResult(env, notes, 'No meetings with those people or companies.')
    }
    case 'gatherMeetingContext': {
      const r = rangeOf(args)
      const notes = await ctx.storage.queryNotes({
        order: 'newest',
        limit: bound(args['limit'], 30, 150),
        ...(r.from ? { from: r.from.toISOString() } : {}),
        ...(r.to ? { to: r.to.toISOString() } : {})
      })
      return listResult(env, notes, `No meetings in ${r.label}.`)
    }
    case 'listMeetings': {
      const limit = bound(args['limit'], 40, 150)
      const from = parseDate(args['startDate'], false)
      const to = parseDate(args['endDate'], true)
      const keyword = typeof args['keyword'] === 'string' ? args['keyword'].trim() : ''
      let notes = keyword ? await ftsNotes(ctx, [keyword]) : await allNotes(ctx)
      if (keyword && [...keyword].length < 3) {
        const k = keyword.toLowerCase()
        notes = (await allNotes(ctx)).filter((n) => noteTitle(n).toLowerCase().includes(k))
      }
      if (args['scope'] === 'folder') {
        const folderId = typeof args['folderId'] === 'string' ? args['folderId'] : ''
        const members = new Set((await folders(ctx))?.membership[folderId] ?? [])
        notes = notes.filter((n) => members.has(n.id))
      }
      const participant = typeof args['participant'] === 'string' ? args['participant'].trim().toLowerCase() : ''
      if (participant) notes = notes.filter((n) => peopleText(n).includes(participant))
      notes = notes.filter((n) => inRange(n, from, to))
      if (keyword) notes.sort((a, b) => noteWhen(b).localeCompare(noteWhen(a)))
      return listResult(env, notes.slice(0, limit), 'No meetings matched.')
    }
    case 'getMeetings': {
      const ids = idsArg(args['meetingIds']).slice(0, 50)
      const found = await ctx.storage.queryNotes({ ids })
      for (const n of found) env.scanned.set(n.id, docRef(n))
      const missing = ids.filter((id) => !found.some((n) => n.id === id))
      const lines = found.map((n) => `- [${n.id}] ${noteTitle(n)} — ${shortDate(noteWhen(n))}`)
      return ok(
        [lines.length ? lines.join('\n') : 'None of those meetings were found.', missing.length ? `Not found: ${missing.join(', ')}` : '']
          .filter(Boolean)
          .join('\n'),
        { found: found.length, notFound: missing, meetings: found.map(meetingRow) }
      )
    }
    case 'readMeetings': {
      const ids = idsArg(args['meetingIds']).slice(0, 20)
      const parts: string[] = []
      const missing: string[] = []
      const meetings: { id: string; title: string; date: string; source: PayloadSource | null }[] = []
      for (const id of ids) {
        const p = await loadPayload(ctx, id, { transcript: false })
        if (!p) {
          missing.push(id)
          continue
        }
        env.scanned.set(p.id, { id: p.id, title: p.title })
        meetings.push({ id: p.id, title: p.title, date: p.when, source: p.source })
        let text = renderPayload(p, CHAT_LIMITS.readMeetingsChars, '').text
        // The note's screen captures, so openAttachment can read one.
        if (p.captures.length) {
          text += `\n\nScreen captures (read one with openAttachment):\n${p.captures
            .map((c) => `- attachment ${c.id}, captured ${shortDate(c.capturedAt)}`)
            .join('\n')}`
        }
        parts.push(text)
      }
      if (missing.length) parts.push(`Not found: ${missing.join(', ')}`)
      return ok(parts.join('\n\n') || 'None of those meetings were found.', { read: meetings.length, notFound: missing, meetings })
    }
    case 'readTranscript': {
      const id = typeof args['meetingId'] === 'string' ? args['meetingId'].trim().toLowerCase() : ''
      const note = id ? await ctx.storage.getNote(id).catch(() => null) : null
      if (!note || note.deleted_at) return fail('That meeting was not found.')
      env.scanned.set(note.id, docRef(note))
      const chunks = await readerTranscript(ctx, note.id, await transcriptionControl(ctx).getTranscript(note.id))
      const live = ctx.capture.isCapturing() && ctx.capture.currentNoteId() === note.id
      const windows = transcriptWindows(speakerTurns(chunks, { wordLevel: false, live }))
      const meeting = { id: note.id, title: noteTitle(note) }
      if (windows.length === 0) return ok('This meeting has no transcript.', { windows: 0, meeting })
      env.windows.set(note.id, windows)
      const query = typeof args['query'] === 'string' ? args['query'].trim() : ''
      const budget = CHAT_LIMITS.readTranscriptChars
      if (!query) {
        const parts: string[] = []
        let used = 0
        for (const w of windows) {
          const r = renderWindow(note.id, w)
          if (used + r.length > budget) break
          used += r.length + 2
          parts.push(r)
        }
        const more = windows.length - parts.length
        return ok(`${parts.join('\n\n')}${more > 0 ? `\n\n[… ${more} more passage${more === 1 ? '' : 's'} not shown …]` : ''}`, {
          windows: parts.length,
          meeting
        })
      }
      const fit = fitTranscript(note.id, windows, budget, { question: query, live: false })
      return ok(fit.text, { windows: fit.included.length, meeting })
    }
    case 'editNote': {
      const target = env.target
      if (!target) return fail('There is no open document to edit.')
      const oldText = typeof args['findText'] === 'string' ? args['findText'] : ''
      const newText = typeof args['newText'] === 'string' ? args['newText'] : ''
      if (!oldText.trim()) return fail('findText is empty. Copy the passage to change from the target document.')
      const at = target.markdown.indexOf(oldText)
      if (at === -1) {
        return fail('The text to replace was not found in the target document. Copy the passage exactly, Markdown included, and try again.')
      }
      target.markdown = target.markdown.slice(0, at) + newText + target.markdown.slice(at + oldText.length)
      return ok('Edit applied.', 'Edit applied.')
    }
    case 'rewriteNote': {
      if (env.rewriteStarted) return fail('A rewrite is already running for this answer.')
      const noteId = env.noteId
      const panelId = env.target?.kind === 'summary' ? env.target.panelId : env.latestSummaryPanelId
      if (!noteId || !panelId) return fail('This meeting has no summary to rewrite.')
      const instructions = typeof args['rewriteInstructions'] === 'string' ? args['rewriteInstructions'].trim() : ''
      if (!instructions) return fail('rewriteInstructions is empty.')
      try {
        const { panelId: newPanelId } = await ctx.enhance.rewrite({ noteId, panelId, instructions })
        env.rewriteStarted = true
        return ok(`Started rewriting the summary into a new "Summary Rewrite" panel. It is generating now.`, { newPanelId })
      } catch (err) {
        return fail(parseError(err).message || 'The rewrite could not start.')
      }
    }
    case APPROVAL_FIXTURE_TOOL:
      return ok('Done: the user approved this action.', 'approved')
    default:
      return fail(`Unknown tool ${name}.`)
  }
}
