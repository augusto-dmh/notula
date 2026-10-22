// SPDX-License-Identifier: Apache-2.0
// What the post-summary features (action items, classification, follow-up drafts)
// read about a note: its latest summary, its people with the external rule, the
// transcript cut to a budget (the end of the meeting kept), and one JSON-reply LLM call.

import { externalAttendees } from '@shared/lib/people'
import { SUGGESTED_ACTIONS_SLUG } from '@shared/types/enhance'
import type { CalendarAttendee, CalendarEvent, Note } from '@shared/types/notes'
import type { Panel } from '@shared/types/panels'
import type { MainContext } from '../context'
import { currentProvider } from '../llm/registry'
import { MAX_TOKENS, type LlmProvider, type LlmPurpose } from '../llm/types'
import { egressBlocked, LOCAL_ONLY_REASON } from '../privacy'
import { readerTranscript } from '../sources/reader'
import { transcriptionControl } from '../transcription'
import { unavailableError } from './generation'
import { formatTranscript } from './transcript'

/** About 4 characters per token; the transcript gets at most this share of the window. */
const TRANSCRIPT_SHARE = 0.5
const CHARS_PER_TOKEN = 3.5
/** Without a known window (OpenAI-compatible, local): a conservative 32k-token model. */
const DEFAULT_WINDOW_TOKENS = 32_000
const MAX_TRANSCRIPT_CHARS = 600_000

export interface Participant {
  name: string
  email: string
  external: boolean
}

export interface NotePeopleContext {
  me: { name: string; email: string }
  attendees: Participant[]
}

/** The newest summary panel with content (not the suggested-actions panel). */
export function latestSummary(panels: Panel[]): Panel | null {
  let best: Panel | null = null
  for (const p of panels) {
    if (p.deleted_at || p.template_key === SUGGESTED_ACTIONS_SLUG) continue
    const text = (p.content_markdown ?? p.generated_content ?? '').trim()
    if (!text) continue
    if (!best || p.created_at > best.created_at) best = p
  }
  return best
}

export function panelMarkdown(p: Panel | null): string {
  return (p?.content_markdown ?? p?.generated_content ?? '').trim()
}

/** The user (profile) and every attendee of the note's event and its people, marked external or internal. */
export async function notePeople(ctx: MainContext, note: Note): Promise<NotePeopleContext> {
  const settings = await ctx.settings.getAll()
  const myEmails = await ctx.calendar.myEmails().catch(() => [settings['profile.email']])
  const mine = new Set(myEmails.map((e) => e.trim().toLowerCase()).filter(Boolean))
  const event = (note.linked_event ?? {}) as CalendarEvent
  const fromEvent = Array.isArray(event.attendees) ? event.attendees : []
  const fromPeople: CalendarAttendee[] = (note.people?.attendees ?? [])
    .filter((p) => typeof p.email === 'string' && p.email.includes('@'))
    .map((p) => ({ email: p.email as string, ...(p.name ? { displayName: p.name } : {}) }))
  const merged: CalendarEvent = { ...event, id: event.id ?? note.id, attendees: [...fromEvent, ...fromPeople] }
  const external = new Set(
    externalAttendees(merged, [...mine], settings['people.genericEmailDomains']).map((a) => a.email.trim().toLowerCase())
  )
  const seen = new Set<string>()
  const attendees: Participant[] = []
  for (const a of merged.attendees ?? []) {
    const email = typeof a?.email === 'string' ? a.email.trim() : ''
    const key = email.toLowerCase()
    if (!email || a.self || a.resource || mine.has(key) || seen.has(key)) continue
    seen.add(key)
    attendees.push({ name: (a.displayName ?? '').trim() || email, email, external: external.has(key) })
  }
  return { me: { name: settings['profile.name'].trim(), email: settings['profile.email'].trim() }, attendees }
}

export function personLine(p: { name: string; email: string }): string {
  return p.name && p.email && p.name !== p.email ? `${p.name} <${p.email}>` : p.name || p.email
}

/** The note's date in a readable form, from its event or its creation time. */
export function noteDate(note: Note): string {
  const start = note.linked_event?.start
  const d = new Date(start?.dateTime ?? start?.date ?? note.created_at)
  return Number.isFinite(d.getTime()) ? d.toLocaleString('en-US', { dateStyle: 'full', ...(start?.dateTime || !start ? { timeStyle: 'short' } : {}) }) : ''
}

/** The speaker-labelled transcript, cut from the start to `maxChars` (the end of the meeting is kept). */
export async function transcriptFor(ctx: MainContext, noteId: string, maxChars: number): Promise<{ text: string; fullLength: number }> {
  const wordLevel = await ctx.settings.get('transcription.diarization').catch(() => false)
  const chunks = await readerTranscript(ctx, noteId, await transcriptionControl(ctx).getTranscript(noteId))
  const text = formatTranscript(chunks, { wordLevel }).text
  if (text.length <= maxChars) return { text, fullLength: text.length }
  const cut = text.slice(text.length - maxChars)
  const lineStart = cut.indexOf('\n')
  return { text: `[… the start of the transcript was cut]\n${lineStart >= 0 ? cut.slice(lineStart + 1) : cut}`, fullLength: text.length }
}

/** The transcript budget in characters for this provider. */
export async function transcriptBudget(provider: LlmProvider): Promise<number> {
  const window = (await provider.contextWindow().catch(() => null)) ?? DEFAULT_WINDOW_TOKENS
  return Math.min(MAX_TRANSCRIPT_CHARS, Math.max(4_000, Math.floor(window * TRANSCRIPT_SHARE * CHARS_PER_TOKEN)))
}

export class JsonTaskError extends Error {
  constructor(
    readonly reason: 'local-only' | 'unavailable' | 'no-json' | 'provider',
    message: string
  ) {
    super(message)
    this.name = 'JsonTaskError'
  }
}

/** The user's provider, or a JsonTaskError: local-only mode with a cloud provider, or not set up. */
export async function readyProvider(ctx: MainContext): Promise<LlmProvider> {
  if (await egressBlocked(ctx, { kind: 'llm' })) throw new JsonTaskError('local-only', LOCAL_ONLY_REASON)
  const provider = await currentProvider(ctx.settings, ctx.secrets)
  const availability = await provider.available()
  if (!availability.ok) throw new JsonTaskError('unavailable', unavailableError(availability.reason, provider).message)
  return provider
}

/** The first top-level JSON object in a reply (fences and prose around it are ignored). */
export function parseJsonObject(reply: string): Record<string, unknown> | null {
  const text = reply.replace(/```(?:json)?/gi, '')
  for (let start = text.indexOf('{'); start !== -1; start = text.indexOf('{', start + 1)) {
    let depth = 0
    let inString = false
    for (let i = start; i < text.length; i++) {
      const c = text[i]
      if (inString) {
        if (c === '\\') i++
        else if (c === '"') inString = false
        continue
      }
      if (c === '"') inString = true
      else if (c === '{') depth++
      else if (c === '}' && --depth === 0) {
        try {
          const v: unknown = JSON.parse(text.slice(start, i + 1))
          if (typeof v === 'object' && v !== null && !Array.isArray(v)) return v as Record<string, unknown>
        } catch {
          // keep looking
        }
        break
      }
    }
  }
  return null
}

/** One non-streaming call with a JSON reply. Rejects with a JsonTaskError. */
export async function runJsonTask(
  provider: LlmProvider,
  req: { purpose: LlmPurpose; system: string; user: string; timeoutMs: number; signal?: AbortSignal }
): Promise<Record<string, unknown>> {
  const signal = req.signal ? AbortSignal.any([req.signal, AbortSignal.timeout(req.timeoutMs)]) : AbortSignal.timeout(req.timeoutMs)
  let reply: string
  try {
    reply = await provider.complete({ purpose: req.purpose, system: req.system, user: req.user, maxTokens: MAX_TOKENS[req.purpose] }, signal)
  } catch (err) {
    const message = signal.aborted ? 'The AI provider stopped responding.' : err instanceof Error ? err.message : String(err)
    throw new JsonTaskError('provider', message)
  }
  const parsed = parseJsonObject(reply)
  if (!parsed) throw new JsonTaskError('no-json', 'The AI model did not answer in the expected format.')
  return parsed
}
