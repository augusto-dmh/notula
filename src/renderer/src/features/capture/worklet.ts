// SPDX-License-Identifier: Apache-2.0
// The capture AudioWorklet: collects 100 ms of
// mono samples (channel 0 at the context rate: 1,600 samples at 16 kHz) and posts
// them with the wall-clock time of the batch's first sample. Loaded through Vite's
// `?worker&url`, so it is bundled and passes CSP `script-src 'self'`.
//
// A `{ type: 'stop' }` message ends the processor: `process()` then returns false,
// so the context can release it once its node is disconnected.

declare const sampleRate: number
declare class AudioWorkletProcessor {
  readonly port: MessagePort
  constructor(options?: unknown)
}
declare function registerProcessor(name: string, ctor: new (options?: unknown) => AudioWorkletProcessor): void

class CaptureProcessor extends AudioWorkletProcessor {
  private readonly size = Math.round(sampleRate / 10)
  private buf = new Float32Array(this.size)
  private n = 0
  private firstTimeMs = 0
  private stopped = false

  constructor(options?: unknown) {
    super(options)
    this.port.onmessage = (e: MessageEvent<{ type?: unknown }>) => {
      if (e.data?.type === 'stop') this.stopped = true
    }
  }

  process(inputs: Float32Array[][]): boolean {
    if (this.stopped) return false
    const ch = inputs[0]?.[0]
    if (!ch) return true
    const now = Date.now()
    for (let i = 0; i < ch.length; i++) {
      if (this.n === 0) this.firstTimeMs = now + (i / sampleRate) * 1000
      this.buf[this.n++] = ch[i] as number
      if (this.n === this.size) {
        const samples = this.buf
        this.port.postMessage({ samples, timeMs: this.firstTimeMs }, [samples.buffer])
        this.buf = new Float32Array(this.size)
        this.n = 0
      }
    }
    return true
  }
}

registerProcessor('notula-capture', CaptureProcessor)

export {}
