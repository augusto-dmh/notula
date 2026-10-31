// SPDX-License-Identifier: Apache-2.0
// Microphone capture for dictation: 16 kHz mono s16le through the capture worklet,
// in 100 ms chunks.
//
// - Echo cancellation on the first acquire, off after a re-acquire; noise suppression and
//   auto gain off.
// - Device order: the pinned id, then a unique device with the same label, then a built-in
//   microphone, then the system default (`dictation.microphone` null = built-in if present).
// - A track that ends is re-acquired once; if that fails the error is `mic_lost`.
// - Stop keeps a 100 ms tail.
// - Health: a frame is signal when any sample isn't zero. The mic is silent after 3 s with no
//   signal yet, or 5 s once signal was heard; the mark clears when signal returns. Nothing heard
//   in the first 5 s reopens the mic once. No frames for 2 s is a stall.

import { DICTATION_LIMITS as L, type DictationMicError, type DictationMicHealth, type DictationMicrophone } from '@shared/types/dictation'
import workletUrl from '../capture/worklet.ts?worker&url'

const RATE = 16_000
const BUILT_IN = /built-?in|internal|integrated|array/i

export function micErrorOf(err: unknown): DictationMicError | 'transcription_start' {
  const name = err instanceof DOMException || err instanceof Error ? err.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return 'mic_denied'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'mic_missing'
  if (name === 'NotReadableError' || name === 'AbortError') return 'mic_busy'
  return 'transcription_start'
}

async function pickDevice(choice: DictationMicrophone | null): Promise<string | null> {
  if (choice === 'system-default') return null
  let devices: MediaDeviceInfo[] = []
  try {
    devices = (await navigator.mediaDevices.enumerateDevices()).filter(
      (d) => d.kind === 'audioinput' && d.deviceId !== 'default' && d.deviceId !== 'communications'
    )
  } catch {
    return null
  }
  if (choice && typeof choice === 'object') {
    if (devices.some((d) => d.deviceId === choice.deviceId)) return choice.deviceId
    const same = devices.filter((d) => d.label && d.label === choice.label)
    if (same.length === 1) return same[0]!.deviceId
  }
  const builtIn = devices.find((d) => BUILT_IN.test(d.label))
  return builtIn ? builtIn.deviceId : null
}

function toS16(samples: Float32Array): Uint8Array {
  const out = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] as number))
    out[i] = v < 0 ? v * 0x8000 : v * 0x7fff
  }
  return new Uint8Array(out.buffer)
}

export class MicCapture {
  private ctx: AudioContext | null = null
  private stream: MediaStream | null = null
  private node: AudioWorkletNode | null = null
  private stopped = false
  private reacquired = false
  private reopened = false
  private choice: DictationMicrophone | null = null
  private startedAt = 0
  private lastFrameAt = 0
  private lastSignalAt = 0
  private heard = false
  private silent = false
  private stalled = false
  private health: ReturnType<typeof setInterval> | null = null

  constructor(
    private readonly onChunk: (pcm: Uint8Array) => void,
    private readonly onLevel: (level: number) => void,
    private readonly onError: (e: DictationMicError | 'transcription_start') => void,
    private readonly onHealth: (h: DictationMicHealth) => void = () => undefined
  ) {}

  /** Resolves with the device in use. */
  async start(choice: DictationMicrophone | null): Promise<{ deviceId: string; label: string } | null> {
    const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive', sinkId: { type: 'none' } } as AudioContextOptions)
    this.ctx = ctx
    this.choice = choice
    await ctx.audioWorklet.addModule(workletUrl)
    await this.acquire(choice, true)
    if (ctx.state === 'suspended') await ctx.resume()
    this.startedAt = this.lastFrameAt = Date.now()
    this.health = setInterval(() => this.checkHealth(), 250)
    const track = this.stream?.getAudioTracks()[0]
    return track ? { deviceId: track.getSettings().deviceId ?? '', label: track.label } : null
  }

  private checkHealth(): void {
    if (this.stopped) return
    const now = Date.now()
    if (now - this.lastFrameAt > L.micStallMs) {
      if (!this.stalled) this.onHealth('stall')
      this.stalled = true
    } else this.stalled = false
    const quietFor = this.heard ? now - this.lastSignalAt : now - this.startedAt
    if (!this.silent && quietFor > (this.heard ? L.micSilentAfterSignalMs : L.micSilentMs)) {
      this.silent = true
      this.onHealth('silent')
    }
    // Nothing at all in the first 5 s: reopen the device once.
    if (!this.heard && !this.reopened && now - this.startedAt > L.micReopenMs) {
      this.reopened = true
      this.onHealth('reopened')
      this.node?.disconnect()
      this.stream?.getTracks().forEach((t) => t.stop())
      this.acquire(this.choice, false).catch(() => this.onError('mic_lost'))
    }
  }

  private frame(s: Float32Array): void {
    this.lastFrameAt = Date.now()
    for (let i = 0; i < s.length; i++) {
      if (s[i] !== 0) {
        this.heard = true
        this.lastSignalAt = this.lastFrameAt
        if (this.silent) {
          this.silent = false
          this.onHealth('signal')
        }
        return
      }
    }
  }

  private async acquire(choice: DictationMicrophone | null, echo: boolean): Promise<void> {
    const ctx = this.ctx
    if (!ctx || this.stopped) return
    const deviceId = await pickDevice(choice)
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        echoCancellation: echo,
        noiseSuppression: false,
        autoGainControl: false
      },
      video: false
    })
    if (this.stopped) {
      stream.getTracks().forEach((t) => t.stop())
      return
    }
    this.stream = stream
    const source = ctx.createMediaStreamSource(stream)
    const node = new AudioWorkletNode(ctx, 'notula-capture', { numberOfInputs: 1, numberOfOutputs: 1 })
    node.port.onmessage = (e: MessageEvent<{ samples: Float32Array }>) => {
      if (this.stopped) return
      const s = e.data.samples
      this.frame(s)
      let sum = 0
      for (let i = 0; i < s.length; i++) sum += (s[i] as number) ** 2
      this.onLevel(Math.min(1, Math.sqrt(sum / Math.max(1, s.length)) * 6))
      this.onChunk(toS16(s))
    }
    source.connect(node)
    const sink = ctx.createGain()
    sink.gain.value = 0
    node.connect(sink)
    sink.connect(ctx.destination)
    this.node = node
    const track = stream.getAudioTracks()[0]
    track?.addEventListener('ended', () => {
      if (this.stopped || this.stream !== stream) return
      if (this.reacquired) return this.onError('mic_lost')
      this.reacquired = true
      this.node?.disconnect()
      this.acquire(choice, false).catch(() => this.onError('mic_lost'))
    })
  }

  /** Keeps a 100 ms tail, then releases the device. */
  async stop(tailMs = 100): Promise<void> {
    await new Promise((r) => setTimeout(r, tailMs))
    this.release()
  }

  release(): void {
    this.stopped = true
    if (this.health) clearInterval(this.health)
    this.health = null
    this.node?.port.postMessage({ type: 'stop' })
    this.node?.disconnect()
    this.node = null
    this.stream?.getTracks().forEach((t) => t.stop())
    this.stream = null
    void this.ctx?.close().catch(() => undefined)
    this.ctx = null
  }
}
