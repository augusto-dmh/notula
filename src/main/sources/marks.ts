// SPDX-License-Identifier: Apache-2.0
// A mark for a video whose note exists but isn't open:
// the stamped paragraph is appended to that note's room in main, the way the open editor appends
// one (an empty paragraph carrying `sourcePosition` and `sourceWall`), and pushed on `ydoc:updated`
// so any window holding the room merges it.
//
// - The note: the newest own, non-trashed note with that exact key. Guess keys never match.
// - A room that was never opened (the note has text, the room is empty) isn't touched: the editor
//   seeds it from `notes_md` on the first open, and a room holding only the mark would replace
//   that text. The caller keeps the mark held instead.
// - The stored projections stay as they are; the editor rewrites them at the next open.
// Logs carry outcomes only.

import * as Y from 'yjs'
import type { PushChannel } from '@shared/ipc'
import { GUESS_KEY_PREFIX, type CanonicalKey } from '@shared/types/sources'
import { YDOC_FRAGMENT, YDOC_ROOM_VERSION, type YdocUpdated } from '@shared/types/ydoc'
import type { MainContext } from '../context'
import { log } from '../log'

const ORIGIN = 'main:sources-mark'
/** The editor's attributes for a stamped paragraph (`editor/source-position.ts`). */
const SOURCE_POSITION = 'sourcePosition'
const SOURCE_WALL = 'sourceWall'

export type MarkAppend = { result: 'appended'; noteId: string } | { result: 'no-note' | 'unseeded' | 'failed' }

/** Appends a stamped paragraph at `positionMs` to the newest note with `key`. */
export async function appendMarkToSourceNote(ctx: MainContext, key: CanonicalKey, positionMs: number, wallMs: number): Promise<MarkAppend> {
  if (key.startsWith(GUESS_KEY_PREFIX)) return { result: 'no-note' }
  try {
    const match = (await ctx.storage.findNotesBySource(key, { limit: 1 }))[0]
    if (!match) return { result: 'no-note' }
    const note = await ctx.storage.getNote(match.noteId)
    if (!note || note.deleted_at) return { result: 'no-note' }
    const roomId = `notes:${YDOC_ROOM_VERSION}:${note.id}`
    const state = await ctx.storage.loadYdoc(roomId)
    const doc = new Y.Doc()
    if (state.update) Y.applyUpdate(doc, state.update)
    const fragment = doc.getXmlFragment(YDOC_FRAGMENT)
    if (fragment.length === 0 && (note.notes_md?.trim() || note.notes_text?.trim())) {
      log('info', 'sources:mark-append', { result: 'unseeded' })
      return { result: 'unseeded' }
    }
    const before = Y.encodeStateVector(doc)
    doc.transact(() => {
      const p = new Y.XmlElement('paragraph')
      p.setAttribute(SOURCE_POSITION, Math.max(0, Math.round(positionMs)) as unknown as string)
      p.setAttribute(SOURCE_WALL, Math.round(wallMs) as unknown as string)
      fragment.insert(fragment.length, [p])
    })
    const update = Y.encodeStateAsUpdate(doc, before)
    const { seq } = await ctx.storage.appendYdoc(roomId, update, ORIGIN)
    const payload: YdocUpdated = { roomId, update, seq, origin: ORIGIN }
    for (const wc of ctx.windows.targets()) wc.send('ydoc:updated' satisfies PushChannel, payload)
    log('info', 'sources:mark-append', { result: 'appended' })
    return { result: 'appended', noteId: note.id }
  } catch (err) {
    log('warn', 'sources:mark-append', { result: 'failed', err })
    return { result: 'failed' }
  }
}
