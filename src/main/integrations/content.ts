// SPDX-License-Identifier: Apache-2.0
// DOM-free serializers for integration content. Automations read the
// summary panel's stored `content_markdown`; HTML comes from `marked`, plain text from
// the lexer below. Manual sends bring the renderer's three serializations instead.

import { marked, type Token, type Tokens } from 'marked'
import type { CalendarEvent, Note } from '@shared/types/notes'
import type { Panel } from '@shared/types/panels'
import type { IntegrationShareContent } from '@shared/types/integrations'

export const UNTITLED = 'Untitled note'

export function noteTitle(note: Pick<Note, 'title'> | null): string {
  return note?.title?.trim() || UNTITLED
}

export function panelMarkdown(p: Panel | null): string {
  return (p?.content_markdown ?? p?.generated_content ?? '').trim()
}

/** The latest summary with content: newest content time first. */
export function latestSummaryPanel(panels: Panel[]): Panel | null {
  const done = panels.filter((p) => !p.deleted_at && p.content_edited_at && !p.enhance_failed_at && panelMarkdown(p))
  done.sort((a, b) => String(b.content_edited_at).localeCompare(String(a.content_edited_at)))
  return done[0] ?? null
}

export function markdownToHtml(md: string): string {
  // Raw HTML in a summary is rendered as text: integrations never forward markup they did not build.
  const escaped = md.replace(/</g, '&lt;')
  return (marked.parse(escaped, { async: false, gfm: true, breaks: false }) as string).trim()
}

function inlineText(tokens: Token[] | undefined): string {
  let out = ''
  for (const t of tokens ?? []) {
    if (t.type === 'image') out += '[image]'
    else if (t.type === 'br') out += '\n'
    else if ('tokens' in t && Array.isArray(t.tokens)) out += inlineText(t.tokens)
    else if (t.type === 'escape' || t.type === 'text' || t.type === 'codespan') out += (t as Tokens.Text).text
    else if ('text' in t && typeof t.text === 'string') out += t.text
  }
  return out
}

function blockText(tokens: Token[], depth: number, out: string[]): void {
  for (const t of tokens) {
    switch (t.type) {
      case 'heading':
      case 'paragraph':
        out.push(inlineText((t as Tokens.Heading).tokens))
        break
      case 'list': {
        const l = t as Tokens.List
        l.items.forEach((item, i) => {
          const sub: string[] = []
          blockText(item.tokens, depth + 1, sub)
          const bullet = l.ordered ? `${Number(l.start || 1) + i}.` : '-'
          const [first = '', ...rest] = sub
          out.push(`${'  '.repeat(depth)}${bullet} ${item.task ? (item.checked ? '[x] ' : '[ ] ') : ''}${first.trimStart()}`, ...rest)
        })
        break
      }
      case 'blockquote':
        blockText((t as Tokens.Blockquote).tokens, depth, out)
        break
      case 'code':
        out.push((t as Tokens.Code).text)
        break
      case 'table':
        out.push('[table]')
        break
      case 'hr':
        out.push('---')
        break
      case 'text':
        out.push('tokens' in t && Array.isArray(t.tokens) ? inlineText(t.tokens) : (t as Tokens.Text).text)
        break
      case 'space':
        break
      default:
        if ('text' in t && typeof t.text === 'string') out.push(t.text)
    }
  }
}

export function markdownToText(md: string): string {
  const out: string[] = []
  blockText(marked.lexer(md, { gfm: true }), 0, out)
  return out.filter((l, i, a) => l.trim() !== '' || (i > 0 && a[i - 1]?.trim() !== '')).join('\n').trim()
}

export function contentFromMarkdown(md: string): IntegrationShareContent {
  return { markdown: md, html: markdownToHtml(md), text: markdownToText(md) }
}

/** Renderer content, bounded and typed; never used as a path or URL. */
export function sanitizeContent(c: unknown): IntegrationShareContent | null {
  if (!c || typeof c !== 'object') return null
  const o = c as Record<string, unknown>
  const pick = (k: string): string => (typeof o[k] === 'string' ? (o[k] as string).slice(0, 2_000_000) : '')
  const out = { html: pick('html'), text: pick('text'), markdown: pick('markdown') }
  return out.markdown.trim() || out.text.trim() || out.html.trim() ? out : null
}

/** The meeting start (calendar event start), else the note's creation time. */
export function meetingStart(note: Pick<Note, 'linked_event' | 'created_at'>): string {
  const ev: CalendarEvent | null = note.linked_event
  const s = ev?.start?.dateTime ?? ev?.start?.date
  const t = s ? Date.parse(s) : NaN
  return Number.isFinite(t) ? new Date(t).toISOString() : note.created_at
}

export function meetingEnd(note: Pick<Note, 'linked_event'>): string | null {
  const ev: CalendarEvent | null = note.linked_event
  const s = ev?.end?.dateTime ?? ev?.end?.date
  const t = s ? Date.parse(s) : NaN
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** The preview date (en-US weekday short, day, month long, year). */
export function previewDate(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' })
}

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}
