// SPDX-License-Identifier: Apache-2.0
// The per-source pending buffer. Every batch is
// appended here first, then drained to the connection. While a source waits for a
// connection, audio only accumulates; at most the last 120 s are kept, and older
// entries are evicted and counted as dropped (logged at most once per 10 s).
//
// Batches already sent stay "in flight" until a final result covers
// them, and a reconnect replays them before the pending ones. Audio written into a
// socket that dies before answering is otherwise lost; this is what keeps a 20 s
// network outage from leaving a gap in the transcript.

import type { AudioSource } from '@shared/types/common'
import { log } from '../log'

export interface AudioEntry {
  pcm: Buffer
  captureTimeMs: number
  durationMs: number
}

const PENDING_MAX_MS = 120_000
const INFLIGHT_MAX_MS = 30_000
const DROP_LOG_EVERY_MS = 10_000

export class PendingBuffer {
  private pending: AudioEntry[] = []
  private pendingMs = 0
  private inflight: AudioEntry[] = []
  private inflightMs = 0
  private dropped = 0
  private droppedMs = 0
  private lastDropLog = 0
  /** Unacknowledged audio pushed out of the in-flight window: a reconnect cannot replay it. */
  private evicted = 0
  private evictedMs = 0
  private lastEvictLog = 0

  constructor(private readonly source: AudioSource) {}

  push(e: AudioEntry): void {
    this.pending.push(e)
    this.pendingMs += e.durationMs
    while (this.pendingMs > PENDING_MAX_MS && this.pending.length > 1) {
      const old = this.pending.shift() as AudioEntry
      this.pendingMs -= old.durationMs
      this.dropped++
      this.droppedMs += old.durationMs
    }
    if (this.dropped && Date.now() - this.lastDropLog >= DROP_LOG_EVERY_MS) {
      this.lastDropLog = Date.now()
      log('warn', 'asr:pending-dropped', { source: this.source, entries: this.dropped, ms: this.droppedMs })
    }
  }

  get size(): number {
    return this.pending.length
  }

  get pendingDurationMs(): number {
    return this.pendingMs
  }

  /** Audio never sent to any socket. */
  unsent(): { entries: number; bytes: number; ms: number } {
    let bytes = 0
    for (const e of this.pending) bytes += e.pcm.byteLength
    return { entries: this.pending.length, bytes, ms: this.pendingMs }
  }

  peek(): AudioEntry | undefined {
    return this.pending[0]
  }

  /** The head entry was sent: it moves in flight until a final result covers it. */
  markSent(): void {
    const e = this.pending.shift()
    if (!e) return
    this.pendingMs -= e.durationMs
    this.inflight.push(e)
    this.inflightMs += e.durationMs
    let evictedNow = false
    while (this.inflightMs > INFLIGHT_MAX_MS && this.inflight.length > 1) {
      const old = this.inflight.shift() as AudioEntry
      this.inflightMs -= old.durationMs
      this.evicted++
      this.evictedMs += old.durationMs
      evictedNow = true
    }
    if (evictedNow && Date.now() - this.lastEvictLog >= DROP_LOG_EVERY_MS) {
      this.lastEvictLog = Date.now()
      log('warn', 'asr:inflight-evicted', { source: this.source, entries: this.evicted, ms: Math.round(this.evictedMs) })
    }
  }

  /** A final result covers audio up to this capture time. */
  acknowledge(throughUnixMs: number): void {
    while (this.inflight.length) {
      const e = this.inflight[0] as AudioEntry
      if (e.captureTimeMs + e.durationMs > throughUnixMs) break
      this.inflight.shift()
      this.inflightMs -= e.durationMs
    }
  }

  /** The socket dropped: unacknowledged audio goes back to the front for replay. */
  requeueInflight(): number {
    const n = this.inflight.length
    if (!n) return 0
    this.pending = [...this.inflight, ...this.pending]
    this.pendingMs += this.inflightMs
    this.inflight = []
    this.inflightMs = 0
    return n
  }

  /** Removes and returns every unsent entry, oldest first (a reconfigure hands them on). */
  take(): AudioEntry[] {
    const out = this.pending
    this.pending = []
    this.pendingMs = 0
    return out
  }

  /** Older audio from a previous session goes in front, keeping its capture times; the 120 s cap applies. */
  restore(entries: readonly AudioEntry[]): void {
    if (!entries.length) return
    this.pending = [...entries, ...this.pending]
    for (const e of entries) this.pendingMs += e.durationMs
    while (this.pendingMs > PENDING_MAX_MS && this.pending.length > 1) {
      const old = this.pending.shift() as AudioEntry
      this.pendingMs -= old.durationMs
      this.dropped++
      this.droppedMs += old.durationMs
    }
  }

  clear(): void {
    this.pending = []
    this.inflight = []
    this.pendingMs = 0
    this.inflightMs = 0
  }
}
