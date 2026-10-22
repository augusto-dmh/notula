// SPDX-License-Identifier: Apache-2.0
// Watched spans of a source note: the writer. The provider's state machine
// (`src/main/media/machine.ts`) closes a span on every play / pause / seek / rate / end change and
// already merges spans under 2 s into their neighbour; this module stores them.
//
// Writes are queued per note and sent in one `addSourceSpans` call per flush (at most one in
// flight), so a burst of seeks costs one transaction. A failed write is retried once with the
// next flush, then dropped: spans are a convenience, never worth blocking the note. Logs carry
// counts only.

import type { SpanRecord } from '../media/machine'
import type { MainContext } from '../context'
import { log } from '../log'

/** The storage cap per call (`addSourceSpans` takes at most 1,000). */
const MAX_BATCH = 1_000
const FLUSH_DELAY_MS = 500
const RETRY_DELAY_MS = 5_000

/** A closed span as storage takes it; null for one storage would refuse. */
export function toStoredSpan(s: SpanRecord): { wall_start: number; wall_end: number; pos_start_ms: number; pos_end_ms: number; rate: number } | null {
  const ok = [s.wallStart, s.wallEnd, s.posStartMs, s.posEndMs, s.rate].every((n) => Number.isFinite(n))
  if (!ok || s.wallEnd < s.wallStart || s.rate <= 0 || s.rate > 16) return null
  return {
    wall_start: Math.round(s.wallStart),
    wall_end: Math.round(s.wallEnd),
    pos_start_ms: Math.max(0, Math.round(s.posStartMs)),
    pos_end_ms: Math.max(0, Math.round(s.posEndMs)),
    rate: s.rate
  }
}

export class SpanWriter {
  private readonly queue = new Map<string, { spans: SpanRecord[]; retried: boolean }>()
  private timer: NodeJS.Timeout | null = null
  private writing: Promise<void> = Promise.resolve()

  constructor(private readonly ctx: MainContext) {}

  add(noteId: string, span: SpanRecord): void {
    const q = this.queue.get(noteId) ?? { spans: [], retried: false }
    q.spans.push(span)
    this.queue.set(noteId, q)
    this.schedule(FLUSH_DELAY_MS)
  }

  private schedule(ms: number): void {
    if (this.timer) return
    this.timer = setTimeout(() => void this.flush(), ms)
    this.timer.unref()
  }

  /** Writes everything queued; resolves when the write is done (used at quit and switch-off). */
  flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    const batch = [...this.queue]
    this.queue.clear()
    this.writing = this.writing.then(async () => {
      for (const [noteId, q] of batch) await this.write(noteId, q)
    })
    return this.writing
  }

  private async write(noteId: string, q: { spans: SpanRecord[]; retried: boolean }): Promise<void> {
    const valid = q.spans.filter((s) => toStoredSpan(s) !== null)
    if (valid.length < q.spans.length) log('warn', 'sources:spans-invalid', { dropped: q.spans.length - valid.length })
    for (let i = 0; i < valid.length; i += MAX_BATCH) {
      const part = valid.slice(i, i + MAX_BATCH).map((s) => toStoredSpan(s) as NonNullable<ReturnType<typeof toStoredSpan>>)
      try {
        const r = await this.ctx.storage.addSourceSpans(noteId, part)
        log('debug', 'sources:spans-written', { added: r.added, merged: r.merged })
      } catch (err) {
        if (!q.retried) {
          // Once more with the next flush (storage may be starting or busy).
          const back = this.queue.get(noteId) ?? { spans: [], retried: true }
          back.retried = true
          back.spans.unshift(...valid.slice(i))
          this.queue.set(noteId, back)
          this.schedule(RETRY_DELAY_MS)
          log('warn', 'sources:spans-write-retry', { count: part.length, err })
        } else {
          log('warn', 'sources:spans-write-failed', { count: part.length, err })
        }
        return
      }
    }
  }
}
