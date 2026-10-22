// SPDX-License-Identifier: Apache-2.0
// Merge of two notes of one source: the note-text half. The storage half
// (`mergeSourceNotes`: sessions, chunks, spans, panels, attachments, folders, people, Trash) is the storage worker's.
//
// - Manual only (series page ▸ Duplicates). Both notes must be live and share a canonical key.
// - Refused while either note is open in the main window or capturing (`busy`). Storage refuses
//   it while the newer note has recordings (`MERGE_RECORDINGS_REFUSAL`), before anything
//   changes; the message is UI copy and reaches the Merge dialog as it is. Storage also unites
//   tags and carries superseded sessions over (with undo).
// - The older note keeps its id. The newer note's own notes are appended to it under a dated
//   heading: its Yjs elements are cloned, so stamps (`sourcePosition`, `sourceWall`), marks and
//   lists come along. The stored projections (`notes_md`, `notes_text`, `notes_md_stamped`) get the
//   same text, so search and the Local API see it before the note is opened again.
// - Its enhanced-notes panels move with the storage half; each gets a dated title, so they read as
//   a dated section of the kept note.
// - When both notes hold the video's captions, the moved caption sessions are hidden
//   (`superseded_session_ids`, undone with the merge), so the transcript isn't doubled.
// - A room that was never opened has nothing to clone: the renderer opens both rooms first (the
//   editor's own seeding), and main waits briefly for that write before refusing.
// - Undo: the appended elements are removed by their Yjs ids (edits elsewhere stay), the
//   projections lose the appended suffix while it is still there, panel titles come back, then the
//   storage half restores the newer note from Trash.
// Logs carry counts and ids only.

import { app } from 'electron'
import * as Y from 'yjs'
import { notulaError } from '@shared/errors'
import type { PushChannel } from '@shared/ipc'
import { isCaptionChunk } from '@shared/lib/source-transcript'
import type { Note } from '@shared/types/notes'
import type { MergeResult, NoteSource } from '@shared/types/sources'
import { YDOC_FRAGMENT, YDOC_ROOM_VERSION, type YdocUpdated } from '@shared/types/ydoc'
import { markdownPlain } from '../chat/note-doc'
import type { MainContext } from '../context'
import { log } from '../log'

const ORIGIN = 'main:sources-merge'
/** The same cap as `notes_md`. */
const MAX_PROJECTION = 4 * 1024 * 1024
/** Undo keeps a projection suffix only up to this size (the merge record holds ≤ 1 MB). */
const MAX_KEPT_SUFFIX = 256 * 1024
/** How long main waits for the renderer's first write of a room it just opened. */
const SEED_WAIT_MS = [250, 500, 750]

export const UNSEEDED_MERGE_MESSAGE = 'Open both notes once, then try merging again.'

interface YId {
  client: number
  clock: number
}

/** What the text half did, kept in the merge record's `extra`. */
interface MergeExtra {
  v: 1
  /** Top-level elements appended to the kept note's room. */
  appended: YId[]
  /** Suffixes appended to the kept note's projections; null = not recorded (too large). */
  md: string | null
  text: string | null
  stamped: string | null
  /** Panels that moved, with the title before and the dated title given. */
  panels: { id: string; title: string; dated: string }[]
  /** Moved caption sessions this merge hid, because the kept note had the video's captions already. */
  superseded?: string[]
}

interface Loaded {
  doc: Y.Doc
  fragment: Y.XmlFragment
  roomId: string
}

function roomOf(noteId: string): string {
  return `notes:${YDOC_ROOM_VERSION}:${noteId}`
}

async function loadRoom(ctx: MainContext, noteId: string): Promise<Loaded> {
  const roomId = roomOf(noteId)
  const state = await ctx.storage.loadYdoc(roomId)
  const doc = new Y.Doc()
  if (state.update) Y.applyUpdate(doc, state.update)
  return { doc, fragment: doc.getXmlFragment(YDOC_FRAGMENT), roomId }
}

/** A room never opened is empty even when the note has text: the editor seeds it on first open. */
function unseeded(l: Loaded, note: Pick<Note, 'notes_md' | 'notes_text'>): boolean {
  return l.fragment.length === 0 && !!(note.notes_md?.trim() || note.notes_text?.trim())
}

/** The room once the renderer's seeding write has landed; null when it never did. */
async function seededRoom(ctx: MainContext, note: Note): Promise<Loaded | null> {
  let l = await loadRoom(ctx, note.id)
  for (const ms of SEED_WAIT_MS) {
    if (!unseeded(l, note)) return l
    await new Promise((r) => setTimeout(r, ms))
    l = await loadRoom(ctx, note.id)
  }
  return unseeded(l, note) ? null : l
}

async function commit(ctx: MainContext, l: Loaded, change: () => void): Promise<void> {
  const before = Y.encodeStateVector(l.doc)
  l.doc.transact(change)
  const update = Y.encodeStateAsUpdate(l.doc, before)
  const { seq } = await ctx.storage.appendYdoc(l.roomId, update, ORIGIN)
  const payload: YdocUpdated = { roomId: l.roomId, update, seq, origin: ORIGIN }
  for (const wc of ctx.windows.targets()) wc.send('ydoc:updated' satisfies PushChannel, payload)
}

function isEmptyParagraph(n: Y.XmlElement | Y.XmlText): boolean {
  return n instanceof Y.XmlElement && n.nodeName === 'paragraph' && n.length === 0
}

/** The newer note's top-level blocks, without leading or trailing empty paragraphs. */
function blocksOf(fragment: Y.XmlFragment): (Y.XmlElement | Y.XmlText)[] {
  const all = fragment.toArray().filter((n): n is Y.XmlElement | Y.XmlText => n instanceof Y.XmlElement || n instanceof Y.XmlText)
  let a = 0
  let b = all.length
  while (a < b && isEmptyParagraph(all[a] as Y.XmlElement)) a++
  while (b > a && isEmptyParagraph(all[b - 1] as Y.XmlElement)) b--
  return all.slice(a, b)
}

function heading(text: string): Y.XmlElement {
  const h = new Y.XmlElement('heading')
  h.setAttribute('level', 2 as unknown as string)
  const t = new Y.XmlText()
  t.insert(0, text)
  h.insert(0, [t])
  return h
}

function idOf(n: { _item: Y.Item | null }): YId | null {
  const id = n._item?.id
  return id ? { client: id.client, clock: id.clock } : null
}

function locale(): string {
  try {
    return app.getLocale() || 'en-US'
  } catch {
    return 'en-US'
  }
}

function formatWhen(iso: string, withTime: boolean): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  try {
    return new Intl.DateTimeFormat(locale(), withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' }).format(d)
  } catch {
    return d.toISOString().slice(0, withTime ? 16 : 10).replace('T', ' ')
  }
}

const suffixOrNull = (s: string): string | null => (s.length <= MAX_KEPT_SUFFIX ? s : null)

/** Removes `suffix` from the end of `value` when it is still there. */
function stripSuffix(value: string | null, suffix: string | null): string | null | undefined {
  if (value === null || !suffix || !value.endsWith(suffix)) return undefined
  return value.slice(0, value.length - suffix.length)
}

function parseExtra(v: unknown): MergeExtra | null {
  if (typeof v !== 'object' || v === null || (v as { v?: unknown }).v !== 1) return null
  const e = v as Partial<MergeExtra>
  const ids = Array.isArray(e.appended)
    ? e.appended.filter((x): x is YId => typeof x === 'object' && x !== null && Number.isInteger(x.client) && Number.isInteger(x.clock))
    : []
  const strOrNull = (x: unknown): string | null => (typeof x === 'string' ? x : null)
  const panels = Array.isArray(e.panels)
    ? e.panels.filter(
        (p): p is MergeExtra['panels'][number] =>
          typeof p === 'object' && p !== null && typeof p.id === 'string' && typeof p.title === 'string' && typeof p.dated === 'string'
      )
    : []
  const superseded = Array.isArray(e.superseded) ? e.superseded.filter((x): x is string => typeof x === 'string') : []
  return { v: 1, appended: ids, md: strOrNull(e.md), text: strOrNull(e.text), stamped: strOrNull(e.stamped), panels, superseded }
}

/**
 * Merge: refused while a note is on screen or capturing. Undo: while the kept note is on screen
 * (its appended blocks may be being edited, and Undo deletes them whole) or capturing.
 */
function refuseBusy(ctx: MainContext, noteIds: string[], action: 'merge' | 'undo'): void {
  const viewing = ctx.ui.viewingNoteId()
  if (viewing && noteIds.includes(viewing)) {
    throw notulaError('busy', action === 'merge' ? 'Close the note to merge it. Merging changes both notes.' : 'Close the note to undo the merge.')
  }
  const capturing = ctx.capture.currentNoteId()
  if (capturing && noteIds.includes(capturing)) {
    throw notulaError('busy', action === 'merge' ? 'Stop transcribing to merge this note.' : 'Stop transcribing to undo the merge.')
  }
}

/** The older note is kept, as storage decides (created_at, then id). */
function order(a: Note, b: Note): [Note, Note] {
  const c = a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id)
  return c <= 0 ? [a, b] : [b, a]
}

/** `sources:merge-notes`. */
export async function mergeNotes(ctx: MainContext, noteIds: [string, string]): Promise<MergeResult> {
  const [a, b] = noteIds
  if (a === b) throw notulaError('invalid-input', 'Choose two different notes')
  refuseBusy(ctx, noteIds, 'merge')
  const [na, nb] = await Promise.all([ctx.storage.getNote(a), ctx.storage.getNote(b)])
  if (!na || !nb || na.deleted_at || nb.deleted_at) throw notulaError('not-found', 'One of these notes is no longer there')
  const [sa, sb] = await Promise.all([ctx.storage.getNoteSource(a), ctx.storage.getNoteSource(b)])
  if (!sa || !sb || sa.canonical_key !== sb.canonical_key) throw notulaError('invalid-input', 'These notes aren’t linked to the same video or lesson')
  const [keep, drop] = order(na, nb)
  const keepSource = (keep.id === a ? sa : sb) as NoteSource
  const dropSource = (drop.id === a ? sa : sb) as NoteSource

  const [keepRoom, dropRoom] = await Promise.all([seededRoom(ctx, keep), seededRoom(ctx, drop)])
  if (!keepRoom || !dropRoom) throw notulaError('busy', UNSEEDED_MERGE_MESSAGE)
  const blocks = blocksOf(dropRoom.fragment)
  const movingPanels = await ctx.storage.listPanels(drop.id)
  // Both notes hold the video's captions: the moved copy would show every line twice.
  // The kept note's own captions stay; the moved caption sessions are hidden.
  const [keepChunks, dropChunks] = await Promise.all([ctx.storage.getTranscript(keep.id), ctx.storage.getTranscript(drop.id)])
  const doubleCaptions = keepChunks.some(isCaptionChunk) ? [...new Set(dropChunks.filter(isCaptionChunk).map((c) => c.transcription_session_id))] : []

  // The storage half first: it checks both notes again inside its transaction.
  const merged = await ctx.storage.mergeSourceNotes({ noteIds: [keep.id, drop.id] })
  if (merged.keptNoteId !== keep.id) {
    // Storage and this file disagree on which note is older: put it back and stop.
    await ctx.storage.undoSourceMerge(merged.mergeId).catch(() => undefined)
    throw notulaError('internal', 'Couldn’t merge these notes')
  }

  const extra: MergeExtra = { v: 1, appended: [], md: null, text: null, stamped: null, panels: [], superseded: [] }
  try {
    if (doubleCaptions.length) {
      const kept = await ctx.storage.getNoteSource(keep.id)
      const hidden = new Set(kept?.superseded_session_ids ?? [])
      const added = doubleCaptions.filter((id) => !hidden.has(id))
      if (added.length) await ctx.storage.updateNoteSource(keep.id, { superseded_session_ids: [...hidden, ...added] })
      extra.superseded = added
    }

    const when = formatWhen(drop.created_at, true)
    const title = `Notes from ${when}`

    if (blocks.length > 0) {
      const head = heading(title)
      const clones = blocks.map((n) => n.clone())
      await commit(ctx, keepRoom, () => {
        // A room holding only an empty paragraph gets the text in its place.
        const only = keepRoom.fragment.length === 1 ? keepRoom.fragment.get(0) : null
        if (only instanceof Y.XmlElement && isEmptyParagraph(only)) keepRoom.fragment.delete(0, 1)
        keepRoom.fragment.insert(keepRoom.fragment.length, [head, ...clones])
      })
      extra.appended = [head, ...clones].map(idOf).filter((x): x is YId => x !== null)

      // The projections, until the editor writes its own on the next open.
      const dropMd = drop.notes_md?.trim() ?? ''
      const mdSuffix = `\n\n## ${title}\n\n${dropMd}`
      const keptMd = keep.notes_md?.trimEnd() ?? ''
      if (keptMd.length + mdSuffix.length <= MAX_PROJECTION) {
        const textSuffix = `\n${title}\n${drop.notes_text?.trim() || markdownPlain(dropMd)}`
        const keptText = keep.notes_text?.trimEnd() ?? ''
        await ctx.storage.updateNote(keep.id, { notes_md: keptMd + mdSuffix, notes_text: keptText + textSuffix })
        extra.md = suffixOrNull(mdSuffix)
        extra.text = suffixOrNull(textSuffix)
      }
      const keptStamped = (keepSource.notes_md_stamped ?? keep.notes_md ?? '').trimEnd()
      const stampedSuffix = `\n\n## ${title}\n\n${(dropSource.notes_md_stamped ?? drop.notes_md ?? '').trim()}`
      if (keptStamped.length + stampedSuffix.length <= MAX_PROJECTION) {
        await ctx.storage.updateNoteSource(keep.id, { notes_md_stamped: keptStamped + stampedSuffix })
        extra.stamped = suffixOrNull(stampedSuffix)
      }
    }

    const day = formatWhen(drop.created_at, false)
    for (const p of movingPanels) {
      if (p.deleted_at) continue
      const dated = `${p.title.trim() || 'Enhanced notes'} · ${day}`.slice(0, 200)
      await ctx.storage.updatePanel(p.id, { title: dated })
      extra.panels.push({ id: p.id, title: p.title, dated })
    }

    await ctx.storage.setSourceMergeExtra(merged.mergeId, extra)
  } catch (err) {
    // Take back what the text half did, then the storage half.
    log('warn', 'sources:merge-text-failed', { mergeId: merged.mergeId, err })
    const reverted = await revertText(ctx, keep.id, extra).then(
      () => true,
      () => false
    )
    const restored = await ctx.storage.undoSourceMerge(merged.mergeId).then(
      () => true,
      (e: unknown) => {
        log('warn', 'sources:merge-rollback-failed', { mergeId: merged.mergeId, err: e })
        return false
      }
    )
    throw notulaError(
      'internal',
      reverted && restored ? 'Couldn’t merge these notes. Both notes are as they were.' : 'Couldn’t finish merging these notes. Check both notes and Trash.'
    )
  }

  log('info', 'sources:merge-done', { mergeId: merged.mergeId, blocks: blocks.length, datedPanels: extra.panels.length, ...merged.moved })
  return { mergeId: merged.mergeId, keptNoteId: merged.keptNoteId, trashedNoteId: merged.trashedNoteId }
}

/** Removes what the text half appended, where it still is. */
async function revertText(ctx: MainContext, keptNoteId: string, extra: MergeExtra): Promise<void> {
  if (extra.appended.length) {
    const l = await loadRoom(ctx, keptNoteId)
    const wanted = new Set(extra.appended.map((x) => `${x.client}:${x.clock}`))
    const at: number[] = []
    l.fragment.toArray().forEach((n, i) => {
      const id = idOf(n as { _item: Y.Item | null })
      if (id && wanted.has(`${id.client}:${id.clock}`)) at.push(i)
    })
    if (at.length) {
      await commit(ctx, l, () => {
        for (const i of at.reverse()) l.fragment.delete(i, 1)
      })
    }
  }
  const note = await ctx.storage.getNote(keptNoteId, { includeDeleted: true })
  if (note) {
    const md = stripSuffix(note.notes_md, extra.md)
    const text = stripSuffix(note.notes_text, extra.text)
    if (md !== undefined || text !== undefined) {
      await ctx.storage.updateNote(keptNoteId, { ...(md !== undefined ? { notes_md: md } : {}), ...(text !== undefined ? { notes_text: text } : {}) })
    }
  }
  const source = await ctx.storage.getNoteSource(keptNoteId)
  const stamped = source ? stripSuffix(source.notes_md_stamped, extra.stamped) : undefined
  if (stamped !== undefined) await ctx.storage.updateNoteSource(keptNoteId, { notes_md_stamped: stamped })
  if (source && extra.superseded?.length) {
    const drop = new Set(extra.superseded)
    await ctx.storage.updateNoteSource(keptNoteId, { superseded_session_ids: source.superseded_session_ids.filter((id) => !drop.has(id)) })
  }
  for (const p of extra.panels) {
    const panel = await ctx.storage.getPanel(p.id)
    if (panel && panel.title === p.dated) await ctx.storage.updatePanel(p.id, { title: p.title })
  }
}

/** `sources:merge-undo`. */
export async function undoMerge(ctx: MainContext, mergeId: string): Promise<void> {
  const record = await ctx.storage.getSourceMerge(mergeId)
  if (!record) throw notulaError('not-found', 'This merge can’t be undone anymore: one of its notes was deleted permanently')
  if (record.undoneAt) throw notulaError('invalid-input', 'This merge was already undone')
  refuseBusy(ctx, [record.keptNoteId], 'undo')
  const extra = parseExtra(record.extra)
  if (extra) await revertText(ctx, record.keptNoteId, extra)
  await ctx.storage.undoSourceMerge(mergeId)
  log('info', 'sources:merge-undo-done', { mergeId, blocks: extra?.appended.length ?? 0, panels: extra?.panels.length ?? 0 })
}
