// SPDX-License-Identifier: Apache-2.0
// ctx.speech: speech recognizers over the transcription providers, for dictation and chat
// voice input. Main-only; the renderer never sees a
// key or a provider socket.
//
// - Choice: `auto` takes an installed local model that covers the language (by
//   asr/choice.ts, Whisper turbo or Parakeet v3 for other languages), else
//   `asr.provider`. A cloud provider without a key, or blocked by local-only mode, falls back to
//   an installed local model; otherwise `no-provider`.
// - Deepgram: `wss://api.deepgram.com/v1/listen` with model=nova-3, language, encoding=linear16,
//   sample_rate=16000, channels=1, punctuate=true, mip_opt_out=true and repeated keyterm; only
//   final Results count; finish sends CloseStream and waits ≤ 5 s for Metadata.
// - AssemblyAI: Universal Streaming v3 with keyterms_prompt; formatted end-of-turn transcripts
//   joined with spaces; finish sends Terminate and waits ≤ 5 s for Termination.
// - Segments: a cloud segment closes at ≥ 100 s of audio ending in ≥ 0.3 s of silence
//   (mean square ≤ 1e-4), else at 115 s. A failed segment (401, 429, 5xx, a network error) is
//   retried once from its buffered audio after `retry-after` (1 s for 429/503); a wait over 5 s
//   fails it. A later segment's failure keeps the earlier text.
// - Readiness: 6 s (30 s for a cold local worker); failures map to RecognizerError reasons.
// - Local: one notula-asr worker per recognizer, or the warm one kept while `setLocalWarm(true)`
//   (for the same model and language), unloaded after 10 min idle. Its own VAD segments the
//   audio; finish drains it.

import { EventEmitter } from 'node:events'
import { net } from 'electron'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types/settings'
import { localLanguageCode, type AsrProviderId, type CloudAsrProviderId, type LocalAsrModelId } from '@shared/types/transcript'
import type { LocalModelManager } from '../asr/models'
import type { MainContext } from '../context'
import { log } from '../log'
import { egressBlocked, LOCAL_ONLY_REASON } from '../privacy'
import { RecognizerError, type RecognizerOptions, type SpeechApi, type SpeechRecognizer } from './api'
import { cleanKeywords, deepgramKeyterms } from './keywords'
import { devAsrEndpoint } from './providers/dev-endpoint'
import { LocalConnection, pickLocalModel } from './providers/local'
import type { AsrResult } from './providers/types'
import { ReconnectingSocket } from './socket'

const READY_MS = 6_000
const COLD_READY_MS = 30_000
const SEGMENT_MIN_MS = 100_000
const SEGMENT_MAX_MS = 115_000
const SILENCE_TAIL_SAMPLES = 4_800
const SILENCE_MEAN_SQUARE = 1e-4
const RETRY_MAX_WAIT_MS = 5_000
const CLOSE_WAIT_MS = 5_000
const WARM_IDLE_MS = 10 * 60_000
const LOCAL_DRAIN_MS = 15_000
/** s16le mono at 16 kHz. */
const BYTES_PER_MS = 32
/** AssemblyAI wants 50–1,000 ms frames; a replay goes in 100 ms frames, 5× real time. */
const AAI_FRAME_BYTES = 3_200
const AAI_REPLAY_GAP_MS = 20

const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen'
const ASSEMBLYAI_URLS = {
  edge: 'wss://streaming.assemblyai.com/v3/ws',
  us: 'wss://streaming.us.assemblyai.com/v3/ws',
  eu: 'wss://streaming.eu.assemblyai.com/v3/ws'
} as const
const ASSEMBLYAI_VERSION = { 'AssemblyAI-Version': '2025-05-12' }

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// ---------- one cloud socket for one segment ----------

interface RunFailure {
  kind: 'auth' | 'network' | 'provider'
  status: number
  message: string
}

class StreamRun extends EventEmitter<{ open: []; failed: [RunFailure] }> {
  private readonly socket: ReconnectingSocket
  readonly texts: string[] = []
  readonly languages: string[] = []
  state: 'connecting' | 'open' | 'failed' | 'closed' = 'connecting'
  failure: RunFailure | null = null
  private done: (() => void) | null = null

  constructor(
    readonly provider: CloudAsrProviderId,
    url: string,
    headers: () => Promise<Record<string, string> | null>
  ) {
    super()
    this.socket = new ReconnectingSocket({
      name: `speech:${provider}`,
      url: () => url,
      headers,
      connectTimeoutMs: 2_000,
      minDelayMs: 200,
      maxDelayMs: 500,
      capDelayMs: 1_000
    })
    this.socket.on('open', () => {
      if (this.state !== 'connecting') return
      this.state = 'open'
      this.emit('open')
    })
    this.socket.on('failure', (f) => {
      if (this.state === 'closed') return
      this.failure = { kind: f.kind, status: f.status ?? 0, message: f.message }
      // A refused key will not start working: fail now instead of retrying.
      if (f.kind === 'auth') this.fail()
    })
    this.socket.on('close', ({ willReconnect }) => {
      // Mid-stream drop: this segment's audio on the dead socket is lost, so the segment
      // fails and is replayed from its buffer on a fresh socket.
      if (willReconnect && this.state === 'open') this.fail()
      if (!willReconnect) this.done?.()
    })
    this.socket.on('message', (data, isBinary) => {
      if (isBinary) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(data.toString()) as Record<string, unknown>
      } catch {
        return
      }
      this.onMessage(msg)
    })
  }

  start(): this {
    this.socket.start()
    return this
  }

  /** The run failed (dropped, refused or errored), whatever it was doing. */
  didFail(): boolean {
    return this.state === 'failed'
  }

  private fail(): void {
    if (this.state === 'failed' || this.state === 'closed') return
    this.state = 'failed'
    const f = this.failure ?? { kind: 'network', status: 0, message: 'The connection dropped.' }
    void this.socket.close(500)
    this.emit('failed', f)
  }

  private onMessage(msg: Record<string, unknown>): void {
    const type = msg['type']
    if (this.provider === 'deepgram') {
      if (type === 'Results' && msg['is_final'] === true) {
        const alt = ((msg['channel'] as { alternatives?: unknown[] } | undefined)?.alternatives?.[0] ?? {}) as {
          transcript?: unknown
          languages?: unknown
        }
        if (typeof alt.transcript === 'string' && alt.transcript.trim()) this.texts.push(alt.transcript.trim())
        const langs = Array.isArray(alt.languages) ? alt.languages.filter((l): l is string => typeof l === 'string') : []
        this.languages.push(...langs)
      } else if (type === 'Metadata') this.done?.()
      return
    }
    if (type === 'Turn' && msg['end_of_turn'] === true && msg['turn_is_formatted'] === true) {
      const t = msg['transcript']
      if (typeof t === 'string' && t.trim()) this.texts.push(t.trim())
      if (typeof msg['language_code'] === 'string') this.languages.push(msg['language_code'])
    } else if (type === 'Termination') this.done?.()
    else if (type === 'Error') {
      this.failure = { kind: 'provider', status: 0, message: String(msg['error'] ?? 'Provider error') }
      this.fail()
    }
  }

  /** Resolves 'open', 'auth', 'failed' or 'timeout'. */
  waitOpen(ms: number): Promise<'open' | 'auth' | 'failed' | 'timeout'> {
    if (this.state === 'open') return Promise.resolve('open')
    if (this.state === 'failed') return Promise.resolve(this.failure?.kind === 'auth' ? 'auth' : 'failed')
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        cleanup()
        resolve('timeout')
      }, ms)
      const onOpen = (): void => {
        cleanup()
        resolve('open')
      }
      const onFail = (f: RunFailure): void => {
        cleanup()
        resolve(f.kind === 'auth' ? 'auth' : 'failed')
      }
      const cleanup = (): void => {
        clearTimeout(t)
        this.off('open', onOpen)
        this.off('failed', onFail)
      }
      this.once('open', onOpen)
      this.once('failed', onFail)
    })
  }

  send(pcm: Buffer): boolean {
    return this.state === 'open' && this.socket.sendBinary(pcm)
  }

  /** Asks the provider for its last results, then closes. */
  async finish(): Promise<void> {
    if (this.state !== 'open') {
      await this.abort()
      return
    }
    const finished = new Promise<void>((resolve) => {
      this.done = resolve
    })
    this.socket.sendJson({ type: this.provider === 'deepgram' ? 'CloseStream' : 'Terminate' }, false)
    await Promise.race([finished, sleep(CLOSE_WAIT_MS)])
    this.state = this.state === 'open' ? 'closed' : this.state
    await this.socket.close(1_000)
  }

  async abort(): Promise<void> {
    if (this.state === 'connecting' || this.state === 'open') this.state = 'closed'
    await this.socket.close(500)
  }
}

// ---------- recognizers ----------

interface CloudConfig {
  url: string
  headers: () => Promise<Record<string, string> | null>
}

interface Segment {
  index: number
  audio: Buffer[]
  bytes: number
  /** Audio not yet sent on the live run. */
  sentUpTo: number
  run: StreamRun | null
  /** All of the segment's audio is in. */
  sealed: boolean
  result: Promise<{ ok: boolean; text: string; languages: string[] }> | null
}

function meanSquareTail(seg: Segment): number {
  // The last 0.3 s of the segment, as normalized float samples.
  let need = SILENCE_TAIL_SAMPLES * 2
  let sum = 0
  let n = 0
  for (let i = seg.audio.length - 1; i >= 0 && need > 0; i--) {
    const b = seg.audio[i] as Buffer
    const take = Math.min(need, b.byteLength - (b.byteLength % 2))
    for (let k = b.byteLength - take; k + 1 < b.byteLength; k += 2) {
      const v = b.readInt16LE(k) / 32768
      sum += v * v
      n++
    }
    need -= take
  }
  return n ? sum / n : 1
}

class CloudRecognizer implements SpeechRecognizer {
  readonly ready: Promise<void>
  private readonly segments: Segment[] = []
  private cur: Segment | null = null
  private finished = false
  private cancelled = false
  private audioBytes = 0
  private config: CloudConfig | null = null

  constructor(
    private providerId: CloudAsrProviderId,
    private readonly resolve: () => Promise<CloudConfig>,
    private readonly onFallback: (() => SpeechRecognizer | null) | null
  ) {
    this.ready = this.boot()
    this.ready.catch(() => undefined)
  }

  get provider(): AsrProviderId {
    return this.delegate?.provider ?? this.providerId
  }

  /** A local recognizer that took over (no key, or local-only mode). */
  private delegate: SpeechRecognizer | null = null

  private async boot(): Promise<void> {
    let config: CloudConfig
    try {
      config = await this.resolve()
    } catch (err) {
      if (err instanceof RecognizerError && err.reason === 'no-provider' && this.onFallback) {
        const local = this.onFallback()
        if (local) {
          log('info', 'speech:fallback-local', { from: this.providerId, why: err.message })
          this.delegate = local
          for (const s of this.segments) for (const b of s.audio) local.feed(b)
          await local.ready
          return
        }
      }
      throw err
    }
    this.config = config
    const seg = this.cur ?? this.newSegment()
    this.startRun(seg)
    const r = await (seg.run as StreamRun).waitOpen(READY_MS)
    if (r === 'open') return
    if (r === 'auth') throw new RecognizerError('transcription_start', `The ${this.providerId === 'deepgram' ? 'Deepgram' : 'AssemblyAI'} key was refused.`)
    if (r === 'timeout') throw new RecognizerError('connection_timeout', 'The transcription service did not answer within 6 s.')
    throw new RecognizerError('transcription_start', seg.run?.failure?.message ?? 'The transcription could not start.')
  }

  private newSegment(): Segment {
    const seg: Segment = { index: this.segments.length, audio: [], bytes: 0, sentUpTo: 0, run: null, sealed: false, result: null }
    this.segments.push(seg)
    this.cur = seg
    return seg
  }

  private startRun(seg: Segment): void {
    if (!this.config || seg.run) return
    const run = new StreamRun(this.providerId, this.config.url, this.config.headers).start()
    seg.run = run
    run.once('open', () => this.pump(seg))
    seg.result = this.settle(seg)
  }

  /** Sends the segment's unsent audio on its live run. */
  private pump(seg: Segment): void {
    const run = seg.run
    if (!run || run.state !== 'open') return
    while (seg.sentUpTo < seg.audio.length) {
      for (const frame of frames(seg.audio[seg.sentUpTo] as Buffer, this.providerId)) run.send(frame)
      seg.sentUpTo++
    }
  }

  feed(pcm: Buffer): void {
    if (this.finished || this.cancelled || !pcm.byteLength) return
    if (this.delegate) {
      this.delegate.feed(pcm)
      return
    }
    const seg = this.cur ?? this.newSegment()
    const copy = Buffer.from(pcm)
    seg.audio.push(copy)
    seg.bytes += copy.byteLength
    this.audioBytes += copy.byteLength
    this.pump(seg)
    const ms = seg.bytes / BYTES_PER_MS
    if (ms >= SEGMENT_MAX_MS || (ms >= SEGMENT_MIN_MS && meanSquareTail(seg) <= SILENCE_MEAN_SQUARE)) {
      seg.sealed = true
      this.cur = null
      const next = this.newSegment()
      this.startRun(next)
    }
  }

  /** The segment's text: its live run, or one replay of its buffered audio. */
  private async settle(seg: Segment): Promise<{ ok: boolean; text: string; languages: string[] }> {
    const run = seg.run as StreamRun
    const outcome = await run.waitOpen(READY_MS)
    if (outcome === 'open') {
      await this.untilSealed(seg)
      if (run.state === 'open') {
        this.pump(seg)
        await run.finish()
        if (!run.didFail()) return { ok: true, text: run.texts.join(' '), languages: run.languages }
      }
    } else await run.abort()
    if (this.cancelled) return { ok: false, text: '', languages: [] }
    // One retry, after retry-after (1 s for 429 and 503); longer than 5 s fails it.
    const f = run.failure
    if (f?.kind === 'auth') return { ok: false, text: '', languages: [] }
    const wait = f && (f.status === 429 || f.status === 503) ? 1_000 : 0
    if (wait > RETRY_MAX_WAIT_MS) return { ok: false, text: '', languages: [] }
    await sleep(wait)
    await this.untilSealed(seg)
    if (!this.config) return { ok: false, text: '', languages: [] }
    log('info', 'speech:segment-retry', { provider: this.providerId, segment: seg.index, status: f?.status ?? 0 })
    const retry = new StreamRun(this.providerId, this.config.url, this.config.headers).start()
    if ((await retry.waitOpen(READY_MS)) !== 'open') {
      await retry.abort()
      return { ok: false, text: '', languages: [] }
    }
    for (const b of seg.audio) {
      for (const frame of frames(b, this.providerId)) {
        retry.send(frame)
        if (this.providerId === 'assemblyai') await sleep(AAI_REPLAY_GAP_MS)
      }
    }
    await retry.finish()
    return retry.didFail() ? { ok: false, text: '', languages: [] } : { ok: true, text: retry.texts.join(' '), languages: retry.languages }
  }

  private async untilSealed(seg: Segment): Promise<void> {
    while (!seg.sealed && !this.cancelled) await sleep(50)
  }

  async finish(): Promise<{ text: string; language: string | null; audioMs: number }> {
    if (this.cancelled) throw new RecognizerError('transcription_start', 'The recognizer was cancelled.')
    this.finished = true
    await this.ready
    if (this.delegate) return this.delegate.finish()
    if (this.cur) this.cur.sealed = true
    const results = await Promise.all(this.segments.map((s) => s.result ?? Promise.resolve({ ok: false, text: '', languages: [] })))
    const ok = results.filter((r) => r.ok)
    if (!ok.length && this.audioBytes > 0) {
      throw new RecognizerError('connection', 'The transcription service did not return the text.')
    }
    if (ok.length < results.length) log('warn', 'speech:partial', { provider: this.providerId, failed: results.length - ok.length })
    const text = ok.map((r) => r.text).filter(Boolean).join(' ').trim()
    const langs = ok.flatMap((r) => r.languages)
    return { text, language: mostCommon(langs), audioMs: Math.round(this.audioBytes / BYTES_PER_MS) }
  }

  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    this.delegate?.cancel()
    for (const s of this.segments) {
      s.sealed = true
      void s.run?.abort()
    }
  }
}

function* frames(pcm: Buffer, provider: CloudAsrProviderId): Generator<Buffer> {
  if (provider !== 'assemblyai' || pcm.byteLength <= AAI_FRAME_BYTES * 10) {
    yield pcm
    return
  }
  for (let at = 0; at < pcm.byteLength; at += AAI_FRAME_BYTES) yield pcm.subarray(at, at + AAI_FRAME_BYTES)
}

function mostCommon(values: string[]): string | null {
  const counts = new Map<string, number>()
  for (const v of values) counts.set(v, (counts.get(v) ?? 0) + 1)
  let best: string | null = null
  let n = 0
  for (const [v, c] of counts) if (c > n) [best, n] = [v, c]
  return best
}

class LocalRecognizer implements SpeechRecognizer {
  readonly provider: AsrProviderId = 'local'
  readonly ready: Promise<void>
  private readonly texts = new Map<string, string>()
  private fedMs = 0
  private readonly t0 = Date.now()
  private finished = false
  private cancelled = false
  private readonly onResult = (r: AsrResult): void => {
    if (r.isFinal && r.text.trim()) this.texts.set(r.segmentKey, r.text.trim())
  }

  constructor(
    private readonly conn: LocalConnection,
    warmReady: boolean,
    private readonly release: (conn: LocalConnection, healthy: boolean) => void,
    /** The base code transcribed, or null when the model detected it. */
    private readonly language: string | null = 'en'
  ) {
    conn.on('result', this.onResult)
    this.ready = this.waitReady(warmReady ? READY_MS : COLD_READY_MS)
    this.ready.catch(() => undefined)
  }

  private waitReady(ms: number): Promise<void> {
    if (this.conn.isReady()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        cleanup()
        reject(new RecognizerError('connection_timeout', 'The on-device speech model did not load in time.'))
      }, ms)
      const onOpen = (): void => {
        cleanup()
        resolve()
      }
      const onError = (e: { message: string; fatal?: boolean }): void => {
        if (!e.fatal) return
        cleanup()
        reject(new RecognizerError('transcription_start', e.message))
      }
      const cleanup = (): void => {
        clearTimeout(t)
        this.conn.off('open', onOpen)
        this.conn.off('error', onError)
      }
      this.conn.on('open', onOpen)
      this.conn.on('error', onError)
    })
  }

  feed(pcm: Buffer): void {
    if (this.finished || this.cancelled || !pcm.byteLength) return
    // A steady clock: the worker sees no gaps, so it never inserts a skip.
    this.conn.send(Buffer.from(pcm), this.t0 + this.fedMs)
    this.fedMs += pcm.byteLength / BYTES_PER_MS
  }

  async finish(): Promise<{ text: string; language: string | null; audioMs: number }> {
    if (this.cancelled) throw new RecognizerError('transcription_start', 'The recognizer was cancelled.')
    this.finished = true
    try {
      await this.ready
    } catch (err) {
      this.done(false)
      throw err
    }
    const ok = await this.conn.drain(LOCAL_DRAIN_MS)
    const text = [...this.texts.values()].join(' ').trim()
    this.done(ok)
    if (!ok && !text) throw new RecognizerError('connection', 'The on-device engine did not finish.')
    return { text, language: this.language, audioMs: Math.round(this.fedMs) }
  }

  cancel(): void {
    if (this.cancelled) return
    this.cancelled = true
    this.done(false)
  }

  private done(healthy: boolean): void {
    this.conn.off('result', this.onResult)
    this.release(this.conn, healthy)
  }
}

// ---------- the service ----------

class SpeechService implements SpeechApi {
  private settings: Settings = structuredClone(DEFAULT_SETTINGS)
  private warmWanted = false
  private warm: LocalConnection | null = null
  /** `<model>:<base code>` of the warm worker. */
  private warmKey = ''
  private warmBusy = false
  private idleTimer: NodeJS.Timeout | null = null
  private readonly coldKeys = new WeakMap<LocalConnection, string>()

  constructor(
    private readonly ctx: MainContext,
    private readonly models: LocalModelManager
  ) {
    const load = (): void => {
      void ctx.settings
        .getAll()
        .then((s) => {
          this.settings = s
        })
        .catch(() => undefined)
    }
    ctx.bus.on('settings:changed', ({ settings }) => {
      this.settings = settings
    })
    ctx.bus.on('storage:status', (s) => {
      if (s.state === 'ready') load()
    })
    load()
  }

  openRecognizer(opts: RecognizerOptions): SpeechRecognizer {
    const language = typeof opts.language === 'string' && opts.language ? opts.language : 'auto'
    const keyterms = cleanKeywords((opts.keyterms ?? []).filter((t) => typeof t === 'string' && t.length <= 50)).slice(0, 100)
    const model = pickLocalModel(this.models, language, this.settings)
    const localReady = !!model && this.models.isReady(model)
    let provider: AsrProviderId
    if (opts.choice === 'auto') {
      const configured = this.settings['asr.provider']
      provider = localReady ? 'local' : configured
    } else provider = opts.choice
    log('info', 'speech:open', { purpose: opts.purpose, choice: opts.choice, provider, language, keyterms: keyterms.length, ...(provider === 'local' ? { model } : {}) })
    if (provider === 'local') {
      if (!model || !localReady) return failed('local', new RecognizerError('no-provider', 'The on-device speech model is not downloaded.'))
      return this.local(model, language)
    }
    const cloud = provider
    return new CloudRecognizer(
      cloud,
      () => this.cloudConfig(cloud, language, keyterms),
      opts.choice === 'auto' && model && localReady ? () => this.local(model, language) : null
    )
  }

  private async cloudConfig(provider: CloudAsrProviderId, language: string, keyterms: string[]): Promise<CloudConfig> {
    if (await egressBlocked(this.ctx, { kind: 'asr', provider })) {
      log('info', 'speech:blocked', { provider, reason: LOCAL_ONLY_REASON })
      throw new RecognizerError('no-provider', LOCAL_ONLY_REASON)
    }
    const secret = provider === 'deepgram' ? 'asr.deepgram' : 'asr.assemblyai'
    if (!(await this.ctx.secrets.get(secret))) throw new RecognizerError('no-provider', 'No key is set for this provider.')
    if (!net.isOnline()) throw new RecognizerError('offline', 'This computer is offline.')
    const headers = async (): Promise<Record<string, string> | null> => {
      const key = await this.ctx.secrets.get(secret)
      if (!key) return null
      return provider === 'deepgram' ? { Authorization: `Token ${key}` } : { Authorization: key, ...ASSEMBLYAI_VERSION }
    }
    if (provider === 'deepgram') {
      const q = new URLSearchParams()
      q.set('model', 'nova-3')
      q.set('language', language === 'auto' ? 'multi' : language)
      q.set('encoding', 'linear16')
      q.set('sample_rate', '16000')
      q.set('channels', '1')
      q.set('punctuate', 'true')
      q.set('mip_opt_out', 'true')
      for (const t of deepgramKeyterms(keyterms)) q.append('keyterm', t)
      return { url: `${devAsrEndpoint('deepgram') ?? DEEPGRAM_URL}?${q.toString()}`, headers }
    }
    const english = language === 'en' || language.startsWith('en-')
    const q = new URLSearchParams()
    q.set('sample_rate', '16000')
    q.set('format_turns', 'true')
    q.set('speech_model', english ? 'universal-streaming-english' : this.settings['asr.assemblyai.multilingualModel'])
    if (!english) q.set('language_detection', 'true')
    if (keyterms.length) q.set('keyterms_prompt', JSON.stringify(keyterms))
    const region = this.settings['asr.assemblyai.region']
    return { url: `${devAsrEndpoint('assemblyai') ?? ASSEMBLYAI_URLS[region] ?? ASSEMBLYAI_URLS.edge}?${q.toString()}`, headers }
  }

  /** A local recognizer: the warm worker when it is free and the same model and language, else a cold one. */
  private local(model: LocalAsrModelId, language: string): SpeechRecognizer {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    let conn: LocalConnection
    let warm = false
    if (this.warm && !this.warmBusy && this.warmKey === warmKeyOf(model, language)) {
      conn = this.warm
      warm = conn.isReady()
      this.warmBusy = true
    } else {
      conn = new LocalConnection(this.models, 'microphone', [], model, language).start()
      // A cold worker for another model or language may replace an idle warm one on release.
      this.coldKeys.set(conn, warmKeyOf(model, language))
    }
    const code = localLanguageCode(language)
    return new LocalRecognizer(conn, warm, (c, healthy) => this.release(c, healthy), code === 'multi' ? null : code)
  }

  /** The language dictation would ask for now (as dictation/index.ts derives it). */
  private warmLanguage(): string {
    const stored = this.settings['dictation.language']
    if (stored) return stored
    const asr = this.settings['asr.language']
    return asr === 'multi' ? 'auto' : asr === 'pt-BR' ? 'pt' : 'en'
  }

  private release(conn: LocalConnection, healthy: boolean): void {
    if (conn === this.warm) {
      this.warmBusy = false
      if (!healthy || !this.warmWanted) {
        this.warm = null
        void conn.close(3_000)
      } else this.armIdle()
      return
    }
    const key = this.coldKeys.get(conn) ?? ''
    this.coldKeys.delete(conn)
    // A cold worker becomes the warm one when dictation wants one and it is healthy; it
    // replaces an idle warm worker of another model or language.
    if (healthy && this.warmWanted && (!this.warm || (!this.warmBusy && this.warmKey !== key))) {
      const old = this.warm
      this.warm = conn
      this.warmKey = key
      if (old) void old.close(3_000)
      this.armIdle()
      return
    }
    void conn.close(3_000)
  }

  private armIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (!this.warm || this.warmBusy) return
      log('info', 'speech:warm-unloaded', { reason: 'idle' })
      const c = this.warm
      this.warm = null
      void c.close(3_000)
    }, WARM_IDLE_MS)
    this.idleTimer.unref()
  }

  setLocalWarm(on: boolean): void {
    this.warmWanted = on
    if (on) {
      const language = this.warmLanguage()
      const model = pickLocalModel(this.models, language, this.settings)
      if (!this.warm && model && this.models.isReady(model)) {
        this.warm = new LocalConnection(this.models, 'microphone', [], model, language).start()
        this.warmKey = warmKeyOf(model, language)
        log('info', 'speech:warm-loading', { model, language })
      }
      this.armIdle()
      return
    }
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
    if (this.warm && !this.warmBusy) {
      const c = this.warm
      this.warm = null
      void c.close(3_000)
    }
  }
}

function warmKeyOf(model: LocalAsrModelId, language: string): string {
  return `${model}:${localLanguageCode(language)}`
}

/** A recognizer that failed before it started. */
function failed(provider: AsrProviderId, err: RecognizerError): SpeechRecognizer {
  const ready = Promise.reject(err)
  ready.catch(() => undefined)
  return {
    provider,
    ready,
    feed: () => undefined,
    finish: () => Promise.reject(err),
    cancel: () => undefined
  }
}

export function createSpeechService(ctx: MainContext, models: LocalModelManager): SpeechApi {
  return new SpeechService(ctx, models)
}
