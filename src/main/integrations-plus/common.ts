// SPDX-License-Identifier: Apache-2.0
// What the Salesforce, Pipedrive and Ashby plug-ins share: structured secrets, request pacing,
// the note content with
// its lead line, the HTML subset CRMs accept, and the delivery rows a save becomes.

import { STRUCTURED_SECRET_PREFIX, type SecretId } from '@shared/types/settings'
import type { IntegrationProvider, IntegrationShareRequest, IntegrationTarget } from '@shared/types/integrations'
import type { Note } from '@shared/types/notes'
import type { MainContext } from '../context'
import { latestSummaryPanel, markdownToHtml, markdownToText, meetingStart, noteTitle, panelMarkdown, previewDate } from '../integrations/content'
import type { NewIntegrationDelivery } from '../storage/api'

export function encodeSecret(v: unknown): string {
  return STRUCTURED_SECRET_PREFIX + Buffer.from(JSON.stringify(v), 'utf8').toString('base64url')
}

export function decodeSecret<T>(raw: string | null): T | null {
  if (!raw?.startsWith(STRUCTURED_SECRET_PREFIX)) return null
  try {
    return JSON.parse(Buffer.from(raw.slice(STRUCTURED_SECRET_PREFIX.length), 'base64url').toString('utf8')) as T
  } catch {
    return null
  }
}

export async function readSecret<T>(ctx: MainContext, id: SecretId): Promise<T | null> {
  return decodeSecret<T>(await ctx.secrets.get(id))
}

/** At most `perSec` requests per second per provider. */
const lastAt = new Map<string, number[]>()
export async function pace(key: string, perSec: number): Promise<void> {
  for (;;) {
    const now = Date.now()
    const recent = (lastAt.get(key) ?? []).filter((t) => now - t < 1_000)
    if (recent.length < perSec) {
      recent.push(now)
      lastAt.set(key, recent)
      return
    }
    await new Promise((r) => setTimeout(r, 1_000 - (now - (recent[0] ?? now)) + 5))
  }
}

export interface NoteContent {
  note: Note
  title: string
  markdown: string
  html: string
  text: string
  /** "<title> · <meeting date>". */
  lead: string
  start: string
  end: string | null
}

/** The note and its summary panel (the given one, else the latest with content). */
export async function noteContent(ctx: MainContext, noteId: string, panelId: string | null): Promise<NoteContent | null> {
  const note = await ctx.storage.getNote(noteId)
  if (!note) return null
  const panels = await ctx.storage.listPanels(noteId)
  const panel = (panelId ? panels.find((p) => p.id === panelId && !p.deleted_at && panelMarkdown(p)) : null) ?? latestSummaryPanel(panels)
  const markdown = panelMarkdown(panel ?? null)
  if (!markdown) return null
  const start = meetingStart(note)
  const ev = note.linked_event
  const endRaw = ev?.end?.dateTime ?? ev?.end?.date
  const endMs = endRaw ? Date.parse(endRaw) : NaN
  const title = noteTitle(note)
  return {
    note,
    title,
    markdown,
    html: markdownToHtml(markdown),
    text: markdownToText(markdown),
    lead: `${title} · ${previewDate(start)}`,
    start,
    end: Number.isFinite(endMs) ? new Date(endMs).toISOString() : null
  }
}

const esc = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/** Paragraphs, headings as bold paragraphs, lists, bold, italic and links; everything else is text. */
export function crmHtml(html: string, lead: string): string {
  let out = html
    .replace(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi, '<p><b>$1</b></p>')
    .replace(/<(\/?)strong>/gi, '<$1b>')
    .replace(/<(\/?)em>/gi, '<$1i>')
    .replace(/<a\s+[^>]*href="(https?:[^"]*)"[^>]*>/gi, (_m, href: string) => `<a href="${href}">`)
  out = out.replace(/<(?!\/?(p|b|i|ul|ol|li|br|a)(\s|>|\/))[^>]*>/gi, '')
  return `<p><b>${esc(lead)}</b></p>${out}`
}

/** Selected targets as one comma-joined key (`kind:id,…`), each kind and id checked. */
export function targetKey(targets: IntegrationTarget[] | undefined, kinds: readonly string[], idPattern: RegExp): string {
  const parts = (targets ?? []).filter((t) => t && kinds.includes(t.kind) && typeof t.id === 'string' && idPattern.test(t.id)).map((t) => `${t.kind}:${t.id}`)
  return [...new Set(parts)].slice(0, 50).join(',')
}

export function parseTargets(key: string): { kind: string; id: string }[] {
  return key
    .split(',')
    .map((p) => {
      const i = p.indexOf(':')
      return i > 0 ? { kind: p.slice(0, i), id: p.slice(i + 1) } : null
    })
    .filter((x): x is { kind: string; id: string } => !!x && !!x.id)
}

/** One manual delivery row for a save (the integration layer adds the provider and queues it). */
export function manualRow(provider: IntegrationProvider, req: IntegrationShareRequest, key: string): NewIntegrationDelivery {
  return { provider, destinationId: null, automationId: null, noteId: req.noteId, panelId: req.panelId ?? null, targetKey: key, trigger: 'manual', status: 'pending', nextAttemptAt: new Date().toISOString() }
}

/** One automatic (folder) row. */
export function folderRow(provider: IntegrationProvider, noteId: string, panelId: string | null, key: string): NewIntegrationDelivery {
  return { provider, destinationId: null, automationId: null, noteId, panelId, targetKey: key, trigger: 'folder', status: 'pending', nextAttemptAt: new Date().toISOString() }
}

export function hhmm(ms: number): string {
  const mins = Math.max(0, Math.round(ms / 60_000))
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`
}
