// SPDX-License-Identifier: Apache-2.0
// Library context for chat ("Context budget", "Document
// selection with local FTS"): the place's view context, local retrieval, and each
// note's payload (title, date, attendees, the latest summary else the notes, the
// user's notes when a summary was used, transcript windows when asked). A note linked to a video
// or lesson carries its source (kind, title, channel, URL, series, lesson, confidence) and its
// stamped notes, so chat and the MCP tools see what the Local API returns.

import { companyName } from '@shared/lib/people'
import { speakerTurns } from '@shared/lib/speakers'
import type {
  ChatPlace,
  ChatViewContext,
  DirectoryContext,
  DirectoryFolder,
  DocRef,
  MeetingRef
} from '@shared/types/chat'
import type { FoldersState } from '@shared/types/folders'
import type { Note, NoteListItem } from '@shared/types/notes'
import type { NoteSourceView, SourceConfidence, SourceKind } from '@shared/types/sources'
import type { MainContext } from '../context'
import { latestSummaryPanel } from '../enhance/chat-inputs'
import { log } from '../log'
import { readerTranscript } from '../sources/reader'
import { countTerms, daysAgo, queryTerms, shortDate, truncateLines } from './text'
import { fitTranscript, transcriptWindows, type TranscriptWindow } from './windows'

/** At most this many retrieved candidates per question. */
export const MAX_CANDIDATES = 50
/** Notes newer than this many days get a boost. */
const RECENT_DAYS = 30
const RECENT_BOOST = 1.5
/** Without matching terms, a library question gets the newest notes. */
const RECENT_FILL = 12
const RECENT_LISTED = 10
const UPCOMING_LISTED = 10
const UPCOMING_DAYS = 7
const DAY_MS = 86_400_000
/** Below this many characters a note is listed by title only. */
const MIN_DOC_SHARE = 600

type AnyNote = Pick<Note, 'id' | 'title' | 'created_at' | 'linked_event' | 'people'> & {
  sort_epoch?: number | null
}

export function noteTitle(n: Pick<Note, 'title' | 'linked_event'> | null | undefined): string {
  return n?.title?.trim() || n?.linked_event?.summary?.trim() || 'Untitled note'
}

/** The note's meeting time: its display time, else its creation time. */
export function noteWhen(n: AnyNote): string {
  const s = n.sort_epoch
  if (typeof s === 'number' && Number.isFinite(s) && s > 0) return new Date(s * 1000).toISOString()
  const start = n.linked_event?.start
  const iso = (start as { dateTime?: unknown } | undefined)?.dateTime
  return typeof iso === 'string' ? iso : n.created_at
}

/** Attendee names (else emails), the creator excluded, each once. */
export function attendeesOf(n: AnyNote, max = 12): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (name: string | undefined, email: string | undefined): void => {
    const key = (email || name || '').trim().toLowerCase()
    const label = (name || email || '').trim()
    if (!key || !label || seen.has(key)) return
    seen.add(key)
    out.push(label)
  }
  for (const p of n.people?.attendees ?? []) add(p.name, p.email)
  for (const a of n.linked_event?.attendees ?? []) {
    if (a.self || a.resource) continue
    add(a.displayName, a.email)
  }
  return out.slice(0, max)
}

export function docRef(n: AnyNote): DocRef {
  return { id: n.id, title: noteTitle(n) }
}

// ---------- payloads ----------

export interface DocPayload {
  id: string
  title: string
  when: string
  attendees: string[]
  summary: string
  notes: string
  windows: TranscriptWindow[]
  /** The note's screen captures. */
  captures: { id: string; capturedAt: string; description: string }[]
  /** The video or lesson the note came from (content sources); null without one. */
  source: PayloadSource | null
}

/** A note's source as chat and the MCP tools show it. */
export interface PayloadSource {
  kind: SourceKind
  title: string
  channel: string | null
  url: string | null
  duration_ms: number | null
  series: { id: string; title: string } | null
  lesson: number | null
  confidence: SourceConfidence
}

/** JSON Schema of a nullable `PayloadSource`, for tool output schemas. */
export const PAYLOAD_SOURCE_SCHEMA: Record<string, unknown> = {
  type: ['object', 'null'],
  properties: {
    kind: { type: 'string', enum: ['video', 'live', 'lesson', 'other'] },
    title: { type: 'string' },
    channel: { type: ['string', 'null'] },
    url: { type: ['string', 'null'] },
    duration_ms: { type: ['integer', 'null'] },
    series: { type: ['object', 'null'], properties: { id: { type: 'string' }, title: { type: 'string' } }, required: ['id', 'title'] },
    lesson: { type: ['integer', 'null'] },
    confidence: { type: 'string', enum: ['exact', 'high', 'guess'] }
  },
  required: ['kind', 'title', 'channel', 'url', 'duration_ms', 'series', 'lesson', 'confidence']
}

export function payloadSource(v: NoteSourceView | null): PayloadSource | null {
  if (!v) return null
  const s = v.source
  return {
    kind: s.kind,
    title: s.title,
    channel: s.channel,
    url: s.url,
    duration_ms: s.duration_ms,
    series: v.series ? { id: v.series.id, title: v.series.title } : null,
    lesson: s.lesson_number,
    confidence: s.confidence
  }
}

/** The note's source and stamped notes; nulls without a source or when storage can't tell. */
export async function loadSource(ctx: MainContext, noteId: string): Promise<{ source: PayloadSource | null; stamped: string | null }> {
  const v = await ctx.storage.getNoteSourceView(noteId).catch(() => null)
  return { source: payloadSource(v), stamped: v?.source.notes_md_stamped?.trim() || null }
}

function sourceLine(s: PayloadSource): string {
  const what = s.kind === 'lesson' ? 'Lesson' : s.kind === 'live' ? 'Live video' : s.kind === 'video' ? 'Video' : 'Source'
  const parts = [`${what}: ${s.title}${s.channel ? ` by ${s.channel}` : ''}`]
  if (s.series) parts.push(`series ${s.series.title}${s.lesson !== null ? `, lesson ${s.lesson}` : ''}`)
  if (s.url) parts.push(s.url)
  if (s.confidence === 'guess') parts.push('not confirmed')
  return parts.join(' · ')
}

export async function loadPayload(ctx: MainContext, noteId: string, opts: { transcript: boolean }): Promise<DocPayload | null> {
  const note = await ctx.storage.getNote(noteId).catch(() => null)
  if (!note || note.deleted_at) return null
  const panels = await ctx.storage.listPanels(noteId).catch(() => [])
  const latest = latestSummaryPanel(panels)
  const summary = (latest?.content_markdown ?? latest?.generated_content ?? '').trim()
  const src = await loadSource(ctx, noteId)
  // A source note's own notes carry their video times as `[mm:ss](url)` links.
  const notes = (src.stamped || note.notes_md?.trim() || note.notes_text?.trim() || '').trim()
  let windows: TranscriptWindow[] = []
  if (opts.transcript) {
    const chunks = await readerTranscript(ctx, noteId, await ctx.storage.getTranscript(noteId).catch(() => []))
    windows = transcriptWindows(speakerTurns(chunks, { wordLevel: false, live: false }))
  }
  const captures = (Array.isArray(note.attachments) ? note.attachments : [])
    .filter((a) => !!a.screen_capture_info)
    .map((a) => ({ id: a.id, capturedAt: a.screen_capture_info?.captured_at ?? '', description: a.screen_capture_info?.description ?? '' }))
  return { id: note.id, title: noteTitle(note), when: noteWhen(note), attendees: attendeesOf(note), summary, notes, windows, captures, source: src.source }
}

function docHeader(p: DocPayload): string {
  const meta = [shortDate(p.when), p.attendees.length ? `with ${p.attendees.join(', ')}` : ''].filter(Boolean).join(' · ')
  return `### [${p.id}] ${p.title}${meta ? `\n${meta}` : ''}${p.source ? `\n${sourceLine(p.source)}` : ''}`
}

/**
 * One note within `share` characters. Over its share it keeps the header and the
 * start of its summary, cut on a line boundary with "[truncated]".
 */
export function renderPayload(p: DocPayload, share: number, question: string): { text: string; truncated: boolean } {
  const header = docHeader(p)
  const body: string[] = []
  if (p.summary) {
    body.push(`Summary:\n${p.summary}`)
    if (p.notes) body.push(`The user's own notes:\n${p.notes}`)
  } else if (p.notes) {
    body.push(`The user's own notes:\n${p.notes}`)
  } else {
    body.push('(No summary or notes yet.)')
  }
  let text = `${header}\n${body.join('\n\n')}`
  let truncated = false
  if (text.length > share) {
    const cut = truncateLines(text, Math.max(header.length + 80, share))
    text = cut.text
    truncated = cut.truncated
  }
  if (p.windows.length > 0) {
    const room = share - text.length - 20
    const fit = fitTranscript(p.id, p.windows, room, { question, live: false })
    if (fit.text) text += `\n\nTranscript:\n${fit.text}`
    if (!fit.complete) truncated = true
  }
  return { text, truncated }
}

/** Title and date only, for a note that doesn't fit (the model can read it with a tool). */
export function listedLine(p: Pick<DocPayload, 'id' | 'title' | 'when'>): string {
  return `- [${p.id}] ${p.title}${p.when ? ` (${shortDate(p.when)})` : ''}`
}

export interface FittedDocs {
  text: string
  included: DocPayload[]
  truncatedIds: Set<string>
  listedIds: Set<string>
}

/**
 * Notes in order within `budget` characters: each gets an equal share; when a share
 * would be too small for a useful excerpt, the later notes are listed by title only.
 */
export function fitDocs(docs: DocPayload[], budget: number, question: string): FittedDocs {
  const out: FittedDocs = { text: '', included: [], truncatedIds: new Set(), listedIds: new Set() }
  if (docs.length === 0) return out
  const listed = docs.map((d) => listedLine(d))
  let full = docs.length
  // Reserve the title lines of the notes that won't get a share.
  const listCost = (k: number): number => listed.slice(k).reduce((n, l) => n + l.length + 1, 0)
  while (full > 0 && (budget - listCost(full)) / full < MIN_DOC_SHARE) full--
  const parts: string[] = []
  if (full > 0) {
    const share = Math.floor((budget - listCost(full)) / full)
    for (const d of docs.slice(0, full)) {
      const r = renderPayload(d, share, question)
      parts.push(r.text)
      out.included.push(d)
      if (r.truncated) out.truncatedIds.add(d.id)
    }
  }
  const rest = docs.slice(full)
  if (rest.length > 0) {
    let room = budget - parts.reduce((n, p) => n + p.length + 2, 0)
    const lines: string[] = []
    for (const d of rest) {
      const line = listedLine(d)
      if (room - line.length - 1 < 0) break
      room -= line.length + 1
      lines.push(line)
      out.listedIds.add(d.id)
    }
    if (lines.length > 0) parts.push(`Other notes that may be relevant (not included; read them with readMeetings):\n${lines.join('\n')}`)
  }
  out.text = parts.join('\n\n')
  return out
}

// ---------- retrieval ----------

/**
 * Local FTS retrieval: any-term match over note titles and notes and panel content,
 * scored by matched terms (+0.5 for a title hit), ×1.5 for notes of the last 30 days;
 * at most 50 candidates.
 */
export async function retrieve(ctx: MainContext, text: string, opts: { documentIds?: string[]; limit?: number } = {}): Promise<string[]> {
  const terms = queryTerms(text)
  if (terms.length === 0) return []
  let hits
  try {
    hits = await ctx.storage.searchFts({
      terms,
      limit: 500,
      sources: ['documents', 'panels'],
      ...(opts.documentIds ? { documentIds: opts.documentIds } : {})
    })
  } catch (err) {
    log('warn', 'chat:fts-failed', { err })
    return []
  }
  const byDoc = new Map<string, { matched: number; inTitle: boolean }>()
  for (const h of hits) {
    const cur = byDoc.get(h.documentId) ?? { matched: 0, inTitle: false }
    cur.matched = Math.max(cur.matched, h.matchedTerms)
    cur.inTitle ||= h.inTitle
    byDoc.set(h.documentId, cur)
  }
  if (byDoc.size === 0) return []
  const notes = await ctx.storage.queryNotes({ ids: [...byDoc.keys()].slice(0, 500) }).catch(() => [] as NoteListItem[])
  const now = Date.now()
  const scored = notes.map((n) => {
    const h = byDoc.get(n.id) ?? { matched: 0, inTitle: false }
    const base = h.matched + (h.inTitle ? 0.5 : 0)
    return { id: n.id, score: daysAgo(noteWhen(n), now) <= RECENT_DAYS ? base * RECENT_BOOST : base, when: noteWhen(n) }
  })
  scored.sort((a, b) => b.score - a.score || b.when.localeCompare(a.when))
  return scored.slice(0, opts.limit ?? MAX_CANDIDATES).map((s) => s.id)
}

/** The newest notes, for library questions with no usable terms. */
export async function newestIds(ctx: MainContext, limit = RECENT_FILL): Promise<string[]> {
  const notes = await ctx.storage.queryNotes({ order: 'newest', limit }).catch(() => [] as NoteListItem[])
  return notes.map((n) => n.id)
}

// ---------- folders ----------

let foldersCache: { at: number; state: FoldersState | null } | null = null
const FOLDERS_TTL_MS = 60_000

export function forgetFolders(): void {
  foldersCache = null
}

/** The folder tree, or null when storage can't serve it. Cached; bus `folders:changed` clears it. */
export async function folders(ctx: MainContext): Promise<FoldersState | null> {
  if (foldersCache && Date.now() - foldersCache.at < FOLDERS_TTL_MS) return foldersCache.state
  let state: FoldersState | null = null
  try {
    state = await ctx.storage.listFolders()
  } catch {
    state = null
  }
  foldersCache = { at: Date.now(), state }
  return state
}

export function directoryContext(state: FoldersState | null): DirectoryContext | null {
  if (!state || state.folders.length === 0) return null
  const count = (id: string): number => state.membership[id]?.length ?? 0
  const node = (id: string, depth: number): DirectoryFolder => {
    const f = state.folders.find((x) => x.id === id)
    return {
      id,
      name: f?.title || 'Untitled folder',
      noteCount: count(id),
      children: depth > 2 ? [] : state.folders.filter((x) => x.parent_id === id).map((x) => node(x.id, depth + 1))
    }
  }
  const favourites = state.folders.filter((f) => f.is_favourite && !state.folders.some((p) => p.id === f.parent_id && p.is_favourite))
  const roots = state.folders.filter((f) => !f.parent_id)
  const sections: DirectoryContext['sections'] = []
  if (favourites.length) sections.push({ name: 'Favorites', folders: favourites.map((f) => node(f.id, 0)) })
  if (roots.length) sections.push({ name: 'My notes', folders: roots.map((f) => node(f.id, 0)) })
  return sections.length ? { sections } : null
}

export function renderDirectory(d: DirectoryContext | null): string {
  if (!d) return ''
  const lines: string[] = []
  const walk = (f: DirectoryFolder, depth: number): void => {
    lines.push(`${'  '.repeat(depth)}- ${f.name} (${f.noteCount} note${f.noteCount === 1 ? '' : 's'})`)
    for (const c of f.children) walk(c, depth + 1)
  }
  for (const s of d.sections) {
    lines.push(`${s.name}:`)
    for (const f of s.folders) walk(f, 1)
  }
  return lines.join('\n')
}

// ---------- view contexts ----------

function meetingRef(n: NoteListItem | undefined): MeetingRef | null {
  return n ? { id: n.id, title: noteTitle(n), created_at: noteWhen(n) } : null
}

/** The documents a place covers explicitly (search results, folder members); null = the whole library. */
export async function placeDocumentIds(ctx: MainContext, place: ChatPlace): Promise<string[] | null> {
  if (place.kind === 'search') return place.documentIds
  if (place.kind === 'list') {
    const state = await folders(ctx)
    return state?.membership[place.folderId] ?? []
  }
  if (place.kind === 'meeting') return [place.noteId]
  return null
}

export async function libraryViewContext(ctx: MainContext, place: Exclude<ChatPlace, { kind: 'meeting' }>): Promise<ChatViewContext> {
  if (place.kind === 'search') {
    // The person's or company's name.
    const person = place.type === 'person' ? await ctx.storage.getPerson(place.query, []).catch(() => null) : null
    return {
      view: 'search',
      query: place.query,
      type: place.type,
      documentIds: place.documentIds.slice(0, 500),
      ...(place.type === 'person' ? { person: { name: person?.name ?? '', email: place.query } } : {}),
      ...(place.type === 'company' ? { company: { name: companyName(place.query), domain: place.query } } : {})
    }
  }
  if (place.kind === 'list') {
    const state = await folders(ctx)
    const f = state?.folders.find((x) => x.id === place.folderId)
    const ids = state?.membership[place.folderId] ?? []
    const members = ids.length ? await ctx.storage.queryNotes({ ids: ids.slice(0, 1_000), order: 'newest' }).catch(() => []) : []
    return {
      view: 'list',
      folderId: place.folderId,
      folderName: f?.title ?? '',
      folderDescription: f?.description ?? null,
      totalNotes: members.length,
      subFolderCount: state?.folders.filter((x) => x.parent_id === place.folderId).length ?? 0,
      oldestMeeting: meetingRef(members[members.length - 1]),
      newestMeeting: meetingRef(members[0])
    }
  }
  const notes = await ctx.storage.queryNotes({ order: 'newest' }).catch(() => [] as NoteListItem[])
  const now = new Date()
  // Upcoming = not started yet and without a note: listEvents also returns the meeting in
  // progress, which (like any meeting that already has a note) is not upcoming.
  const noted = new Set(notes.map((n) => n.event_id).filter((id): id is string => !!id))
  const events = (
    await ctx.calendar
      .listEvents({ from: now.toISOString(), to: new Date(now.getTime() + UPCOMING_DAYS * DAY_MS).toISOString() })
      .catch(() => [])
  ).filter((e) => {
    const start = Date.parse(String(e.start?.dateTime ?? e.start?.date ?? ''))
    return Number.isFinite(start) && start > now.getTime() && !noted.has(e.id)
  })
  return {
    view: 'global',
    oldestMeeting: meetingRef(notes[notes.length - 1]),
    newestMeeting: meetingRef(notes[0]),
    totalNotes: notes.length,
    // One local user: every note is the user's own.
    attendedNotes: notes.length,
    sharedNotes: 0,
    upcomingMeetings: events.slice(0, UPCOMING_LISTED).map((e) => {
      const start = e.start as { dateTime?: unknown; date?: unknown } | undefined
      const organizer = e.attendees?.find((a) => a.organizer)?.email ?? null
      return {
        id: e.id,
        title: e.summary?.trim() || 'Untitled event',
        start: typeof start?.dateTime === 'string' ? start.dateTime : typeof start?.date === 'string' ? start.date : '',
        attendees: (e.attendees ?? []).filter((a) => !a.self && !a.resource).map((a) => a.displayName || a.email),
        creator: organizer
      }
    }),
    recentMeetings: notes.slice(0, RECENT_LISTED).map((n) => ({
      id: n.id,
      title: noteTitle(n),
      created_at: noteWhen(n),
      attendees: attendeesOf(n, 6)
    }))
  }
}

/** The place's context header as compact text (step 3 of the fill order). */
export function renderViewHeader(v: ChatViewContext, directory: DirectoryContext | null): string {
  const lines: string[] = []
  if (v.view === 'global') {
    const span =
      v.oldestMeeting && v.newestMeeting ? `, from ${shortDate(v.oldestMeeting.created_at)} to ${shortDate(v.newestMeeting.created_at)}` : ''
    lines.push(`The user is asking about their whole library: ${v.totalNotes} note${v.totalNotes === 1 ? '' : 's'}${span}.`)
    if (v.recentMeetings.length) {
      lines.push('Most recent meetings:')
      for (const m of v.recentMeetings) {
        lines.push(`- [${m.id}] ${m.title} (${shortDate(m.created_at)})${m.attendees.length ? ` with ${m.attendees.join(', ')}` : ''}`)
      }
    }
    if (v.upcomingMeetings.length) {
      lines.push('Upcoming meetings on their calendar:')
      for (const m of v.upcomingMeetings) {
        lines.push(`- ${m.title} (${shortDate(m.start)})${m.attendees.length ? ` with ${m.attendees.slice(0, 6).join(', ')}` : ''}`)
      }
    }
  } else if (v.view === 'search') {
    const what =
      v.type === 'person'
        ? `the person ${v.person?.name ? `${v.person.name} (${v.query})` : v.query}`
        : v.type === 'company'
          ? `the company ${v.company?.name ? `${v.company.name} (${v.query})` : v.query}`
          : `"${v.query}"`
    lines.push(`The user is looking at search results for ${what}: ${v.documentIds.length} note${v.documentIds.length === 1 ? '' : 's'}.`)
  } else if (v.view === 'list') {
    lines.push(
      `The user is in the folder "${v.folderName || 'Untitled folder'}"${v.folderDescription ? ` (${v.folderDescription})` : ''}: ` +
        `${v.totalNotes} note${v.totalNotes === 1 ? '' : 's'}, ${v.subFolderCount} subfolder${v.subFolderCount === 1 ? '' : 's'}.`
    )
  }
  const dir = renderDirectory(directory)
  if (dir) lines.push(`Their folders:\n${dir}`)
  return lines.join('\n')
}

/** Ranks explicit or candidate ids by how well each payload answers the question (stable for ties). */
export function rankPayloads(docs: DocPayload[], question: string): DocPayload[] {
  const terms = queryTerms(question)
  if (terms.length === 0) return docs
  return docs
    .map((d, i) => ({ d, i, s: countTerms(`${d.title}\n${d.summary}\n${d.notes}`, terms) }))
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.d)
}
