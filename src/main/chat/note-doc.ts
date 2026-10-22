// SPDX-License-Identifier: Apache-2.0
// Event-note writes from chat (`appendToEventNote`, `editEventNote`): main edits a note's
// own notes through the note document path (its Yjs room), never by rewriting the stored
// markdown. The change is one Yjs
// update appended to the room `notes:1:<noteId>`, pushed to every window as
// `ydoc:updated` (an open editor applies it like any remote edit), and the note's
// markdown projection is brought along so search and chat see it at once; the editor
// rewrites the exact projection the next time the note is open.
//
// Only the notes schema's own nodes are written (paragraph, heading 1–2, bullet,
// ordered and task lists, horizontal rule) with the marks bold, italic, strike and
// link: an element the schema does not know would be dropped by the editor binding.

import * as Y from 'yjs'
import type { PushChannel } from '@shared/ipc'
import { YDOC_FRAGMENT, YDOC_ROOM_VERSION, type YdocUpdated } from '@shared/types/ydoc'
import type { MainContext } from '../context'
import { log } from '../log'

const ORIGIN = 'main:chat'

type Marks = Record<string, Record<string, unknown>>
type Segment = { text: string; marks: Marks }

function roomOf(noteId: string): string {
  return `notes:${YDOC_ROOM_VERSION}:${noteId}`
}

// ---------- markdown subset → segments ----------

const INLINE = /(\*\*|__)(.+?)\1|~~(.+?)~~|(\*|_)(?=\S)(.+?)(?<=\S)\4|`([^`]+)`|\[([^\]]+)\]\(([^)\s]+)\)/u

function allowedHref(href: string): boolean {
  return /^(https?:\/\/|mailto:)/i.test(href)
}

/** Inline markdown as text runs with marks (code spans become plain text: the notes schema has no code mark). */
export function inlineSegments(text: string, inherited: Marks = {}): Segment[] {
  const out: Segment[] = []
  let rest = text
  while (rest) {
    const m = INLINE.exec(rest)
    if (!m) {
      out.push({ text: rest, marks: inherited })
      break
    }
    if (m.index > 0) out.push({ text: rest.slice(0, m.index), marks: inherited })
    if (m[2] !== undefined) out.push(...inlineSegments(m[2], { ...inherited, bold: {} }))
    else if (m[3] !== undefined) out.push(...inlineSegments(m[3], { ...inherited, strike: {} }))
    else if (m[5] !== undefined) out.push(...inlineSegments(m[5], { ...inherited, italic: {} }))
    else if (m[6] !== undefined) out.push({ text: m[6], marks: inherited })
    else if (m[7] !== undefined && m[8] !== undefined) {
      out.push(...inlineSegments(m[7], allowedHref(m[8]) ? { ...inherited, link: { href: m[8] } } : inherited))
    }
    rest = rest.slice(m.index + m[0].length)
  }
  return out.filter((s) => s.text.length > 0)
}

/** The plain text of inline markdown. */
export function inlinePlain(text: string): string {
  return inlineSegments(text)
    .map((s) => s.text)
    .join('')
}

function textNode(text: string): Y.XmlText {
  const t = new Y.XmlText()
  let at = 0
  for (const s of inlineSegments(text)) {
    t.insert(at, s.text, s.marks)
    at += s.text.length
  }
  return t
}

function paragraph(text: string): Y.XmlElement {
  const p = new Y.XmlElement('paragraph')
  if (text) p.insert(0, [textNode(text)])
  return p
}

type Block =
  | { kind: 'p'; text: string }
  | { kind: 'h'; level: 1 | 2; text: string }
  | { kind: 'hr' }
  | { kind: 'ul' | 'ol'; items: string[] }
  | { kind: 'task'; items: { text: string; checked: boolean }[] }

/** A markdown subset as blocks: headings, lists, task lists, rules and paragraphs. */
export function parseBlocks(markdown: string): Block[] {
  const blocks: Block[] = []
  let para: string[] = []
  const flush = (): void => {
    if (para.length) blocks.push({ kind: 'p', text: para.join(' ') })
    para = []
  }
  for (const raw of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim()
    if (/^(```|~~~)/.test(line)) continue
    if (!line) {
      flush()
      continue
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line)
    if (h) {
      flush()
      blocks.push({ kind: 'h', level: (h[1] as string).length === 1 ? 1 : 2, text: (h[2] ?? '').trim() })
      continue
    }
    if (/^([-*_])(\s*\1){2,}$/.test(line)) {
      flush()
      blocks.push({ kind: 'hr' })
      continue
    }
    const task = /^[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line)
    if (task) {
      flush()
      const last = blocks[blocks.length - 1]
      const item = { text: (task[2] ?? '').trim(), checked: (task[1] ?? ' ').toLowerCase() === 'x' }
      if (last?.kind === 'task') last.items.push(item)
      else blocks.push({ kind: 'task', items: [item] })
      continue
    }
    const bullet = /^[-*+]\s+(.*)$/.exec(line)
    const ordered = /^\d+[.)]\s+(.*)$/.exec(line)
    if (bullet || ordered) {
      flush()
      const kind = bullet ? 'ul' : 'ol'
      const text = ((bullet ?? ordered) as RegExpExecArray)[1]?.trim() ?? ''
      const last = blocks[blocks.length - 1]
      if (last && last.kind === kind) last.items.push(text)
      else blocks.push({ kind, items: [text] })
      continue
    }
    para.push(line.replace(/^>\s?/, ''))
  }
  flush()
  return blocks
}

function blockElements(blocks: Block[]): Y.XmlElement[] {
  return blocks.map((b) => {
    switch (b.kind) {
      case 'p':
        return paragraph(b.text)
      case 'h': {
        const h = new Y.XmlElement('heading')
        h.setAttribute('level', b.level as unknown as string)
        if (b.text) h.insert(0, [textNode(b.text)])
        return h
      }
      case 'hr':
        return new Y.XmlElement('horizontalRule')
      case 'ul':
      case 'ol': {
        const list = new Y.XmlElement(b.kind === 'ul' ? 'bulletList' : 'orderedList')
        if (b.kind === 'ol') list.setAttribute('start', 1 as unknown as string)
        list.insert(
          0,
          b.items.map((text) => {
            const li = new Y.XmlElement('listItem')
            li.insert(0, [paragraph(text)])
            return li
          })
        )
        return list
      }
      case 'task': {
        const list = new Y.XmlElement('taskList')
        list.insert(
          0,
          b.items.map((item) => {
            const li = new Y.XmlElement('taskItem')
            li.setAttribute('checked', item.checked as unknown as string)
            li.insert(0, [paragraph(item.text)])
            return li
          })
        )
        return list
      }
    }
  })
}

/** Markdown as plain text, for the `notes_text` projection. */
export function markdownPlain(markdown: string): string {
  return parseBlocks(markdown)
    .map((b) =>
      b.kind === 'p' || b.kind === 'h'
        ? inlinePlain(b.text)
        : b.kind === 'hr'
          ? ''
          : b.kind === 'task'
            ? b.items.map((i) => inlinePlain(i.text)).join('\n')
            : b.items.map((i) => inlinePlain(i)).join('\n')
    )
    .filter(Boolean)
    .join('\n')
}

// ---------- the room ----------

interface Loaded {
  doc: Y.Doc
  fragment: Y.XmlFragment
  roomId: string
}

async function load(ctx: MainContext, noteId: string): Promise<Loaded> {
  const roomId = roomOf(noteId)
  const state = await ctx.storage.loadYdoc(roomId)
  const doc = new Y.Doc()
  if (state.update) Y.applyUpdate(doc, state.update)
  return { doc, fragment: doc.getXmlFragment(YDOC_FRAGMENT), roomId }
}

/** Stores the change as one update and pushes it to every window. */
async function commit(ctx: MainContext, l: Loaded, change: () => void): Promise<void> {
  const before = Y.encodeStateVector(l.doc)
  l.doc.transact(change)
  const update = Y.encodeStateAsUpdate(l.doc, before)
  const { seq } = await ctx.storage.appendYdoc(l.roomId, update, ORIGIN)
  const payload: YdocUpdated = { roomId: l.roomId, update, seq, origin: ORIGIN }
  for (const wc of ctx.windows.targets()) wc.send('ydoc:updated' satisfies PushChannel, payload)
}

/** A room that was never opened has no content even when the note has text: the editor seeds it first. */
function unseeded(fragment: Y.XmlFragment, note: { notes_md: string | null; notes_text: string | null }): boolean {
  return fragment.length === 0 && !!(note.notes_md?.trim() || note.notes_text?.trim())
}

export const UNSEEDED_MESSAGE = 'Open this note in Notula once, then try again: its notes have not been loaded into the editor yet.'

/** Appends markdown to the end of the note's own notes. */
export async function appendToNote(ctx: MainContext, noteId: string, markdown: string): Promise<'appended' | 'unseeded' | 'empty'> {
  const note = await ctx.storage.getNote(noteId)
  if (!note || note.deleted_at) throw new Error('That note was not found.')
  const blocks = parseBlocks(markdown)
  if (blocks.length === 0) return 'empty'
  const l = await load(ctx, noteId)
  if (unseeded(l.fragment, note)) return 'unseeded'
  await commit(ctx, l, () => {
    // A fresh room's single empty paragraph is replaced rather than kept above the text.
    const only = l.fragment.length === 1 ? l.fragment.get(0) : null
    if (only instanceof Y.XmlElement && only.nodeName === 'paragraph' && only.length === 0) l.fragment.delete(0, 1)
    l.fragment.insert(l.fragment.length, blockElements(blocks))
  })
  const md = [note.notes_md?.trimEnd() ?? '', markdown.trim()].filter(Boolean).join('\n\n')
  const plain = [note.notes_text?.trimEnd() ?? '', markdownPlain(markdown)].filter(Boolean).join('\n')
  await ctx.storage.updateNote(noteId, { notes_md: md, notes_text: plain }).catch((err: unknown) => {
    log('warn', 'chat:event-note-projection-failed', { noteId, err })
  })
  return 'appended'
}

/** The text runs of every block, depth first. */
function textRuns(node: Y.XmlFragment | Y.XmlElement, out: Y.XmlText[] = []): Y.XmlText[] {
  for (const child of node.toArray()) {
    if (child instanceof Y.XmlText) out.push(child)
    else if (child instanceof Y.XmlElement) textRuns(child, out)
  }
  return out
}

function runText(t: Y.XmlText): string {
  return t
    .toDelta()
    .map((d: { insert?: unknown }) => (typeof d.insert === 'string' ? d.insert : ''))
    .join('')
}

/** What the model may have copied from the markdown, reduced to the run's plain text. */
function candidates(text: string): string[] {
  const t = text.trim()
  const noLead = t.replace(/^(#{1,6}\s+|[-*+]\s+\[[ xX]\]\s+|[-*+]\s+|\d+[.)]\s+)/, '')
  return [...new Set([text, t, noLead, inlinePlain(noLead)])].filter((c) => c.length > 0)
}

/**
 * Replaces the first occurrence of `before` with `after` inside one paragraph, heading or
 * list item (the first match wins; an empty `after` deletes).
 */
export async function replaceInNote(
  ctx: MainContext,
  noteId: string,
  before: string,
  after: string
): Promise<'replaced' | 'not-found' | 'multi-block' | 'unseeded'> {
  if (before.trim().includes('\n')) return 'multi-block'
  const note = await ctx.storage.getNote(noteId)
  if (!note || note.deleted_at) throw new Error('That note was not found.')
  const l = await load(ctx, noteId)
  if (unseeded(l.fragment, note)) return 'unseeded'
  const runs = textRuns(l.fragment)
  for (const needle of candidates(before)) {
    for (const run of runs) {
      const at = runText(run).indexOf(needle)
      if (at === -1) continue
      const replacement = after.trim().includes('\n') ? after.replace(/\s*\n\s*/g, ' ') : after
      const segments = inlineSegments(replacement)
      const plainOnly = segments.every((s) => Object.keys(s.marks).length === 0)
      await commit(ctx, l, () => {
        run.delete(at, needle.length)
        if (plainOnly) {
          // Inherits the formatting at that position (bold text stays bold).
          if (replacement) run.insert(at, inlinePlain(replacement))
        } else {
          let pos = at
          for (const s of segments) {
            run.insert(pos, s.text, s.marks)
            pos += s.text.length
          }
        }
      })
      const md = note.notes_md ?? ''
      const mdAt = md.indexOf(before) !== -1 ? md.indexOf(before) : md.indexOf(needle)
      if (mdAt !== -1) {
        const len = md.indexOf(before) !== -1 ? before.length : needle.length
        const nextMd = md.slice(0, mdAt) + after + md.slice(mdAt + len)
        await ctx.storage
          .updateNote(noteId, { notes_md: nextMd, notes_text: markdownPlain(nextMd) })
          .catch((err: unknown) => log('warn', 'chat:event-note-projection-failed', { noteId, err }))
      }
      return 'replaced'
    }
  }
  return 'not-found'
}
