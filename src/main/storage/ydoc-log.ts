// SPDX-License-Identifier: Apache-2.0
// The append-only Yjs update log (`ydocs`; each row is a UUID id plus a monotonic `seq`).
// Load merges every row of a room; once a room holds at least 500 rows, it is
// compacted 1 s after its last append into one row carrying the room's highest
// seq, so `seq` stays "the highest applied".
//
// Appends must parse as a Yjs update. A row that still fails to merge (written
// before that check, or damaged) is quarantined: moved, never deleted, to
// room `quarantine:<roomId>`, which no room id accepted over IPC can name. Load
// and compaction then go on with the rest of the room.

import { randomUUID } from 'node:crypto'
import * as Y from 'yjs'
import { YDOC_ROOM_VERSION, type YdocState } from '@shared/types/ydoc'
import { nowIso, toBuffer } from './rows'
import { inTransaction, invalid, StoreError, type StoreCtx } from './store'

export const COMPACT_MIN_ROWS = 500
export const COMPACT_DELAY_MS = 1_000

/** The origin a future sync backend appends with. */
export const REMOTE_ORIGIN = 'remote'

/** A sync server's answer to a pushed state. */
export const YDOC_MERGE_OUTCOMES = ['created', 'merged', 'overwritten', 'kept_local_disjoint', 'unchanged'] as const
export type YdocMergeOutcome = (typeof YDOC_MERGE_OUTCOMES)[number]

/**
 * The sync seam's export: the room's full state as
 * base64 of the Yjs state-as-update encoding, plus the room version. Read-only: a row
 * that does not decode is skipped and logged here (load quarantines it). No caller yet.
 */
export function exportYdocState(s: StoreCtx, roomId: string): { stateBase64: string; version: number } {
  assertRoomId(roomId)
  const rows = s.db.prepare(`SELECT seq, data FROM ydocs WHERE room_id = ? ORDER BY seq ASC`).all(roomId) as LogRow[]
  const doc = new Y.Doc()
  try {
    for (const row of rows) {
      const bad = decodeError(row.data)
      if (bad) {
        s.log('warn', 'ydoc-export-row-skipped', { roomId, seq: row.seq, error: bad.slice(0, 200) })
        continue
      }
      Y.applyUpdate(doc, row.data)
    }
    return { stateBase64: Buffer.from(Y.encodeStateAsUpdate(doc)).toString('base64'), version: YDOC_ROOM_VERSION }
  } finally {
    doc.destroy()
  }
}

const ROOM_ID = /^(notes|summary):1:[^\s:]{1,200}$/
const QUARANTINE_PREFIX = 'quarantine:'

interface LogRow {
  seq: number
  data: Uint8Array
}

/** Why `data` is not a Yjs update, or null when it parses. */
function decodeError(data: Uint8Array): string | null {
  try {
    Y.decodeUpdate(data)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export function assertRoomId(roomId: unknown): asserts roomId is string {
  if (typeof roomId !== 'string' || !ROOM_ID.test(roomId)) throw invalid('roomId must be <notes|summary>:1:<id>')
}

export class YdocLog {
  private readonly timers = new Map<string, NodeJS.Timeout>()

  /** `ctx()` is null once the database is closed; a pending compaction then does nothing. */
  constructor(private readonly ctx: () => StoreCtx | null) {}

  load(roomId: string): YdocState {
    assertRoomId(roomId)
    const s = this.require()
    const rows = this.rows(s, roomId)
    if (rows.length === 0) return { update: null, seq: 0 }
    const merged = this.merge(s, roomId, rows)
    return merged ? { update: new Uint8Array(merged.update), seq: merged.seq } : { update: null, seq: 0 }
  }

  append(roomId: string, update: Uint8Array, origin: string): { seq: number } {
    assertRoomId(roomId)
    if (!(update instanceof Uint8Array) || update.byteLength === 0) throw invalid('update must be non-empty bytes')
    const bad = decodeError(update)
    if (bad) throw invalid(`update is not a Yjs update (${bad})`)
    const s = this.require()
    const { seq, count } = inTransaction(s.db, () => {
      const info = s.db
        .prepare(`INSERT INTO ydocs (id, room_id, data, origin, created_at) VALUES (?, ?, ?, ?, ?)`)
        .run(randomUUID(), roomId, toBuffer(update), typeof origin === 'string' ? origin.slice(0, 200) : null, nowIso())
      const c = s.db.prepare(`SELECT count(*) AS n FROM ydocs WHERE room_id = ?`).get(roomId) as { n: number }
      return { seq: Number(info.lastInsertRowid), count: c.n }
    })
    s.touch('ydocs', roomId)
    if (count >= COMPACT_MIN_ROWS) this.schedule(roomId)
    return { seq }
  }

  /**
   * The sync seam's import: only `kept_local_disjoint`
   * with a returned state appends it, as one row with origin `remote`. Every other
   * outcome leaves the room as it is. No caller yet.
   */
  applyRemoteResolution(roomId: string, outcome: YdocMergeOutcome, stateBase64: string | null): boolean {
    if (!YDOC_MERGE_OUTCOMES.includes(outcome)) throw invalid('unknown merge outcome')
    if (outcome !== 'kept_local_disjoint' || !stateBase64) return false
    this.append(roomId, new Uint8Array(Buffer.from(stateBase64, 'base64')), REMOTE_ORIGIN)
    return true
  }

  /** Clears pending compactions (close). The log needs none to stay correct. */
  stop(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  private schedule(roomId: string): void {
    const prev = this.timers.get(roomId)
    if (prev) clearTimeout(prev)
    this.timers.set(
      roomId,
      setTimeout(() => {
        this.timers.delete(roomId)
        this.compact(roomId)
      }, COMPACT_DELAY_MS)
    )
  }

  private compact(roomId: string): void {
    const s = this.ctx()
    if (!s) return
    try {
      const result = inTransaction(s.db, () => {
        const rows = this.rows(s, roomId)
        if (rows.length < 2) return null
        // Quarantined rows leave the room here, so the delete below cannot reach them.
        const merged = this.merge(s, roomId, rows)
        if (!merged || merged.rows < 2) return null
        s.db.prepare(`DELETE FROM ydocs WHERE room_id = ? AND seq <= ?`).run(roomId, merged.seq)
        s.db
          .prepare(`INSERT INTO ydocs (seq, id, room_id, data, origin, created_at) VALUES (?, ?, ?, ?, 'compaction', ?)`)
          .run(merged.seq, randomUUID(), roomId, toBuffer(merged.update), nowIso())
        return { rows: merged.rows, bytes: merged.update.byteLength }
      })
      if (result) s.log('info', 'ydoc-compacted', { roomId, ...result })
    } catch (err) {
      s.log('error', 'ydoc-compaction-failed', { roomId, err })
    }
  }

  private rows(s: StoreCtx, roomId: string): LogRow[] {
    return s.db.prepare(`SELECT seq, data FROM ydocs WHERE room_id = ? ORDER BY seq ASC`).all(roomId) as LogRow[]
  }

  /**
   * Merges the room's rows. When that fails, rows that do not parse, then rows
   * that parse alone but break the merge, are quarantined and the rest merged.
   * Null when no row is usable. `seq` is the highest usable row's.
   */
  private merge(s: StoreCtx, roomId: string, rows: LogRow[]): { update: Uint8Array; seq: number; rows: number } | null {
    const last = rows[rows.length - 1]!.seq
    if (rows.length === 1) {
      if (!decodeError(rows[0]!.data)) return { update: rows[0]!.data, seq: last, rows: 1 }
    } else {
      try {
        return { update: Y.mergeUpdates(rows.map((r) => r.data)), seq: last, rows: rows.length }
      } catch {
        // Find the bad rows below.
      }
    }
    const bad: { row: LogRow; error: string }[] = []
    let update: Uint8Array | null = null
    let seq = 0
    let kept = 0
    for (const row of rows) {
      const error = decodeError(row.data)
      if (error) {
        bad.push({ row, error })
        continue
      }
      try {
        update = update ? Y.mergeUpdates([update, row.data]) : row.data
        seq = row.seq
        kept++
      } catch (err) {
        bad.push({ row, error: err instanceof Error ? err.message : String(err) })
      }
    }
    this.quarantine(s, roomId, bad)
    return update ? { update, seq, rows: kept } : null
  }

  private quarantine(s: StoreCtx, roomId: string, bad: { row: LogRow; error: string }[]): void {
    if (!bad.length) return
    inTransaction(s.db, () => {
      const move = s.db.prepare(`UPDATE ydocs SET room_id = ? WHERE room_id = ? AND seq = ?`)
      for (const { row } of bad) move.run(QUARANTINE_PREFIX + roomId, roomId, row.seq)
    })
    for (const { row, error } of bad) {
      s.log('warn', 'ydoc-row-quarantined', { roomId, seq: row.seq, bytes: row.data.byteLength, error: error.slice(0, 200) })
    }
  }

  private require(): StoreCtx {
    const s = this.ctx()
    if (!s) throw new StoreError('storage-unavailable', 'storage is not open')
    return s
  }
}
