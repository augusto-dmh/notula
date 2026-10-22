// SPDX-License-Identifier: Apache-2.0
// The 100 ms audio batcher. Buffers per source
// and flushes once a source holds at least sampleRate × 1 channel × 2 bytes × 100 ms
// (3,200 bytes at 16 kHz). A flushed batch is one contiguous buffer stamped with
// the capture time of its first buffer.

import type { AudioSource } from '@shared/types/common'

export const SAMPLE_RATE = 16_000
export const BATCH_MS = 100
export const BATCH_BYTES = (SAMPLE_RATE * 1 * 2 * BATCH_MS) / 1000

export type BatchSink = (source: AudioSource, pcm: Buffer, captureTimeMs: number) => void

interface Pending {
  parts: Buffer[]
  bytes: number
  firstTimeMs: number
}

export class AudioBatcher {
  private readonly pending = new Map<AudioSource, Pending>()
  private destroyed = false

  constructor(private readonly sink: BatchSink) {}

  push(source: AudioSource, pcm: Buffer, captureTimeMs: number): void {
    if (this.destroyed) return
    let p = this.pending.get(source)
    if (!p) {
      p = { parts: [], bytes: 0, firstTimeMs: captureTimeMs }
      this.pending.set(source, p)
    }
    if (p.bytes === 0) p.firstTimeMs = captureTimeMs
    p.parts.push(pcm)
    p.bytes += pcm.byteLength
    if (p.bytes >= BATCH_BYTES) this.flushSource(source)
  }

  /** Flushes every source, whatever it holds. */
  flush(): void {
    for (const source of this.pending.keys()) this.flushSource(source)
  }

  destroy(): void {
    this.flush()
    this.destroyed = true
    this.pending.clear()
  }

  private flushSource(source: AudioSource): void {
    const p = this.pending.get(source)
    if (!p || p.bytes === 0) return
    const batch = p.parts.length === 1 ? (p.parts[0] as Buffer) : Buffer.concat(p.parts, p.bytes)
    const time = p.firstTimeMs
    p.parts = []
    p.bytes = 0
    this.sink(source, batch, time)
  }
}
