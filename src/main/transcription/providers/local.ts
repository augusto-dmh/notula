// SPDX-License-Identifier: Apache-2.0
// The local AsrProvider.
// One notula-asr utility process per source runs sherpa-onnx with Parakeet or
// Whisper large-v3-turbo; it sits behind the same provider contract as the cloud
// sockets, so the session, chunks and transcript view do not change. The model is
// chosen per session language (asr/choice.ts).
//
// Timings: ready ≤ 120 s; a pre-ready queue of the last 60 s; a capture gap
// over 3,000 ms is sent as `skip`; a ping every 30 s with 2 misses allowed; finalize
// ≤ 15 s on stop; kill 1 s after `shutdown`. The connection reports "open" only once
// the worker is ready, but accepts audio as soon as the worker is forked, so a model
// load never loses audio (it waits in the pre-ready queue).

import { EventEmitter } from 'node:events'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { AudioSource } from '@shared/types/common'
import type { Settings } from '@shared/types/settings'
import {
  DEFAULT_LOCAL_ASR_MODEL,
  LOCAL_ASR_MODELS,
  localAsrModelInfo,
  localLanguageCode,
  localModelCovers,
  type AsrProviderId,
  type LocalAsrModelId
} from '@shared/types/transcript'
import { chooseLocalModel, whisperLanguage } from '../../asr/choice'
import { existingLocalModels, workerEnv, workerPath } from '../../asr/instance'
import type { LocalModelManager } from '../../asr/models'
import type { SettingsApi } from '../../context'
import type { AsrFinalizeStats, AsrToMain, AsrWorkerArgs, MainToAsr, VerifiedFile } from '../../asr/protocol'
import { baseName } from '../../asr/verify'
import { log } from '../../log'
import { AwakeBudget, awakeTimer } from '../awake'
import type { AsrConnection, AsrConnectionEvents, AsrConnectOptions, AsrProvider, AsrResult } from './types'

/** The English default, which a meeting downloads on demand. */
export const LOCAL_ASR_MODEL: LocalAsrModelId = DEFAULT_LOCAL_ASR_MODEL

const READY_TIMEOUT_MS = 120_000
const PRE_READY_MAX_MS = 60_000
const SKIP_THRESHOLD_MS = 3_000
const PING_EVERY_MS = 30_000
const MAX_MISSED_PINGS = 2
const FINALIZE_WAIT_MS = 15_000
const KILL_GRACE_MS = 1_000
const RESTART_MIN_MS = 1_000
const RESTART_MAX_MS = 10_000
const NUM_THREADS = 2
/** Whisper turbo is about 3× Parakeet's work per second of audio: two sources still fit 8 of 16 threads. */
const WHISPER_THREADS = 4
const HOTWORD_SCORE = 2
/** s16le mono at 16 kHz. */
const BYTES_PER_MS = 32

interface Queued {
  pcm: Buffer
  captureTimeMs: number
}

/**
 * Whether on-device transcription covers the session language: English
 * always (its default downloads on demand), any other language once an installed
 * model covers it.
 */
export function localCovers(language: string): boolean {
  if (localLanguageCode(language) === 'en') return true
  const models = existingLocalModels()
  return !!models && LOCAL_ASR_MODELS.some((m) => localModelCovers(m.id, language) && models.isReady(m.id))
}

export type LocalChoicePrefs = Pick<Settings, 'asr.local.model' | 'asr.local.prefer'>

/** The model a session in this language uses, or null when no installed model covers it. */
export function pickLocalModel(models: LocalModelManager, language: string, prefs: LocalChoicePrefs): LocalAsrModelId | null {
  return chooseLocalModel(language, {
    choice: prefs['asr.local.model'],
    prefer: prefs['asr.local.prefer'],
    isReady: (id) => models.isReady(id)
  })
}

function workerArgs(models: LocalModelManager, modelId: LocalAsrModelId, language: string): AsrWorkerArgs {
  const files = models.files(modelId)
  const pick = (name: string): VerifiedFile => {
    const f = files.find((x) => baseName(x.path) === name)
    if (!f) throw new Error(`manifest has no ${name}`)
    return f
  }
  if (modelId === 'whisper-large-v3-turbo-int8') {
    return {
      engine: 'whisper',
      modelId,
      files: { encoder: pick('turbo-encoder.int8.onnx'), decoder: pick('turbo-decoder.int8.onnx'), tokens: pick('turbo-tokens.txt') },
      language: whisperLanguage(language),
      sampleRate: 16000,
      hotwordScore: HOTWORD_SCORE,
      numThreads: WHISPER_THREADS
    }
  }
  return {
    engine: 'parakeet',
    modelId,
    files: {
      encoder: pick('encoder.int8.onnx'),
      decoder: pick('decoder.int8.onnx'),
      joiner: pick('joiner.int8.onnx'),
      tokens: pick('tokens.txt')
    },
    sampleRate: 16000,
    hotwordScore: HOTWORD_SCORE,
    numThreads: NUM_THREADS
  }
}

function isMessage(m: unknown): m is AsrToMain {
  return !!m && typeof m === 'object' && typeof (m as { type?: unknown }).type === 'string'
}

export class LocalConnection extends EventEmitter<AsrConnectionEvents> implements AsrConnection {
  readonly providerId: AsrProviderId = 'local'
  readonly model: string
  readonly replayIntervalMs = 0
  private proc: UtilityProcess | null = null
  private ready = false
  private everReady = false
  private closing = false
  /** One per worker, so segment keys never collide across restarts. */
  private gen = 0
  private baseEpochMs: number | null = null
  private sentMs = 0
  private preReady: Queued[] = []
  private preReadyMs = 0
  private overflowLogged = false
  private readyTimer: NodeJS.Timeout | null = null
  private pingTimer: NodeJS.Timeout | null = null
  private restartTimer: NodeJS.Timeout | null = null
  private pingId = 0
  private awaitingPong: number | null = null
  private missedPings = 0
  private retries = 0
  private downSince = 0
  private release: (() => void) | null = null
  private readyWaiters: ((ok: boolean) => void)[] = []
  private finalizedWaiter: ((stats: AsrFinalizeStats | null) => void) | null = null
  private exitWaiter: (() => void) | null = null

  constructor(
    private readonly models: LocalModelManager,
    private readonly source: AudioSource,
    private keywords: string[],
    private readonly modelId: LocalAsrModelId = LOCAL_ASR_MODEL,
    private readonly language = 'en'
  ) {
    super()
    this.model = modelId
  }

  start(): this {
    void this.boot()
    return this
  }

  isOpen(): boolean {
    // Forked: audio is accepted, and waits in the pre-ready queue until `ready`.
    return !this.closing && this.proc !== null
  }

  send(pcm: Buffer, captureTimeMs: number): boolean {
    if (!this.isOpen()) return false
    if (!this.ready) {
      this.preReady.push({ pcm, captureTimeMs })
      this.preReadyMs += pcm.byteLength / BYTES_PER_MS
      // The last 60 s are kept, oldest dropped first, always keeping one entry.
      while (this.preReadyMs > PRE_READY_MAX_MS && this.preReady.length > 1) {
        const old = this.preReady.shift() as Queued
        this.preReadyMs -= old.pcm.byteLength / BYTES_PER_MS
        if (!this.overflowLogged) {
          this.overflowLogged = true
          log('warn', 'asr:local-preready-overflow', { source: this.source, keptMs: Math.round(this.preReadyMs) })
        }
      }
      return true
    }
    this.post(pcm, captureTimeMs)
    return true
  }

  updateKeywords(terms: string[]): void {
    this.keywords = terms
    if (this.ready) this.postMsg({ type: 'keywords', terms })
  }

  retryNow(): void {
    if (this.closing || this.proc) return
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    void this.boot()
  }

  /**
   * For ctx.speech: decodes everything sent so far, without closing, so a warm worker can
   * serve the next dictation. Resolves false when the worker is not ready or the wait ran out.
   */
  async drain(timeoutMs: number): Promise<boolean> {
    if (this.closing || !this.proc) return false
    if (!this.ready && !(await this.waitReady(timeoutMs))) return false
    return (await this.finalize(Math.min(FINALIZE_WAIT_MS, timeoutMs))) !== null
  }

  /** The worker is loaded and decoding. */
  isReady(): boolean {
    return this.ready && !this.closing
  }

  async close(timeoutMs = 20_000): Promise<void> {
    if (this.closing) return
    this.closing = true
    // Awake time: a finalize that a sleep interrupts goes on after the wake.
    const budget = new AwakeBudget(timeoutMs)
    if (this.restartTimer) clearTimeout(this.restartTimer)
    this.restartTimer = null
    this.stopPing()
    const proc = this.proc
    try {
      if (proc) {
        // A worker still loading gets the chance to transcribe the queued audio.
        if (!this.ready) await this.waitReady(budget.left() - KILL_GRACE_MS)
        if (this.ready && this.proc === proc) {
          const stats = await this.finalize(Math.min(FINALIZE_WAIT_MS, budget.left() - KILL_GRACE_MS))
          log(stats ? 'info' : 'warn', 'asr:local-finalized', { source: this.source, ...(stats ?? { timedOut: true }) })
        } else if (this.preReadyMs > 0) {
          // The session counted this audio as sent; say that it is lost.
          log('warn', 'asr:local-preready-dropped', { source: this.source, ms: Math.round(this.preReadyMs) })
        }
        await this.shutdown(proc)
      }
    } finally {
      budget.done()
    }
    this.proc = null
    this.ready = false
    this.release?.()
    this.release = null
    this.emit('close', { willReconnect: false })
  }

  // ---------- the worker ----------

  private async boot(): Promise<void> {
    // A meeting that starts with the model missing downloads it first. The
    // wait has the ready limit: past it the start fails, so the session can
    // fail over or show Retry while the download goes on.
    if (!this.models.isReady(this.modelId) && this.modelId !== LOCAL_ASR_MODEL) {
      // A multilingual model is only downloaded when the user asks for it.
      this.startFailed(null, `The ${localAsrModelInfo(this.modelId).name} speech model is not downloaded.`)
      return
    }
    if (!this.models.isReady(this.modelId)) {
      log('info', 'asr:local-waiting-for-model', { source: this.source })
      let timer: NodeJS.Timeout | undefined
      const ok = await Promise.race([
        this.models.ensureReady(this.modelId).catch(() => false),
        new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), READY_TIMEOUT_MS)
        })
      ])
      clearTimeout(timer)
      if (this.closing) return
      if (ok === 'timeout') {
        this.startFailed(null, 'The speech model did not finish downloading within 120 s.')
        return
      }
      if (!ok) {
        this.startFailed(null, 'The speech model could not be downloaded.')
        return
      }
    }
    this.spawn()
  }

  private spawn(): void {
    if (this.closing || this.proc) return
    let args: AsrWorkerArgs
    try {
      args = workerArgs(this.models, this.modelId, this.language)
    } catch (err) {
      this.startFailed(null, err instanceof Error ? err.message : String(err))
      return
    }
    this.gen++
    this.ready = false
    this.baseEpochMs = null
    this.sentMs = 0
    this.preReady = []
    this.preReadyMs = 0
    this.awaitingPong = null
    this.missedPings = 0
    this.release ??= this.models.use(this.modelId)
    const proc = utilityProcess.fork(workerPath('asr'), [JSON.stringify(args)], {
      serviceName: 'notula-asr',
      env: workerEnv()
    })
    this.proc = proc
    const gen = this.gen
    proc.once('spawn', () =>
      log('info', 'asr:local-spawn', { source: this.source, gen, pid: proc.pid ?? 0, modelId: this.modelId, language: this.language })
    )
    proc.on('message', (m: unknown) => this.onMessage(proc, m))
    proc.once('exit', (code: number) => this.onExit(proc, code))
    this.readyTimer = setTimeout(() => {
      if (this.proc === proc && !this.ready) this.startFailed(proc, 'The speech model did not load within 120 s.')
    }, READY_TIMEOUT_MS)
  }

  private onMessage(proc: UtilityProcess, m: unknown): void {
    if (proc !== this.proc) return
    if (!isMessage(m)) {
      if (!this.ready) this.startFailed(proc, 'The local engine sent a malformed message.')
      else log('warn', 'asr:local-malformed', { source: this.source })
      return
    }
    switch (m.type) {
      case 'ready':
        this.onReady(m.loadMs)
        return
      case 'partial':
      case 'segment':
        this.onResult(m)
        return
      case 'progress':
        if (this.baseEpochMs !== null) {
          this.emit('progress', { savedThroughEpochMs: this.baseEpochMs + m.committedMs })
        }
        return
      case 'pong':
        if (m.id === this.awaitingPong) {
          this.awaitingPong = null
          this.missedPings = 0
        }
        return
      case 'finalized':
        this.finalizedWaiter?.(m.stats)
        return
      case 'error':
        if (!this.ready) this.startFailed(proc, m.message)
        else this.crashed(proc, m.message)
        return
      case 'log':
        log(m.level, m.event, { source: this.source, ...(m.data ?? {}) })
        return
    }
  }

  private onReady(loadMs: number): void {
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
    this.ready = true
    log('info', 'asr:local-ready', { source: this.source, gen: this.gen, loadMs })
    if (this.keywords.length) this.postMsg({ type: 'keywords', terms: this.keywords })
    this.startPing()
    // The queue is flushed in order, with the original capture times.
    const queued = this.preReady
    this.preReady = []
    this.preReadyMs = 0
    for (const q of queued) this.post(q.pcm, q.captureTimeMs)
    for (const w of this.readyWaiters.splice(0)) w(true)
    if (this.everReady) {
      this.emit('reconnect', { retry: this.retries, downMs: Date.now() - this.downSince })
      this.retries = 0
    }
    this.everReady = true
    this.emit('open')
  }

  private onResult(m: Extract<AsrToMain, { type: 'partial' | 'segment' }>): void {
    if (this.baseEpochMs === null) return
    const result: AsrResult = {
      segmentKey: `${this.gen}:${m.segmentId}`,
      isFinal: m.type === 'segment',
      text: m.text,
      startMs: m.startMs,
      endMs: m.endMs,
      baseEpochMs: this.baseEpochMs,
      // Words carry conf 0 and no speaker.
      words: m.words.map((w) => ({ w: w.w, s_ms: w.s_ms, e_ms: w.e_ms, conf: 0 }))
    }
    this.emit('result', result)
  }

  private onExit(proc: UtilityProcess, code: number): void {
    if (proc !== this.proc) return
    this.exitWaiter?.()
    if (this.closing) return
    if (!this.ready) this.startFailed(proc, `The local engine exited (${code}) before it was ready.`)
    else this.crashed(proc, `The local engine exited unexpectedly (${code}).`)
  }

  /** Before ready: the start failed. The session fails over; Retry starts again. */
  private startFailed(proc: UtilityProcess | null, message: string): void {
    if (proc && proc !== this.proc) return
    this.teardown(proc)
    for (const w of this.readyWaiters.splice(0)) w(false)
    log('warn', 'asr:local-start-failed', { source: this.source, message })
    this.emit('error', { kind: 'provider', message, fatal: true })
  }

  /** After ready: a connection error; the worker restarts like a socket reconnects. */
  private crashed(proc: UtilityProcess, message: string): void {
    if (proc !== this.proc) return
    this.teardown(proc)
    this.downSince = Date.now()
    log('warn', 'asr:local-crashed', { source: this.source, message, retries: this.retries })
    this.emit('close', { willReconnect: true })
    this.emit('error', { kind: 'provider', message })
    const delay = Math.min(RESTART_MAX_MS, RESTART_MIN_MS * 2 ** this.retries)
    this.retries++
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null
      void this.boot()
    }, delay)
  }

  private teardown(proc: UtilityProcess | null): void {
    if (this.readyTimer) clearTimeout(this.readyTimer)
    this.readyTimer = null
    this.stopPing()
    this.proc = null
    this.ready = false
    this.preReady = []
    this.preReadyMs = 0
    try {
      proc?.kill()
    } catch {
      // Already gone.
    }
  }

  private post(pcm: Buffer, captureTimeMs: number): void {
    // The first buffer's capture time is the timing anchor.
    if (this.baseEpochMs === null) {
      this.baseEpochMs = captureTimeMs
      this.sentMs = 0
    } else {
      const gap = captureTimeMs - (this.baseEpochMs + this.sentMs)
      if (gap > SKIP_THRESHOLD_MS) {
        this.postMsg({ type: 'skip', ms: Math.round(gap) })
        this.sentMs += gap
        log('info', 'asr:local-skip', { source: this.source, ms: Math.round(gap) })
      }
    }
    this.postMsg({ type: 'audio', pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) })
    this.sentMs += pcm.byteLength / BYTES_PER_MS
  }

  private postMsg(m: MainToAsr): void {
    try {
      this.proc?.postMessage(m)
    } catch (err) {
      log('warn', 'asr:local-post-failed', { source: this.source, type: m.type, err })
    }
  }

  private startPing(): void {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      const proc = this.proc
      if (!proc || !this.ready) return
      if (this.awaitingPong !== null) {
        this.missedPings++
        if (this.missedPings >= MAX_MISSED_PINGS) {
          this.crashed(proc, 'The local engine stopped answering pings.')
          return
        }
      }
      this.awaitingPong = ++this.pingId
      this.postMsg({ type: 'ping', id: this.awaitingPong })
    }, PING_EVERY_MS)
  }

  private stopPing(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private waitReady(ms: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true)
    if (!this.proc || ms <= 0) return Promise.resolve(false)
    return new Promise((resolve) => {
      const cancel = awakeTimer(ms, () => resolve(false))
      this.readyWaiters.push((ok) => {
        cancel()
        resolve(ok)
      })
    })
  }

  private finalize(ms: number): Promise<AsrFinalizeStats | null> {
    if (ms <= 0) return Promise.resolve(null)
    return new Promise((resolve) => {
      const cancel = awakeTimer(ms, () => {
        this.finalizedWaiter = null
        resolve(null)
      })
      this.finalizedWaiter = (stats) => {
        cancel()
        this.finalizedWaiter = null
        resolve(stats)
      }
      this.postMsg({ type: 'finalize' })
    })
  }

  /** `shutdown`, then a kill 1 s later if the worker is still there. */
  private shutdown(proc: UtilityProcess): Promise<void> {
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.exitWaiter = null
        try {
          proc.kill()
        } catch {
          // Already gone.
        }
        resolve()
      }, KILL_GRACE_MS)
      this.exitWaiter = () => {
        clearTimeout(t)
        this.exitWaiter = null
        resolve()
      }
      this.postMsg({ type: 'shutdown' })
    })
  }
}

export function createLocalProvider(deps: { models: LocalModelManager; settings: SettingsApi }): AsrProvider {
  /** Sessions whose ignored keywords were logged (once per session). */
  const keywordsLogged = new Set<string>()
  const pick = async (language: string): Promise<LocalAsrModelId | null> =>
    pickLocalModel(deps.models, language, {
      'asr.local.model': await deps.settings.get('asr.local.model'),
      'asr.local.prefer': await deps.settings.get('asr.local.prefer')
    })
  return {
    id: 'local',
    kind: 'local',
    available: async (language) => {
      const id = await pick(language)
      if (!id) return { ok: false, reason: 'unsupported-language' }
      return deps.models.isReady(id) ? { ok: true } : { ok: false, reason: 'not-installed' }
    },
    model: async (language) => (await pick(language)) ?? LOCAL_ASR_MODEL,
    connect: async (opts: AsrConnectOptions) => {
      if (opts.keywords.length && !keywordsLogged.has(opts.sessionId)) {
        if (keywordsLogged.size > 50) keywordsLogged.clear()
        keywordsLogged.add(opts.sessionId)
        // Hotwords are off until a vocabulary is pinned.
        log('info', 'asr:local-keywords-ignored', { sessionId: opts.sessionId, source: opts.source, terms: opts.keywords.length })
      }
      const modelId = (await pick(opts.language)) ?? LOCAL_ASR_MODEL
      return new LocalConnection(deps.models, opts.source, opts.keywords, modelId, opts.language).start()
    },
    test: async () => {
      const id = LOCAL_ASR_MODELS.map((m) => m.id).find((m) => deps.models.isReady(m))
      if (!id) return { ok: false, error: 'The speech model is not downloaded.' }
      const conn = new LocalConnection(deps.models, 'microphone', [], id).start()
      const outcome = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
        conn.once('open', () => resolve({ ok: true }))
        conn.once('error', (e) => resolve({ ok: false, error: e.message }))
      })
      await conn.close(3_000)
      return outcome
    }
  }
}
