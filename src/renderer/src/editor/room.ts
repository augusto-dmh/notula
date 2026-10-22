// SPDX-License-Identifier: Apache-2.0
// The IPC Yjs provider and the room cache.
//
// - load: `ydoc:load` returns every logged update of the room merged; it is
//   applied with a LOAD origin.
// - append: every local Yjs transaction is appended with `ydoc:append`, in order,
//   one update per transaction. A failed append is merged into the next try.
// - remote: `ydoc:updated` pushes from other windows (any origin but ours) are
//   applied with a REMOTE origin, so they are never appended again.
// - cache: a room stays alive 30 s after its last editor leaves, then is destroyed.

import * as Y from 'yjs'
import { prosemirrorJSONToYXmlFragment, yXmlFragmentToProseMirrorRootNode } from '@tiptap/y-tiptap'
import { parseError } from '@shared/errors'
import { YDOC_FRAGMENT, type YdocUpdated } from '@shared/types/ydoc'
import { debugLog } from '../app/platform'
import { renderFragment } from './markdown'
import { schemaFor, seedDocument, type EditorKind } from './schema'

const ROOM_TTL_MS = 30_000
const RETRY_MIN_MS = 1_000
const RETRY_MAX_MS = 30_000

/** This window's append origin; pushes carrying it are our own echoes. */
const WINDOW_ORIGIN = `renderer:${crypto.randomUUID()}`
const LOAD = Symbol('notula-ydoc-load')
const REMOTE = Symbol('notula-ydoc-remote')
const SEED = Symbol('notula-ydoc-seed')

export type RoomStatus = 'loading' | 'ready' | 'error'

export interface Seed {
  json?: unknown
  markdown?: string
}

export class Room {
  readonly doc = new Y.Doc()
  readonly fragment: Y.XmlFragment
  status: RoomStatus = 'loading'
  error: string | null = null
  refs = 0
  evictTimer: ReturnType<typeof setTimeout> | null = null

  private readonly listeners = new Set<() => void>()
  private queue: Uint8Array[] = []
  private sending = false
  private retryMs = RETRY_MIN_MS
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  private seeded = false

  constructor(
    readonly id: string,
    readonly kind: EditorKind
  ) {
    this.fragment = this.doc.getXmlFragment(YDOC_FRAGMENT)
    this.doc.on('update', (update: Uint8Array, origin: unknown) => {
      if (origin === LOAD || origin === REMOTE) return
      this.queue.push(update)
      this.pump()
    })
  }

  subscribe(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(): void {
    for (const l of this.listeners) l()
  }

  async load(seed: Seed | undefined): Promise<void> {
    this.status = 'loading'
    this.error = null
    this.emit()
    try {
      const state = await window.notula.ydoc.load({ roomId: this.id })
      if (this.destroyed) return
      if (state.update && state.update.byteLength > 0) Y.applyUpdate(this.doc, state.update, LOAD)
      this.populate(seed)
      this.status = 'ready'
    } catch (err) {
      this.status = 'error'
      this.error = parseError(err).code
      debugLog('ydoc-load-failed', { roomId: this.id, err: parseError(err) })
    }
    this.emit()
  }

  /** Lazy body creation: fill an empty fragment from the note's projection. */
  private populate(seed: Seed | undefined): void {
    if (this.seeded || this.fragment.length > 0) return
    this.seeded = true
    const json = seedDocument(this.kind, seed)
    if (!json) {
      debugLog('room-ready', { roomId: this.id })
      return
    }
    this.doc.transact(() => {
      prosemirrorJSONToYXmlFragment(schemaFor(this.kind), json, this.fragment)
    }, SEED)
    debugLog('room-seeded-from-json', { roomId: this.id })
  }

  applyRemote(e: YdocUpdated): void {
    if (e.origin === WINDOW_ORIGIN || this.destroyed) return
    Y.applyUpdate(this.doc, e.update, REMOTE)
  }

  private pump(): void {
    if (this.sending || this.retryTimer || this.queue.length === 0) return
    const update = this.queue.shift() as Uint8Array
    this.sending = true
    window.notula.ydoc
      .append({ roomId: this.id, update, origin: WINDOW_ORIGIN })
      .then(() => {
        this.retryMs = RETRY_MIN_MS
        this.sending = false
        this.pump()
      })
      .catch((err: unknown) => {
        this.sending = false
        // Keep the bytes: merge the failed update with whatever queued meanwhile.
        this.queue = [Y.mergeUpdates([update, ...this.queue])]
        debugLog('ydoc-append-failed', { roomId: this.id, err: parseError(err), retryMs: this.retryMs })
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null
          this.pump()
        }, this.retryMs)
        this.retryMs = Math.min(this.retryMs * 2, RETRY_MAX_MS)
      })
  }

  destroy(): void {
    this.destroyed = true
    if (this.retryTimer) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    // Last attempt for anything still queued; the bytes outlive the doc.
    if (this.queue.length > 0 && !this.sending) {
      const update = Y.mergeUpdates(this.queue)
      this.queue = []
      void window.notula.ydoc.append({ roomId: this.id, update, origin: WINDOW_ORIGIN }).catch((err: unknown) => {
        debugLog('ydoc-append-lost', { roomId: this.id, err: parseError(err) })
      })
    }
    this.listeners.clear()
    this.doc.destroy()
  }
}

const rooms = new Map<string, Room>()
let unsubscribePush: (() => void) | null = null

function ensurePush(): void {
  if (unsubscribePush) return
  unsubscribePush = window.notula.ydoc.onUpdated((e) => rooms.get(e.roomId)?.applyRemote(e))
}

/** Takes a reference on a room, loading it on first use. */
export function acquireRoom(id: string, kind: EditorKind, seed: Seed | undefined): Room {
  ensurePush()
  let room = rooms.get(id)
  if (!room) {
    room = new Room(id, kind)
    rooms.set(id, room)
    void room.load(seed)
  }
  if (room.evictTimer) {
    clearTimeout(room.evictTimer)
    room.evictTimer = null
  }
  room.refs++
  return room
}

/** Drops a reference; the room is destroyed 30 s after the last one goes. */
export function releaseRoom(room: Room): void {
  room.refs = Math.max(0, room.refs - 1)
  if (room.refs > 0 || room.evictTimer) return
  room.evictTimer = setTimeout(() => {
    room.evictTimer = null
    if (room.refs > 0) return
    rooms.delete(room.id)
    room.destroy()
  }, ROOM_TTL_MS)
}

/** Retries a room whose load failed. */
export function retryRoom(room: Room, seed: Seed | undefined): void {
  if (room.status === 'error') void room.load(seed)
}

function whenSettled(room: Room): Promise<void> {
  if (room.status !== 'loading') return Promise.resolve()
  return new Promise((resolve) => {
    const off = room.subscribe(() => {
      if (room.status === 'loading') return
      off()
      resolve()
    })
  })
}

/**
 * A room's current body as the schema's HTML, for copying a panel that is not on
 * screen. The room is held only for the read; the seed is
 * the one its editor would use, so a first read fills an empty room the same way.
 */
export async function readRoomHtml(roomId: string, kind: EditorKind, seed: Seed | undefined): Promise<string> {
  const room = acquireRoom(roomId, kind, seed)
  try {
    await whenSettled(room)
    if (room.status === 'error') throw new Error(room.error ?? 'the note content could not be opened')
    const doc = yXmlFragmentToProseMirrorRootNode(room.fragment, schemaFor(kind))
    return renderFragment(doc.type.schema, doc.content).innerHTML
  } finally {
    releaseRoom(room)
  }
}
