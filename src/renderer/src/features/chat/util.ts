// SPDX-License-Identifier: Apache-2.0
// Small chat helpers for the renderer: date groups, tool status phrases, text cleanup.

import type { ChatMessage, ChatOutput, ChatThread, ChatToolCall, DocRef } from '@shared/types/chat'

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const KEY_BRACKET = new RegExp(`\\s?\\[\\s*${UUID}(?:-\\d+)?(?:\\s*[,;]\\s*${UUID}(?:-\\d+)?)*\\s*\\]`, 'gi')
/** A citation key the stream has only half delivered. */
const PARTIAL_KEY = /\s?\[[0-9a-f-]{0,60}(?:\s*[,;]\s*[0-9a-f-]{0,60})*$/i
const MENTION = new RegExp(`@(${UUID})(?=\\s|$)`, 'gi')
const DAY_MS = 86_400_000

/** Answer text without its citation keys, spacing tidied. */
export function stripKeys(text: string, streaming = false): string {
  let t = text.replace(KEY_BRACKET, '')
  if (streaming) t = t.replace(PARTIAL_KEY, '')
  return t.replace(/[ \t]+([.,;:!?])/g, '$1').replace(/[ \t]{2,}/g, ' ')
}

/** The text of an answer, as "Copy response" copies it. */
export function answerText(outputs: readonly ChatOutput[]): string {
  return outputs
    .map((o) => (o.type === 'cited_text' ? o.plain_text : o.type === 'text' ? stripKeys(o.text) : ''))
    .filter((t) => t.trim())
    .join('\n\n')
    .trim()
}

/** `@<uuid>` mentions as `@<title>`. */
export function mentionsAsTitles(text: string, refs: readonly DocRef[]): string {
  return text.replace(MENTION, (_m, id: string) => `@${refs.find((r) => r.id.toLowerCase() === id.toLowerCase())?.title || 'New note'}`)
}

export function messageMentions(m: Pick<ChatMessage, 'context'>): DocRef[] {
  return m.context?.additionalContext?.mentionedNotes ?? []
}

// ---------- date groups ----------

export interface ThreadGroup {
  key: string
  label: string
  threads: ChatThread[]
}

function bucket(iso: string, now: Date): { key: string; label: string; rank: number } {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { key: 'older', label: 'Older', rank: 1e9 }
  if (d.toDateString() === now.toDateString()) return { key: 'today', label: 'Today', rank: 0 }
  const days = Math.floor((now.getTime() - d.getTime()) / DAY_MS)
  if (days <= 3) return { key: 'last-3-days', label: 'Last 3 days', rank: 1 }
  if (days <= 7) return { key: 'last-week', label: 'Last week', rank: 2 }
  if (days <= 14) return { key: 'last-2-weeks', label: 'Last 2 weeks', rank: 3 }
  if (days <= 21) return { key: 'last-3-weeks', label: 'Last 3 weeks', rank: 4 }
  if (days <= 30) return { key: 'last-month', label: 'Last month', rank: 5 }
  const month = d.toLocaleDateString(undefined, { month: 'long' })
  const label = d.getFullYear() === now.getFullYear() ? month : `${month} ${d.getFullYear()}`
  return { key: `m-${d.getFullYear()}-${d.getMonth()}`, label, rank: 10 + (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth()) }
}

/** "Pinned" first, then today … last month, then one group per older month, newest first. */
export function groupThreads(threads: readonly ChatThread[], now = new Date()): ThreadGroup[] {
  const pinned = threads.filter((t) => t.is_pinned).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  const groups = new Map<string, { label: string; rank: number; threads: ChatThread[] }>()
  for (const t of threads) {
    if (t.is_pinned) continue
    const b = bucket(t.updated_at, now)
    const g = groups.get(b.key) ?? { label: b.label, rank: b.rank, threads: [] }
    g.threads.push(t)
    groups.set(b.key, g)
  }
  const out: ThreadGroup[] = pinned.length ? [{ key: 'pinned', label: 'Pinned', threads: pinned }] : []
  for (const [key, g] of [...groups].sort((a, b) => a[1].rank - b[1].rank)) {
    out.push({ key, label: g.label, threads: g.threads.sort((a, b) => b.updated_at.localeCompare(a.updated_at)) })
  }
  return out
}

// ---------- tool status lines ----------

const PHRASES: Record<string, [running: string, done: string, failed: string]> = {
  getCurrentTime: ['Checking the time...', 'Checked the time', 'Couldn’t check the time'],
  findMeetingsByTerms: ['Searching meetings...', 'Searched meetings', 'Couldn’t search meetings'],
  findMeetingsWithPeople: ['Searching meetings...', 'Searched meetings', 'Couldn’t search meetings'],
  findMeetingsWithPeopleOrCompanies: ['Searching meetings...', 'Searched meetings', 'Couldn’t search meetings'],
  gatherMeetingContext: ['Looking through meetings...', 'Looked through meetings', 'Couldn’t look through meetings'],
  listMeetings: ['Listing meetings...', 'Listed meetings', 'Couldn’t list meetings'],
  fetchMeetings: ['Listing meetings...', 'Listed meetings', 'Couldn’t list meetings'],
  getMeetings: ['Looking up meetings...', 'Looked up meetings', 'Couldn’t look up meetings'],
  readMeetings: ['Reading meetings...', 'Read meetings', 'Couldn’t read meetings'],
  readTranscript: ['Extracting key excerpts from transcript', 'Extracted key excerpts', 'Couldn’t read the transcript'],
  editNote: ['Editing meeting notes...', 'Meeting notes edited', 'Couldn’t edit the notes'],
  rewriteNote: ['Rewriting meeting notes...', 'Meeting notes rewritten', 'Couldn’t rewrite the notes'],
  exploreMeetings: ['Exploring meetings...', 'Explored meetings', 'Couldn’t explore meetings'],
  openAttachment: ['Reading a screen capture...', 'Read a screen capture', 'Couldn’t read the screen capture'],
  readEventNote: ['Reading event notes...', 'Read event notes', 'Couldn’t read event notes'],
  appendToEventNote: ['Adding to event notes...', 'Added to event notes', 'Couldn’t add to event notes'],
  editEventNote: ['Editing event notes...', 'Edited event notes', 'Couldn’t edit event notes'],
  show_todo_cards: ['Showing action items...', 'Action items', 'Couldn’t show action items'],
  readPrepBrief: ['Reading the brief...', 'Read the brief', 'Couldn’t read the brief'],
  listUpcomingEvents: ['Checking your calendar...', 'Checked your calendar', 'Couldn’t check your calendar'],
  readEvent: ['Reading calendar event...', 'Read calendar event', 'Couldn’t read calendar event'],
  findFolders: ['Finding folders...', 'Found folders', 'Couldn’t find folders'],
  locateNotes: ['Finding where notes are filed...', 'Found where notes are filed', 'Couldn’t find note locations'],
  createFolder: ['Creating folder...', 'Created folder', 'Couldn’t create the folder'],
  organizeNote: ['Filing note...', 'Filed note', 'Couldn’t file note'],
  listFolderAttachments: ['Listing files', 'Listed files', 'Couldn’t list files'],
  readFile: ['Reading file', 'Read file', 'Couldn’t read the file'],
  loadRecipe: ['Loading skill instructions...', 'Loaded skill instructions', 'Couldn’t load the skill instructions']
}

const GENERIC: [string, string, string] = ['Working...', 'Completed', 'Couldn’t complete this step']
const PEOPLE_TOOLS = new Set(['findPeopleOrCompanies', 'findPeople', 'resolvePerson'])
const CALENDAR_SEARCH = new Set(['searchCalendar', 'listEventsInRange', 'findEvents'])

export type ToolPhase = 'running' | 'done' | 'failed' | 'reverted' | 'waiting' | 'skipped'

/** A second write in a round waits for the first; it is not a failure. */
export const WAITING_EARLIER = 'Waiting for approval of an earlier change.'

export function toolPhase(c: ChatToolCall, rewriteRunning = false): ToolPhase {
  if (c.approval?.status === 'pending') return 'waiting'
  if (c.reverted) return 'reverted'
  if (c.error === WAITING_EARLIER) return 'skipped'
  if (c.error) return 'failed'
  if (c.name === 'rewriteNote' && c.completed && rewriteRunning) return 'running'
  return c.completed ? 'done' : 'running'
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : ''
}

/** "Searched calendar for “q” · 3 events". */
function calendarLine(c: ChatToolCall, phase: ToolPhase): string {
  const listing = c.name !== 'searchCalendar' && c.name !== 'findEvents'
  if (phase === 'running') return listing ? 'Listing calendar events...' : 'Searching calendar...'
  if (phase === 'failed') return 'Couldn’t read your calendar'
  const query = str(c.args['query'])
  const attendees = [str(c.args['attendeeEmail']), ...(Array.isArray(c.args['attendeeEmails']) ? (c.args['attendeeEmails'] as unknown[]).map(str) : [])].filter(Boolean)
  const dated = !!(str(c.args['startDate']) || str(c.args['endDate']))
  let line = listing ? (!query && !dated && attendees.length === 0 ? 'Listed upcoming events' : 'Listed calendar events') : 'Searched calendar'
  if (query) line += ` for “${query}”`
  else if (attendees.length) line += ` with ${attendees[0]}${attendees.length > 1 ? ` +${attendees.length - 1}` : ''}`
  const n = (c.result as { events?: unknown[] } | null)?.events?.length
  if (typeof n === 'number') line += n === 0 ? ' · no events' : ` · ${n} event${n === 1 ? '' : 's'}`
  return line
}

/** The people tools share `resolvePerson`'s card copy. */
function peopleLine(c: ChatToolCall, phase: ToolPhase): string {
  const q = str(c.args['query'])
  if (phase === 'running') return q ? `Finding people matching “${q}”` : 'Finding people...'
  if (phase === 'failed') return 'Couldn’t search for people'
  const r = c.result as { people?: unknown[]; entities?: unknown[] } | null
  const n = (r?.people ?? r?.entities ?? []).length
  return n === 0 ? `Found no people matching “${q}”` : `Found ${n} ${c.name === 'findPeopleOrCompanies' ? `result${n === 1 ? '' : 's'}` : n === 1 ? 'person' : 'people'}`
}

/** `list_todos`: "Fetched 4 action items". */
function actionItemsLine(c: ChatToolCall, phase: ToolPhase): string {
  const kind = str(c.args['created_after']) ? 'recent action items' : 'action items'
  if (phase === 'running') return `Fetching ${kind}`
  if (phase === 'failed') return `Couldn’t fetch ${kind}`
  const n = (c.result as { items?: unknown[] } | null)?.items?.length ?? 0
  return n === 0 ? `Fetched no ${kind}` : `Fetched ${n} ${kind}`
}

export function toolLine(c: ChatToolCall, phase: ToolPhase): string {
  if (phase === 'reverted') return 'Changes reverted'
  if (c.name === 'askUser') {
    // A question waits for the user, then reads as answered or skipped.
    return phase === 'waiting' ? 'Waiting for your answer' : c.approval?.status === 'denied' ? 'Question skipped' : 'Question answered'
  }
  if (phase === 'waiting') return 'Waiting for your approval'
  if (phase === 'skipped') return 'Waiting for an earlier change'
  if (c.approval?.status === 'denied') return 'Declined'
  if (CALENDAR_SEARCH.has(c.name)) return calendarLine(c, phase)
  if (PEOPLE_TOOLS.has(c.name)) return peopleLine(c, phase)
  if (c.name === 'list_todos') return actionItemsLine(c, phase)
  if (c.mcpToolLabel || c.name.startsWith('mcp__')) {
    const title = c.mcpToolLabel || c.name.split('__').slice(2).join('__') || c.name
    return phase === 'running' ? `Running ${title}...` : phase === 'failed' ? `Couldn’t run ${title}` : `Ran ${title}`
  }
  const p = PHRASES[c.name] ?? GENERIC
  const base = phase === 'running' ? p[0] : phase === 'failed' ? p[2] : p[1]
  const r = c.result as { count?: unknown; files?: unknown[]; read?: unknown } | null
  if (phase === 'done' && r && typeof r === 'object') {
    if (typeof r.count === 'number') return `${base} · ${r.count === 0 ? 'none found' : `${r.count} found`}`
    if (c.name === 'listFolderAttachments' && Array.isArray(r.files)) return `Found ${r.files.length} file${r.files.length === 1 ? '' : 's'}`
    if (c.name === 'readMeetings' && typeof r.read === 'number') return `Looked deeper into ${r.read} note${r.read === 1 ? '' : 's'}`
  }
  if (phase === 'running' && c.name === 'readMeetings') {
    const n = Array.isArray(c.args['meetingIds']) ? (c.args['meetingIds'] as unknown[]).length : 0
    return n ? `Looking deeper into ${n} note${n === 1 ? '' : 's'}` : base
  }
  return base
}

export function toolGroup(name: string): 'notes' | 'search' | 'calendar' | 'generic' {
  if (name === 'editNote' || name === 'rewriteNote' || name === 'readMeetings' || name === 'readTranscript') return 'notes'
  if (name.startsWith('search') || name === 'listMeetings' || name === 'gatherMeetingContext' || name === 'getMeetings') return 'search'
  if (name === 'getCurrentTime') return 'calendar'
  return 'generic'
}

/** The `findText` of an edit call while its arguments still stream. */
export function streamingTextToReplace(c: ChatToolCall): string | null {
  const done = c.args?.['findText']
  if (typeof done === 'string' && done) return done
  const m = /"findText"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(c.argsDelta ?? '')
  if (!m) return null
  try {
    return JSON.parse(`"${m[1]}"`) as string
  } catch {
    return null
  }
}

export const EXAMPLE_PROMPTS = [
  'What did I promise to follow up on?',
  'Recap this week’s meetings',
  'Which action items are still open?',
  'What did we decide?',
  'Who have I met with lately?',
  'Which topics kept coming up?'
] as const
