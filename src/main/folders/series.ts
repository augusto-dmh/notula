// SPDX-License-Identifier: Apache-2.0
// A main-side index of the user's own calendar notes by recurring series and summary:
// the recurring match reads candidates from
// it, and the new-folder suggestion counts a series' notes. It is built once from
// `queryNotes` (own, not deleted, not shared), then kept current from the storage change
// feed: the note ids of each change are re-read, and those that are gone are dropped.

import type { CalendarEvent, NoteListItem } from '@shared/types/notes'
import type { MainContext } from '../context'

export interface SeriesNote {
  id: string
  recurringEventId: string | null
  summary: string | null
}

/** The series id of a calendar event (`recurringEventId` in the canonical event shape). */
export function recurringEventId(event: CalendarEvent | null | undefined): string | null {
  const v = event?.['recurringEventId']
  return typeof v === 'string' && v ? v : null
}

export function eventSummary(event: CalendarEvent | null | undefined): string | null {
  const v = event?.summary
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** `queryNotes` takes at most 1,000 ids per call. */
const CHUNK = 1_000

function entry(n: NoteListItem): SeriesNote | null {
  const event = n.linked_event
  if (!event) return null
  return { id: n.id, recurringEventId: recurringEventId(event), summary: eventSummary(event) }
}

export class SeriesIndex {
  private notes: Map<string, SeriesNote> | null = null
  private readonly dirty = new Set<string>()
  private pending: Promise<Map<string, SeriesNote>> | null = null

  constructor(private readonly ctx: MainContext) {
    ctx.bus.on('storage:changed', (c) => {
      if (!c.tables.includes('documents')) return
      for (const id of c.ids) this.dirty.add(id)
    })
    ctx.bus.on('storage:status', (s) => {
      if (s.state !== 'ready') this.notes = null
    })
  }

  /** Own, non-deleted calendar notes by id. */
  get(): Promise<Map<string, SeriesNote>> {
    this.pending ??= this.refresh().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private async refresh(): Promise<Map<string, SeriesNote>> {
    if (!this.notes) {
      this.dirty.clear()
      const all = await this.ctx.storage.queryNotes({})
      const map = new Map<string, SeriesNote>()
      for (const n of all) {
        const e = entry(n)
        if (e) map.set(e.id, e)
      }
      this.notes = map
      return map
    }
    const map = this.notes
    if (this.dirty.size === 0) return map
    const ids = [...this.dirty]
    this.dirty.clear()
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK)
      const rows = await this.ctx.storage.queryNotes({ ids: chunk })
      const seen = new Set<string>()
      for (const n of rows) {
        seen.add(n.id)
        const e = entry(n)
        if (e) map.set(n.id, e)
        else map.delete(n.id)
      }
      for (const id of chunk) if (!seen.has(id)) map.delete(id)
    }
    return map
  }
}
