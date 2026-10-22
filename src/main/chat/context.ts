// SPDX-License-Identifier: Apache-2.0
// Context assembly. Main builds everything the model sees, within the budget:
// the user's message first, then up to 25 % of history, then the place's header, then
// documents. A one-note chat adds the meeting header, the target document (never cut
// below 25 % of the budget), the other document (≤ 20 %) and the transcript windows.

import type {
  ChatContext,
  ChatContextSources,
  ChatEditorTarget,
  ChatMessage,
  ChatPlace,
  ChatViewContext,
  DirectoryContext,
  DocRef
} from '@shared/types/chat'
import type { RecipeAdditionalContext } from '@shared/types/recipes'
import type { MainContext, NoteChatInputs } from '../context'
import type { LlmChatMessage } from '../llm/types'
import { log } from '../log'
import { CitationIndex } from './citations'
import { historyMessages } from './history'
import {
  fitDocs,
  loadPayload,
  MAX_CANDIDATES,
  newestIds,
  noteTitle,
  placeDocumentIds,
  rankPayloads,
  renderViewHeader,
  retrieve,
  type DocPayload
} from './library'
import type { NotePromptFacts } from './prompt'
import { shortDate, truncateLines } from './text'
import { fitTranscript, transcriptWindows } from './windows'

/** History may use at most this share of the budget (step 2). */
const HISTORY_SHARE = 0.25
/** A one-note chat's target document never gets less than this share. */
const TARGET_MIN_SHARE = 0.25
/** The other document of a one-note chat gets at most this share. */
const SECONDARY_SHARE = 0.2
/** Mentioned notes in a one-note chat get at most this share. */
const MENTIONS_SHARE = 0.25
/** 1–25 selected documents keep their transcripts. */
const SELECTED_TRANSCRIPTS_MAX = 25
/** Explicit place documents loaded per question (a large folder is ranked, then cut). */
const MAX_PLACE_DOCS = 200

export type ContextLimit = { filtered: string[]; unavailable: string[]; excluded: string[] }

export interface AssembleInput {
  place: ChatPlace
  view: ChatViewContext
  directory: DirectoryContext | null
  /** What retrieval and transcript ranking look for (the typed text, else the recipe's instructions). */
  question: string
  /** The model-facing user turn (recipe expanded, selection quoted). */
  userContent: string
  earlier: ChatMessage[]
  mentions: DocRef[]
  selectedDocuments: DocRef[]
  includeTranscripts: boolean
  target: ChatEditorTarget | null
  selection: string | null
  editWithAi: boolean
  live: boolean
  recipeContexts: RecipeAdditionalContext[]
  /** The meeting's meaningful prep brief, while `prepBrief.inChat` is on. */
  brief: { id: string; content: string } | null
  /** Characters left for history, header and documents (window − output cap − rules − tools − user turn). */
  budget: number
}

export interface Assembled {
  messages: LlmChatMessage[]
  context: string
  index: CitationIndex
  sources: ChatContextSources
  limit: ContextLimit | null
  note: (NotePromptFacts & { latestSummaryPanelId: string | null }) | null
}

function sum(parts: readonly string[]): number {
  return parts.reduce((n, p) => n + p.length + 2, 0)
}

export async function assemble(ctx: MainContext, input: AssembleInput): Promise<Assembled> {
  let budget = Math.max(2_000, input.budget)
  const history = historyMessages(input.earlier, Math.floor(budget * HISTORY_SHARE))
  budget -= history.messages.reduce((n, m) => n + m.content.length, 0)
  const messages: LlmChatMessage[] = [...history.messages, { role: 'user', content: input.userContent }]

  if (input.place.kind === 'meeting') {
    let inputs: NoteChatInputs | null = null
    try {
      inputs = await ctx.enhance.noteChatInputs(input.place.noteId, {
        ...(input.target ? { targetMarkdown: input.target.markdown } : {}),
        selectionMarkdown: input.selection
      })
    } catch (err) {
      log('info', 'chat:note-context-unavailable', { noteId: input.place.noteId, err: err instanceof Error ? err.message : String(err) })
    }
    if (inputs && !inputs.note.deleted_at) return { messages, ...(await noteContext(ctx, input, inputs, budget)) }
    // The note is gone; answer from the library, and say so.
    const lib = await libraryContext(ctx, { ...input, place: { kind: 'global' } }, budget)
    return { messages, ...lib, context: `The meeting this chat was about has been deleted.\n\n${lib.context}` }
  }
  return { messages, ...(await libraryContext(ctx, input, budget)) }
}

// ---------- library chat ----------

async function libraryContext(ctx: MainContext, input: AssembleInput, budget: number): Promise<Omit<Assembled, 'messages'>> {
  const index = new CitationIndex()
  const header = renderViewHeader(input.view, input.directory)
  budget -= header.length + 2

  // Explicit documents first: selected, mentioned, then the place's own.
  const explicit: string[] = []
  const add = (id: string): void => {
    const k = id.toLowerCase()
    if (!explicit.includes(k)) explicit.push(k)
  }
  for (const d of input.selectedDocuments) add(d.id)
  for (const d of input.mentions) add(d.id)
  const placeIds = (await placeDocumentIds(ctx, input.place)) ?? []
  const userChosen = new Set(explicit)

  // Retrieval for the rest (global and search places, and leftover elsewhere).
  const retrieved = await retrieve(ctx, input.question, { limit: MAX_CANDIDATES })
  let candidates = retrieved.filter((id) => !explicit.includes(id))
  if (input.place.kind === 'global' && candidates.length === 0 && explicit.length === 0) candidates = await newestIds(ctx)

  const selectedTranscripts = input.selectedDocuments.length >= 1 && input.selectedDocuments.length <= SELECTED_TRANSCRIPTS_MAX
  const load = async (id: string): Promise<DocPayload | null> =>
    loadPayload(ctx, id, {
      transcript: input.includeTranscripts || (selectedTranscripts && input.selectedDocuments.some((d) => d.id.toLowerCase() === id))
    })

  const chosen: DocPayload[] = []
  const unavailable: string[] = []
  for (const id of explicit) {
    const p = await load(id)
    if (p) chosen.push(p)
    else unavailable.push([...input.selectedDocuments, ...input.mentions].find((d) => d.id.toLowerCase() === id)?.title || 'A deleted note')
  }
  // A folder or search place: its notes, the best matches for the question first.
  const placeDocs: DocPayload[] = []
  for (const id of placeIds.slice(0, MAX_PLACE_DOCS)) {
    const k = id.toLowerCase()
    if (explicit.includes(k)) continue
    const p = await load(k)
    if (p) placeDocs.push(p)
    explicit.push(k)
  }
  chosen.push(...rankPayloads(placeDocs, input.question))
  for (const id of candidates) {
    if (explicit.includes(id)) continue
    const p = await load(id)
    if (p) chosen.push(p)
  }

  const fit = fitDocs(chosen, budget, input.question)
  for (const d of fit.included) {
    index.addNote(d.id, d.title)
    index.addWindows(d.id, d.windows)
  }
  for (const d of chosen) if (fit.listedIds.has(d.id)) index.addNote(d.id, d.title)

  const scanned: Record<string, DocRef> = {}
  for (const d of chosen) if (fit.included.includes(d) || fit.listedIds.has(d.id)) scanned[d.id] = { id: d.id, title: d.title }

  // Context limit: a note the user chose had to be cut or left out.
  let limit: ContextLimit | null = null
  const chosenByUser = chosen.filter((d) => userChosen.has(d.id))
  const cut = chosenByUser.filter((d) => fit.truncatedIds.has(d.id))
  const dropped = chosenByUser.filter((d) => !fit.included.includes(d))
  if (cut.length > 0 || dropped.length > 0 || unavailable.length > 0) {
    limit = {
      filtered: chosenByUser.filter((d) => fit.included.includes(d)).map((d) => d.title),
      unavailable: [...unavailable, ...dropped.map((d) => d.title)],
      excluded: cut.map((d) => d.title)
    }
  }

  const docsText = fit.text ? `## Notes\n${fit.text}` : ''
  return {
    context: [header, docsText].filter(Boolean).join('\n\n'),
    index,
    sources: { totalSources: Object.keys(scanned).length, scannedDocuments: scanned, citationIds: [] },
    limit,
    note: null
  }
}

// ---------- one-note chat ----------

function meetingHeader(inputs: NoteChatInputs): string {
  const v = inputs.vars
  const lines = [`Meeting: ${v['event_name'] || noteTitle(inputs.note)} [${inputs.note.id}]`]
  const when = [v['date'], v['time']].filter(Boolean).join(', ')
  if (when) lines.push(`When: ${when}`)
  if (v['participants']) lines.push(`Participants: ${v['participants']}`)
  const me = [v['author_name'], v['author_company'] ? `(${v['author_company']})` : ''].filter(Boolean).join(' ')
  if (me) lines.push(`The user: ${me}`)
  if (v['counterpart_name']) lines.push(`Others: ${v['counterpart_name']}`)
  if (v['outside_companies']) lines.push(`External companies: ${v['outside_companies']}`)
  if (v['current_date']) lines.push(`Today's date: ${v['current_date']}`)
  return `## This meeting\n${lines.join('\n')}`
}

async function noteContext(
  ctx: MainContext,
  input: AssembleInput,
  inputs: NoteChatInputs,
  total: number
): Promise<Omit<Assembled, 'messages'>> {
  const note = inputs.note
  const title = inputs.vars['event_name'] || noteTitle(note)
  const index = new CitationIndex()
  index.addNote(note.id, title)
  const parts: string[] = [meetingHeader(inputs)]
  if (input.brief?.content.trim()) {
    const cut = truncateLines(input.brief.content.trim(), Math.floor(total * 0.15))
    parts.push(`## Prep brief (prepared from earlier notes)\n${cut.text}`)
  }

  if (input.recipeContexts.includes('upcoming_events')) {
    const now = new Date()
    const events = await ctx.calendar
      .listEvents({ from: now.toISOString(), to: new Date(now.getTime() + 7 * 86_400_000).toISOString() })
      .catch(() => [])
    if (events.length) {
      parts.push(
        `## Upcoming meetings\n${events
          .slice(0, 10)
          .map((e) => `- ${e.summary?.trim() || 'Untitled event'} (${shortDate((e.start as { dateTime?: string } | undefined)?.dateTime)})`)
          .join('\n')}`
      )
    }
  }
  let budget = total - sum(parts)

  const summary = inputs.latestSummaryMarkdown.trim()
  const notes = (note.notes_md?.trim() || note.notes_text?.trim() || '').trim()
  const target = input.target
  const targetText = target?.markdown.trim() ?? ''
  const secondary =
    target?.kind === 'summary'
      ? { label: "The user's own notes", text: notes }
      : target?.kind === 'notes'
        ? { label: 'Latest summary', text: summary }
        : null

  const windows = transcriptWindows(inputs.turns)
  const transcriptLen = windows.reduce((n, w) => n + w.lines.reduce((m, l) => m + l.label.length + l.text.length + 3, 0) + 60, 0)
  const mentionIds = input.mentions.map((m) => m.id.toLowerCase()).filter((id) => id !== note.id)
  const mentionCap = mentionIds.length ? Math.floor(total * MENTIONS_SHARE) : 0

  if (target) {
    const secondaryLen = Math.min(secondary?.text.length ?? 0, Math.floor(total * SECONDARY_SHARE))
    const cap = Math.max(Math.floor(total * TARGET_MIN_SHARE), budget - secondaryLen - transcriptLen - mentionCap)
    const cut = truncateLines(targetText || '(empty)', Math.min(cap, Math.max(0, budget)))
    const label = target.kind === 'summary' ? 'the summary' : "the user's own notes"
    parts.push(`## Target document: ${label} [${note.id}]\n${cut.text}`)
    budget -= cut.text.length + 60
    if (secondary?.text) {
      const s = truncateLines(secondary.text, Math.min(Math.floor(total * SECONDARY_SHARE), Math.max(0, budget)))
      if (s.text.trim()) {
        parts.push(`## ${secondary.label} [${note.id}]\n${s.text}`)
        budget -= s.text.length + 40
      }
    }
  } else {
    // Transcript tab: no target; the summary and the notes as references.
    if (summary) {
      const s = truncateLines(summary, Math.min(Math.floor(total * 0.3), Math.max(0, budget)))
      parts.push(`## Latest summary [${note.id}]\n${s.text}`)
      budget -= s.text.length + 40
    }
    if (notes) {
      const s = truncateLines(notes, Math.min(Math.floor(total * SECONDARY_SHARE), Math.max(0, budget)))
      parts.push(`## The user's own notes [${note.id}]\n${s.text}`)
      budget -= s.text.length + 40
    }
  }

  const scanned: Record<string, DocRef> = { [note.id]: { id: note.id, title } }
  let limit: ContextLimit | null = null
  if (mentionIds.length) {
    const docs: DocPayload[] = []
    const unavailable: string[] = []
    for (const id of mentionIds) {
      const p = await loadPayload(ctx, id, { transcript: input.includeTranscripts })
      if (p) docs.push(p)
      else unavailable.push(input.mentions.find((m) => m.id.toLowerCase() === id)?.title || 'A deleted note')
    }
    const fit = fitDocs(docs, Math.min(mentionCap, Math.max(0, budget - Math.min(transcriptLen, Math.floor(total * 0.25)))), input.question)
    if (fit.text) {
      parts.push(`## Notes the user mentioned\n${fit.text}`)
      budget -= fit.text.length + 30
    }
    for (const d of fit.included) {
      index.addNote(d.id, d.title)
      index.addWindows(d.id, d.windows)
      scanned[d.id] = { id: d.id, title: d.title }
    }
    const dropped = docs.filter((d) => !fit.included.includes(d))
    const cut = docs.filter((d) => fit.truncatedIds.has(d.id))
    if (unavailable.length || dropped.length || cut.length) {
      limit = {
        filtered: fit.included.map((d) => d.title),
        unavailable: [...unavailable, ...dropped.map((d) => d.title)],
        excluded: cut.map((d) => d.title)
      }
    }
  }

  if (windows.length > 0) {
    const fit = fitTranscript(note.id, windows, Math.max(0, budget - 40), { question: input.question, live: input.live })
    if (fit.text) {
      parts.push(`## Transcript${fit.complete ? '' : ' (excerpts; readTranscript fetches more)'}\n${fit.text}`)
      index.addWindows(note.id, fit.included)
    }
  } else {
    parts.push('## Transcript\n(No transcript yet.)')
  }

  return {
    context: parts.join('\n\n'),
    index,
    sources: { totalSources: Object.keys(scanned).length, scannedDocuments: scanned, citationIds: [] },
    limit,
    note: {
      noteId: note.id,
      title,
      target: target?.kind ?? null,
      editTools: false,
      rewriteTool: false,
      selection: !!input.selection?.trim(),
      quickEdit: input.editWithAi,
      live: input.live,
      latestSummaryPanelId: inputs.latestSummaryPanelId
    }
  }
}

// ---------- the stored message context ----------

function hasExtras(c: ChatContext): boolean {
  const a = c.additionalContext
  return !!(a?.pickedNotes?.length || a?.mentionedNotes?.length || a?.changedBlocks?.length)
}

function sameView(a: ChatViewContext, b: ChatViewContext): boolean {
  if (a.view !== b.view) return false
  if (a.view === 'global') return true
  if (a.view === 'list' && b.view === 'list') return a.folderId === b.folderId
  if (a.view === 'search' && b.view === 'search') return a.query === b.query && a.type === b.type
  if ((a.view === 'meeting' && b.view === 'meeting') || (a.view === 'live-meeting' && b.view === 'live-meeting')) {
    return a.meetingId === b.meetingId && a.prepBrief === b.prepBrief
  }
  return false
}

/**
 * The context a new user message stores: attached only when it changed. Always for
 * the first message, a selection or selected documents; with only new mentions, the
 * earlier context plus the mentions; otherwise none when the place is the same.
 */
export function contextToStore(
  earlier: readonly ChatMessage[],
  next: ChatContext,
  opts: { selection: boolean; selectedDocuments: boolean; mentions: DocRef[] }
): ChatContext | null {
  const users = earlier.filter((m) => m.role === 'user')
  if (users.length === 0 || opts.selection || opts.selectedDocuments) return next
  const base = users.find((m) => m.context && !hasExtras(m.context))?.context
  if (!base || !sameView(base.activeView, next.activeView)) return next
  if (opts.mentions.length > 0) return { ...base, additionalContext: { mentionedNotes: opts.mentions } }
  return null
}
