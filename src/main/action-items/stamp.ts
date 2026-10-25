// SPDX-License-Identifier: Apache-2.0
// `actionItemId` onto summary paragraphs: each
// paragraph of the panel's summary room whose text equals a returned `summaryLine`, exact
// after trimming (markdown markers and runs of spaces aside), gets the item's id as the
// paragraph attribute the panel editor schema keeps. The change is one Yjs update with
// origin `action-items`, appended to the room log and pushed to every window, so an open
// editor shows it at once and the panel projection follows.
//
// A room that does not exist yet (the summary was never opened) is stamped when it first
// appears; until then the stamps wait here (this app session).

import { createHash } from 'node:crypto'
import * as Y from 'yjs'
import type { PushChannel } from '@shared/ipc'
import { LINE_FINGERPRINT_LENGTH, lineKey } from '@shared/lib/action-line'
import { YDOC_FRAGMENT, YDOC_ROOM_VERSION, type YdocUpdated } from '@shared/types/ydoc'
import type { MainContext } from '../context'
import { log } from '../log'

export const ACTION_ITEM_ATTR = 'actionItemId'
const ORIGIN = 'action-items'
/** Pending stamps are dropped after a day: the room will be seeded from a fresh summary by then. */
const PENDING_MS = 24 * 3_600_000

export interface Stamp {
  id: string
  line: string
}

export function summaryRoomId(panelId: string): string {
  return `summary:${YDOC_ROOM_VERSION}:${panelId}`
}

/** The stored fingerprint of a summary line, or null when nothing of it is comparable. */
export function lineFingerprint(line: string): string | null {
  const key = lineKey(line)
  return key ? createHash('sha256').update(key).digest('hex').slice(0, LINE_FINGERPRINT_LENGTH) : null
}

function textOf(el: Y.XmlElement): string {
  let out = ''
  for (const child of el.toArray()) {
    if (child instanceof Y.XmlText) {
      for (const d of child.toDelta() as { insert?: unknown }[]) if (typeof d.insert === 'string') out += d.insert
    } else if (child instanceof Y.XmlElement) {
      out += textOf(child)
    }
  }
  return out
}

function paragraphs(node: Y.XmlFragment | Y.XmlElement, out: Y.XmlElement[]): Y.XmlElement[] {
  for (const child of node.toArray()) {
    if (!(child instanceof Y.XmlElement)) continue
    if (child.nodeName === 'paragraph') out.push(child)
    else paragraphs(child, out)
  }
  return out
}

export class SummaryStamper {
  private readonly pending = new Map<string, { stamps: Stamp[]; at: number }>()

  constructor(private readonly ctx: MainContext) {
    ctx.bus.on('storage:changed', (c) => {
      if (!c.tables.includes('ydocs') || this.pending.size === 0) return
      for (const [panelId, p] of this.pending) {
        if (Date.now() - p.at > PENDING_MS) {
          this.pending.delete(panelId)
          continue
        }
        if (c.ids.includes(summaryRoomId(panelId))) void this.apply(panelId, p.stamps, false)
      }
    })
  }

  /** Stamps the room now, or as soon as it exists. Resolves with the paragraphs stamped. */
  async stamp(panelId: string, stamps: Stamp[]): Promise<number> {
    const usable = stamps.filter((s) => lineKey(s.line))
    if (usable.length === 0) return 0
    return this.apply(panelId, usable, true)
  }

  private async apply(panelId: string, stamps: Stamp[], allowPending: boolean): Promise<number> {
    const roomId = summaryRoomId(panelId)
    try {
      const state = await this.ctx.storage.loadYdoc(roomId)
      if (!state.update || state.update.byteLength === 0) {
        if (allowPending) this.pending.set(panelId, { stamps, at: Date.now() })
        return 0
      }
      this.pending.delete(panelId)
      const doc = new Y.Doc()
      try {
        Y.applyUpdate(doc, state.update)
        const fragment = doc.getXmlFragment(YDOC_FRAGMENT)
        const byKey = new Map<string, string>()
        for (const s of stamps) if (!byKey.has(lineKey(s.line))) byKey.set(lineKey(s.line), s.id)
        const before = Y.encodeStateVector(doc)
        let stamped = 0
        doc.transact(() => {
          for (const p of paragraphs(fragment, [])) {
            const id = byKey.get(lineKey(textOf(p)))
            if (!id || p.getAttribute(ACTION_ITEM_ATTR) === id) continue
            p.setAttribute(ACTION_ITEM_ATTR, id)
            stamped++
          }
        })
        if (stamped === 0) {
          log('info', 'action-items:stamp-no-match', { panelId, stamps: stamps.length })
          return 0
        }
        const update = Y.encodeStateAsUpdate(doc, before)
        const { seq } = await this.ctx.storage.appendYdoc(roomId, update, ORIGIN)
        const payload: YdocUpdated = { roomId, update, seq, origin: ORIGIN }
        for (const wc of this.ctx.windows.targets()) wc.send('ydoc:updated' satisfies PushChannel, payload)
        log('info', 'action-items:stamped', { panelId, stamped, stamps: stamps.length })
        return stamped
      } finally {
        doc.destroy()
      }
    } catch (err) {
      log('warn', 'action-items:stamp-failed', { panelId, err })
      return 0
    }
  }
}
