// SPDX-License-Identifier: Apache-2.0
// Copying note content. One clipboard item, two
// flavors:
// - text/html: the content wrapped with the note header, then reshaped for chat
//   apps: inline heading sizes, unwrapped list paragraphs, Slack's list attributes;
// - text/plain: the same header-wrapped content as markdown (the one serializer), with
//   link targets removed.
// Writes are awaited: the renderer's Clipboard API first, main's `clipboard:write` as the
// fallback, so a failure reaches the caller's toast.

import type { Note } from '@shared/types/notes'
import { debugLog } from '../app/platform'
import { htmlToMarkdown, stripLinkTargets } from './markdown'

/** What a header-wrapped copy puts above the content (NotulaEditorProps.copyHeader). */
export interface CopyHeader {
  title: string | null
  date: string | null
  attendees: string[]
}

const ZERO_WIDTH_SPACE = /​/g
/** No-break space, middle dot, no-break space. */
const HEADER_SEPARATOR = ' · '
const HEADING_SIZE: Record<string, string> = { h1: '14pt', h2: '12pt' }
const HEADING_SIZE_DEFAULT = '11pt'

// ---------- the header ----------

/** A date-only start is the event's calendar date in local time, never shifted through UTC. */
function localDate(value: string): Date | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim())
  if (m) return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? null : d
}

/** Event start date-time, else start date, else creation time; en-GB `Thu, 15 Oct 26`. */
export function copyHeaderDate(note: Pick<Note, 'linked_event' | 'created_at'>): string | null {
  const start = note.linked_event?.start
  let d: Date | null = null
  if (start?.dateTime) d = localDate(start.dateTime)
  else if (start?.date) d = localDate(start.date)
  d ??= localDate(note.created_at)
  if (!d) return null
  return new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: '2-digit' }).format(d)
}

/** `people.attendees` by name, else email; the creator is not included. */
export function copyHeaderFor(note: Pick<Note, 'title' | 'linked_event' | 'created_at' | 'people'>): CopyHeader {
  const attendees = (note.people?.attendees ?? [])
    .map((a) => a.name?.trim() || a.email?.trim() || '')
    .filter((a) => a !== '')
  return { title: note.title, date: copyHeaderDate(note), attendees }
}

/**
 * Headings h1–h5 move one level down (attributes dropped, h6 stays); a paragraph
 * with `date · attendees` goes first (always present); a non-empty title becomes an h1
 * above it.
 */
function wrapWithHeader(doc: Document, header: CopyHeader): void {
  for (const h of Array.from(doc.body.querySelectorAll('h1, h2, h3, h4, h5'))) {
    const lower = doc.createElement(`h${Number(h.localName[1]) + 1}`)
    while (h.firstChild) lower.appendChild(h.firstChild)
    h.replaceWith(lower)
  }
  const meta = doc.createElement('p')
  meta.textContent = [header.date ?? '', header.attendees.join(', ')].filter((part) => part !== '').join(HEADER_SEPARATOR)
  doc.body.insertBefore(meta, doc.body.firstChild)
  if (header.title && header.title.trim() !== '') {
    const title = doc.createElement('h1')
    title.textContent = header.title
    doc.body.insertBefore(title, meta)
  }
}

// ---------- the text/html flavor ----------

function headingStyle(h: Element): void {
  const kept = (h.getAttribute('style') ?? '')
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d !== '' && !/^font-(weight|size)\s*:/i.test(d))
  kept.push('font-weight: 700', `font-size: ${HEADING_SIZE[h.localName] ?? HEADING_SIZE_DEFAULT}`)
  h.setAttribute('style', `${kept.join('; ')};`)
}

function isList(el: Element): boolean {
  return el.localName === 'ul' || el.localName === 'ol'
}

/** Slack's list attributes, top-level lists at depth 0 and lists inside an item one deeper. */
function annotateList(listEl: Element, depth: number): void {
  listEl.setAttribute('data-stringify-type', listEl.localName === 'ol' ? 'ordered-list' : 'unordered-list')
  listEl.setAttribute('data-nested-list', 'true')
  listEl.setAttribute('data-indent', String(depth))
  listEl.setAttribute('data-border', '0')
  for (const li of Array.from(listEl.children)) {
    if (li.localName !== 'li') continue
    li.setAttribute('data-stringify-indent', String(depth))
    for (const nested of Array.from(li.children)) if (isList(nested)) annotateList(nested, depth + 1)
  }
}

/**
 * Reshapes the HTML for chat apps. Notula's schema has no action-item paragraphs, so
 * lists need no action-item step.
 */
function transformForChatApps(root: Element): void {
  for (const h of Array.from(root.querySelectorAll('h1, h2, h3, h4, h5, h6'))) headingStyle(h)
  for (const li of Array.from(root.querySelectorAll('li'))) {
    for (const p of Array.from(li.children)) {
      if (p.localName === 'p') p.replaceWith(...Array.from(p.childNodes))
    }
  }
  for (const listEl of Array.from(root.querySelectorAll('ul, ol'))) {
    listEl.removeAttribute('class')
    listEl.removeAttribute('data-tight')
  }
  for (const listEl of Array.from(root.querySelectorAll('ul, ol'))) {
    if (!listEl.parentElement?.closest('li')) annotateList(listEl, 0)
  }
}

export interface CopyFlavors {
  html: string
  text: string
}

/**
 * Both flavors of `html` (the schema's HTML for the copied content). With a header the
 * HTML is a full XHTML document; without one (a partial selection) it is
 * the transformed fragment.
 */
export function copyFlavors(html: string, header: CopyHeader | null): CopyFlavors {
  const doc = new DOMParser().parseFromString(html.replace(ZERO_WIDTH_SPACE, ''), 'text/html')
  if (header) wrapWithHeader(doc, header)
  // The plain flavor reads the header-wrapped HTML before the chat-app reshaping.
  const text = stripLinkTargets(htmlToMarkdown(doc.body))
  transformForChatApps(doc.body)
  return { html: header ? new XMLSerializer().serializeToString(doc) : doc.body.innerHTML, text }
}

// ---------- writing ----------

/** Both flavors as one item, awaited; main's `clipboard:write` when the Clipboard API rejects. */
export async function writeCopyFlavors(flavors: CopyFlavors): Promise<void> {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob([flavors.html], { type: 'text/html' }),
        'text/plain': new Blob([flavors.text], { type: 'text/plain' })
      })
    ])
  } catch (err) {
    debugLog('clipboard-write-fallback', { err: String(err) })
    await window.notula.clipboard.write({ html: flavors.html, text: flavors.text })
  }
}

/** Plain text (the transcript), awaited; main's `clipboard:copy-text` as the fallback. */
export async function writeCopyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
  } catch (err) {
    debugLog('clipboard-write-text-fallback', { err: String(err) })
    await window.notula.clipboard.writeText({ text })
  }
}
