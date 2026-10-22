// SPDX-License-Identifier: Apache-2.0
// The renderer capture engine (the browser path,
// on every OS). It receives commands from main, runs them one at a time, captures
// system audio (display media → main's loopback answer) and the microphone (user
// media), and sends main 100 ms s16le buffers per source. The two streams are never
// mixed.
//
// A start names the sources to open; absent means both (every meeting). A source note's
// system-only capture opens no microphone stream at all: device changes, pins and retries
// never reopen a source the start didn't ask for.

import { AUDIO_SOURCES, type CaptureCommand, type CaptureEngineEvent, type InputDevice } from '@shared/types/capture'
import type { AudioSource } from '@shared/types/common'
import workletUrl from './worklet.ts?worker&url'

const ATTEMPTS = 3
const ATTEMPT_GAP_MS = 500
const VOLUME_THROTTLE_MS = 100
/** Background reacquire, 1 s doubling to 30 s, at most 5 retries. */
const BACKGROUND_RETRIES = 5
const BACKGROUND_FIRST_MS = 1_000
const BACKGROUND_MAX_MS = 30_000
const USB_SUFFIX = /\s\([0-9a-f]{4}:[0-9a-f]{4}\)$/i
const ALIASES: ReadonlySet<string> = new Set(['default', 'communications'])
const ALIAS_PREFIX = /^(Default|Communications)\s*-\s*/i
const UNAVAILABLE = new Set(['OverconstrainedError', 'NotFoundError', 'NotReadableError'])

interface Wired {
  stream: MediaStream
  track: MediaStreamTrack
  node: MediaStreamAudioSourceNode
  worklet: AudioWorkletNode
}

class StoppedError extends Error {
  constructor() {
    super('capture stopped')
    this.name = 'AbortError'
  }
}

function errName(err: unknown): string {
  if (err && typeof err === 'object' && 'name' in err && typeof err.name === 'string') return err.name
  return 'Error'
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function errConstraint(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'constraint' in err && typeof err.constraint === 'string') return err.constraint
  return undefined
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class CaptureEngine {
  private queue: Promise<void> = Promise.resolve()
  private ctx: AudioContext | null = null
  private sink: GainNode | null = null
  private wired: Partial<Record<AudioSource, Wired>> = {}
  private running = false
  /** The sources the current start asked for. */
  private sources: readonly AudioSource[] = AUDIO_SOURCES
  /** Bumped by stop: pending attempts of an older generation abort. */
  private generation = 0
  private sampleRate = 16_000
  private desiredDeviceId: string | null = null
  /** The pin the wired microphone was opened for, even when it fell back to the default. */
  private micRequested: string | null = null
  private useRealSink = false
  private restartRequested = false
  private videoFallback = false
  private ecAllUnsupported = false
  private readonly ended: Record<AudioSource, number> = { microphone: 0, system: 0 }
  private readonly reacquiring = new Set<AudioSource>()
  private readonly reacquireAgain = new Set<AudioSource>()
  private readonly retry: Record<AudioSource, { timer: number | null; attempt: number }> = {
    microphone: { timer: null, attempt: 0 },
    system: { timer: null, attempt: 0 }
  }
  private readonly volume: Record<AudioSource, { rms: number; timer: number | null }> = {
    microphone: { rms: 0, timer: null },
    system: { rms: 0, timer: null }
  }
  private rawDevices: MediaDeviceInfo[] = []
  private devices: InputDevice[] = []
  private disposed = false
  private readonly onDeviceChange = (): void => this.handleDeviceChange()

  constructor(private readonly send: (e: CaptureEngineEvent) => void) {}

  /** Registers with main: `initialized`, then the device list. */
  init(): void {
    navigator.mediaDevices.addEventListener('devicechange', this.onDeviceChange)
    this.send({ type: 'initialized' })
    void this.reportDevices()
  }

  dispose(): void {
    this.disposed = true
    navigator.mediaDevices.removeEventListener('devicechange', this.onDeviceChange)
    this.generation++
    this.enqueue(() => this.teardownAll(true))
  }

  handle(cmd: CaptureCommand): void {
    if (this.disposed) return
    switch (cmd.type) {
      case 'start':
        this.enqueue(() => this.start(cmd.sampleRate, cmd.pinnedDeviceId, cmd.audioSources))
        return
      case 'stop':
        // Stopping aborts pending attempts at once.
        this.generation++
        this.enqueue(() => this.teardownAll(true))
        return
      case 'use-input-device':
        this.enqueue(async () => {
          this.desiredDeviceId = cmd.deviceId
          this.reacquire('microphone', 'pin')
        })
        return
      case 'release-input-device':
        // The next reacquire uses the default device.
        this.enqueue(async () => {
          this.desiredDeviceId = null
        })
        return
      case 'restart-system-audio':
        this.enqueue(async () => this.reacquire('system', 'restart'))
        return
    }
  }

  // ---------- queue ----------

  private enqueue(fn: () => Promise<void>): void {
    this.queue = this.queue.then(fn).catch((err: unknown) => {
      this.log('error', 'engine-command-failed', { name: errName(err), message: errMessage(err) })
    })
  }

  // ---------- start / stop ----------

  private async start(sampleRate: number, pinnedDeviceId: string | null, audioSources?: AudioSource[]): Promise<void> {
    if (this.running) await this.teardownAll(false)
    const gen = this.generation
    const asked = AUDIO_SOURCES.filter((s) => audioSources?.includes(s))
    this.sources = asked.length > 0 ? asked : AUDIO_SOURCES
    this.sampleRate = sampleRate
    this.desiredDeviceId = pinnedDeviceId
    this.ended.microphone = 0
    this.ended.system = 0
    try {
      await this.openContext()
    } catch (err) {
      this.log('error', 'audio-context-failed', { name: errName(err), message: errMessage(err) })
      await this.closeContext()
      this.send({ type: 'start-failed', error: `${errName(err)}: ${errMessage(err)}` })
      return
    }
    if (gen !== this.generation) return this.closeContext()
    this.running = true
    const ok: AudioSource[] = []
    // System first, then the microphone; only the requested ones.
    for (const source of (['system', 'microphone'] as const).filter((s) => this.sources.includes(s))) {
      try {
        await this.acquire(source, gen, false)
        ok.push(source)
      } catch (err) {
        if (gen !== this.generation) return
        this.send({ type: 'source-error', source, name: errName(err), message: errMessage(err) })
      }
    }
    if (gen !== this.generation) return
    if (!ok.length) {
      this.running = false
      await this.closeContext()
      this.send({ type: 'start-failed', error: 'No audio source could be captured.' })
      return
    }
    this.send({ type: 'started', sources: ok })
    window.notula.power.preventDisplaySleep()
    await this.reportDevices()
    this.reportActiveDevice()
    void this.reportSystemSource()
  }

  private async openContext(): Promise<void> {
    const opts: AudioContextOptions & { sinkId?: { type: 'none' } } = {
      sampleRate: this.sampleRate,
      latencyHint: 'interactive'
    }
    // A silent sink unless an earlier context error moved us to a real one.
    if (!this.useRealSink) opts.sinkId = { type: 'none' }
    const ctx = new AudioContext(opts)
    this.ctx = ctx
    ctx.addEventListener('error', () => this.onContextError('context-error'))
    const sink = ctx.createGain()
    sink.gain.value = 0
    sink.connect(ctx.destination)
    this.sink = sink
    await ctx.audioWorklet.addModule(workletUrl)
    if (ctx.state === 'suspended') await ctx.resume()
  }

  private async closeContext(): Promise<void> {
    const ctx = this.ctx
    this.ctx = null
    this.sink = null
    if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => undefined)
  }

  private async teardownAll(report: boolean): Promise<void> {
    for (const source of ['system', 'microphone'] as const) {
      this.unwire(source)
      this.clearRetry(source)
      const v = this.volume[source]
      if (v.timer !== null) clearTimeout(v.timer)
      v.timer = null
      v.rms = 0
    }
    const wasRunning = this.running
    this.running = false
    await this.closeContext()
    if (!report || !wasRunning) return
    window.notula.power.allowDisplaySleep()
    this.send({ type: 'volume', source: 'microphone', rms: 0 })
    this.send({ type: 'volume', source: 'system', rms: 0 })
    this.send({ type: 'system-source', label: null })
    this.send({ type: 'active-device', deviceId: null, label: null })
    await this.reportDevices()
    this.send({ type: 'stopped' })
  }

  private onContextError(kind: string): void {
    this.log('error', 'audio-context-error', { kind, silentSink: !this.useRealSink })
    if (this.useRealSink || this.restartRequested) return
    // Once: ask main for a full restart and use a real sink from then on.
    this.restartRequested = true
    this.useRealSink = true
    this.send({ type: 'restart-request', scope: 'all' })
  }

  // ---------- acquisition ----------

  /** Up to 3 attempts, 500 ms apart; only "not readable"/"not found" retry (plus abort on reacquire). */
  private async withAttempts<T>(gen: number, retryAbort: boolean, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      if (gen !== this.generation) throw new StoppedError()
      try {
        return await fn()
      } catch (err) {
        const name = errName(err)
        const retryable = name === 'NotReadableError' || name === 'NotFoundError' || (retryAbort && name === 'AbortError')
        if (!retryable || attempt >= ATTEMPTS) throw err
        await sleep(ATTEMPT_GAP_MS)
      }
    }
  }

  private async acquire(source: AudioSource, gen: number, reacquire: boolean): Promise<void> {
    const stream = await this.withAttempts(gen, reacquire, () =>
      source === 'system' ? this.systemStream() : this.micStream()
    )
    if (gen !== this.generation || !this.ctx || !this.sink) {
      for (const t of stream.getTracks()) t.stop()
      throw new StoppedError()
    }
    this.wire(source, stream)
  }

  private async systemStream(): Promise<MediaStream> {
    const audio: MediaTrackConstraints = {
      sampleRate: this.sampleRate,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false
    }
    let stream: MediaStream | null = null
    if (!this.videoFallback) {
      try {
        stream = await navigator.mediaDevices.getDisplayMedia({ audio, video: false })
      } catch (err) {
        if (errName(err) !== 'TypeError') throw err
        // Fallback: Chromium refuses audio-only display media. Request minimal
        // video (main supplies a screen source plus loopback) and drop it at once.
        this.videoFallback = true
        this.log('warn', 'system-audio-video-fallback', { message: errMessage(err) })
      }
    }
    if (!stream) {
      stream = await navigator.mediaDevices.getDisplayMedia({ audio, video: { width: 1, height: 1, frameRate: 1 } })
      for (const t of stream.getVideoTracks()) {
        t.stop()
        stream.removeTrack(t)
      }
    }
    if (!stream.getAudioTracks().length) {
      for (const t of stream.getTracks()) t.stop()
      const err = new Error('Display media returned no audio track.')
      err.name = 'NotFoundError'
      throw err
    }
    return stream
  }

  private micConstraints(deviceId: string | null): MediaTrackConstraints {
    // Echo cancellation in the `all` mode (ideal) keeps remote speech played through
    // the speakers out of "Me". It stays on only while the source has ended
    // at most once.
    const ec: ConstrainBoolean | { ideal: string } =
      this.ended.microphone > 1 ? false : this.ecAllUnsupported ? true : { ideal: 'all' }
    return {
      sampleRate: this.sampleRate,
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: ec as ConstrainBoolean
    }
  }

  private async micStream(): Promise<MediaStream> {
    const pinned = this.desiredDeviceId
    try {
      const stream = await this.getUserMediaEc(pinned)
      this.micRequested = pinned
      return stream
    } catch (err) {
      const name = errName(err)
      const onDevice = name !== 'OverconstrainedError' || errConstraint(err) === 'deviceId'
      if (!pinned || !UNAVAILABLE.has(name) || !onDevice) throw err
      // A pinned microphone that is unavailable falls back once to the default.
      this.log('warn', 'pinned-mic-unavailable', { name, message: errMessage(err) })
      const stream = await this.getUserMediaEc(null)
      this.micRequested = pinned
      return stream
    }
  }

  private async getUserMediaEc(deviceId: string | null): Promise<MediaStream> {
    try {
      return await navigator.mediaDevices.getUserMedia({ audio: this.micConstraints(deviceId), video: false })
    } catch (err) {
      const name = errName(err)
      const ecRejected =
        !this.ecAllUnsupported &&
        (name === 'TypeError' || (name === 'OverconstrainedError' && errConstraint(err) === 'echoCancellation'))
      if (!ecRejected) throw err
      // `all` is not honored here; fall back to plain echo cancellation.
      this.ecAllUnsupported = true
      this.log('warn', 'echo-cancellation-all-unsupported', { name, message: errMessage(err) })
      return navigator.mediaDevices.getUserMedia({ audio: this.micConstraints(deviceId), video: false })
    }
  }

  private wire(source: AudioSource, stream: MediaStream): void {
    const ctx = this.ctx as AudioContext
    const track = stream.getAudioTracks()[0] as MediaStreamTrack
    const node = ctx.createMediaStreamSource(stream)
    const worklet = new AudioWorkletNode(ctx, 'notula-capture', { numberOfInputs: 1, numberOfOutputs: 1 })
    worklet.port.onmessage = (e: MessageEvent<{ samples: Float32Array; timeMs: number }>) => {
      if (this.wired[source]?.worklet === worklet) this.onSamples(source, e.data.samples, e.data.timeMs)
    }
    worklet.addEventListener('processorerror', () => this.onContextError('processor-error'))
    node.connect(worklet)
    worklet.connect(this.sink as GainNode)
    track.addEventListener('ended', () => {
      if (this.wired[source]?.track !== track) return
      this.ended[source]++
      this.log('warn', 'track-ended', { source, count: this.ended[source] })
      this.reacquire(source, 'track-ended')
    })
    this.wired[source] = { stream, track, node, worklet }
    const settings = track.getSettings()
    this.log('info', 'source-acquired', {
      source,
      label: track.label,
      sampleRate: settings.sampleRate ?? 0,
      channelCount: settings.channelCount ?? 0,
      echoCancellation: String(settings.echoCancellation ?? 'unset')
    })
  }

  private unwire(source: AudioSource): void {
    const w = this.wired[source]
    if (!w) return
    delete this.wired[source]
    w.worklet.port.onmessage = null
    // Otherwise the processor stays alive until the context closes.
    w.worklet.port.postMessage({ type: 'stop' })
    try {
      w.node.disconnect()
      w.worklet.disconnect()
    } catch {
      // Already disconnected.
    }
    for (const t of w.stream.getTracks()) t.stop()
  }

  // ---------- samples ----------

  private onSamples(source: AudioSource, samples: Float32Array, timeMs: number): void {
    let sum = 0
    const pcm = new Int16Array(samples.length)
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i] as number
      sum += s * s
      const v = s < -1 ? -1 : s > 1 ? 1 : s
      pcm[i] = Math.round(v * 32767)
    }
    this.reportVolume(source, Math.sqrt(sum / (samples.length || 1)))
    this.send({ type: 'buffer', source, pcm: new Uint8Array(pcm.buffer), captureTimeMs: timeMs })
  }

  /** RMS per source, throttled to 100 ms (trailing). */
  private reportVolume(source: AudioSource, rms: number): void {
    const v = this.volume[source]
    v.rms = rms
    if (v.timer !== null) return
    v.timer = window.setTimeout(() => {
      v.timer = null
      if (this.running) this.send({ type: 'volume', source, rms: Math.min(1, v.rms) })
    }, VOLUME_THROTTLE_MS)
  }

  // ---------- recovery ----------

  /** Overlapping triggers are coalesced into one rerun. */
  private reacquire(source: AudioSource, why: string): void {
    if (!this.running || !this.sources.includes(source)) return
    if (this.reacquiring.has(source)) {
      this.reacquireAgain.add(source)
      return
    }
    this.reacquiring.add(source)
    this.enqueue(async () => {
      try {
        do {
          this.reacquireAgain.delete(source)
          await this.reacquireOnce(source, why)
        } while (this.reacquireAgain.has(source) && this.running)
      } finally {
        this.reacquiring.delete(source)
      }
    })
  }

  private async reacquireOnce(source: AudioSource, why: string): Promise<void> {
    if (!this.running || !this.sources.includes(source)) return
    const gen = this.generation
    const requested = source === 'microphone' ? this.desiredDeviceId : null
    this.unwire(source)
    try {
      await this.acquire(source, gen, true)
      this.clearRetry(source)
      this.log('info', 'source-reacquired', { source, why })
      if (source === 'microphone') {
        const got = this.wired.microphone?.track.getSettings().deviceId ?? null
        if (requested && requested !== 'default' && got !== requested) {
          this.log('warn', 'reacquired-different-device', { requested, got: got ?? 'none' })
        }
        this.reportActiveDevice()
      } else {
        void this.reportSystemSource()
      }
    } catch (err) {
      if (gen !== this.generation) return
      this.send({ type: 'source-error', source, name: errName(err), message: errMessage(err) })
      if (source === 'microphone') this.reportActiveDevice()
      this.scheduleRetry(source)
    }
  }

  private scheduleRetry(source: AudioSource): void {
    const r = this.retry[source]
    if (r.timer !== null || r.attempt >= BACKGROUND_RETRIES) return
    const delay = Math.min(BACKGROUND_MAX_MS, BACKGROUND_FIRST_MS * Math.pow(2, r.attempt))
    r.attempt++
    r.timer = window.setTimeout(() => {
      r.timer = null
      this.reacquire(source, 'background-retry')
    }, delay)
  }

  private clearRetry(source: AudioSource): void {
    const r = this.retry[source]
    if (r.timer !== null) clearTimeout(r.timer)
    r.timer = null
    r.attempt = 0
  }

  private handleDeviceChange(): void {
    void this.reportDevices().then(() => {
      if (!this.running) return
      this.reportActiveDevice()
      this.reacquire('system', 'device-change')
      if (this.micStillMatches()) return
      this.reacquire('microphone', 'device-change')
    })
  }

  /** Skips a no-op mic reacquire: same device, or same group as the default alias. */
  private micStillMatches(): boolean {
    const w = this.wired.microphone
    if (!w || w.track.readyState !== 'live') return false
    const s = w.track.getSettings()
    if (this.desiredDeviceId && this.desiredDeviceId !== 'default') return s.deviceId === this.desiredDeviceId
    const def = this.rawDevices.find((d) => d.kind === 'audioinput' && d.deviceId === 'default')
    return !!def && !!s.groupId && def.groupId === s.groupId
  }

  // ---------- reports ----------

  private async reportDevices(): Promise<void> {
    try {
      this.rawDevices = await navigator.mediaDevices.enumerateDevices()
    } catch (err) {
      this.log('warn', 'enumerate-devices-failed', { message: errMessage(err) })
      return
    }
    const inputs = this.rawDevices.filter((d) => d.kind === 'audioinput')
    const def = inputs.find((d) => d.deviceId === 'default')
    // Both aliases are left out: Auto follows the meeting app's microphone.
    this.devices = inputs
      .filter((d) => !ALIASES.has(d.deviceId))
      .map((d) => ({
        deviceId: d.deviceId,
        groupId: d.groupId,
        label: d.label.replace(USB_SUFFIX, ''),
        isDefault: !!def && d.groupId === def.groupId
      }))
    this.send({ type: 'devices', devices: this.devices })
  }

  private reportActiveDevice(): void {
    const w = this.wired.microphone
    if (!w || w.track.readyState !== 'live') {
      this.send({ type: 'active-device', deviceId: null, label: null })
      return
    }
    const s = w.track.getSettings()
    const id = s.deviceId ?? null
    // The `default` / `communications` aliases resolve to the physical device in their group.
    const known =
      this.devices.find((d) => d.deviceId === id && !ALIASES.has(d.deviceId)) ??
      (id && ALIASES.has(id) ? this.devices.find((d) => !ALIASES.has(d.deviceId) && d.groupId === s.groupId) : undefined)
    this.send({
      type: 'active-device',
      deviceId: known?.deviceId ?? id,
      label: known?.label ?? w.track.label.replace(ALIAS_PREFIX, '').replace(USB_SUFFIX, ''),
      requestedDeviceId: this.micRequested
    })
  }

  private async reportSystemSource(): Promise<void> {
    if (!this.wired.system) {
      this.send({ type: 'system-source', label: null })
      return
    }
    const out = this.rawDevices.find((d) => d.kind === 'audiooutput' && d.deviceId === 'default')
    const name = out?.label.replace(/^Default\s*-\s*/i, '').replace(USB_SUFFIX, '')
    this.send({ type: 'system-source', label: name || 'Default output device' })
  }

  private log(level: 'info' | 'warn' | 'error', event: string, data?: Record<string, string | number | boolean>): void {
    this.send({ type: 'log', level, event, ...(data ? { data } : {}) })
  }
}
