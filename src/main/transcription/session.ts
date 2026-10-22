// SPDX-License-Identifier: Apache-2.0
// One transcription session per note.
// It opens one connection per source, owns the pending buffer, the segment→UUID map
// and the chunk merge, and fails over across configured providers.
//
// The failover target is language-aware; a cloud source that fails can be bridged by
// the local engine for a while; the local engine's progress acknowledges
// audio; with diarization on, chunks keep their words (providerDetails) and the audio
// is teed for the pass at stop.

import { randomUUID } from 'node:crypto'
import type { AudioSource, IsoTime, SourceState } from '@shared/types/common'
import type { AsrProviderId, ProviderWord, TranscriptChunk } from '@shared/types/transcript'
import type { AudioRecorder, RecordedFile } from '../asr/diarize'
import type { SessionRecorder } from '../recordings/service'
import type { StorageIdentity } from '../storage/api'
import { log } from '../log'
import { AwakeBudget, awakeTimer, withAwakeTimeout } from './awake'
import type { ChunkStore } from './chunks'
import { baseCode, pickFallback, type MultiModel } from './languages'
import { PendingBuffer, type AudioEntry } from './pending'
import { localCovers } from './providers/local'
import { FAILOVER_BUDGET, type AsrRegistry } from './providers/registry'
import type { AsrConnection, AsrError, AsrResult } from './providers/types'

const SOURCES: AudioSource[] = ['microphone', 'system']
/** Consecutive failed attempts (no stable open in between) before a failover. */
const FAILOVER_AFTER_FAILURES = 3
const SANITY_LOG_EVERY_MS = 10_000
const FUTURE_TOLERANCE_MS = 2_000
/** The whole stop drain of a session, unless the caller gives a tighter budget. */
export const DRAIN_TIMEOUT_MS = 20_000
/** Kept back from a stop budget for the graceful close (CloseStream / Terminate). */
const STOP_CLOSE_RESERVE_MS = 3_000
/** The local bridge for a failed cloud source: 60 s plus up to 60 s, doubling to 10 min. */
const BRIDGE_BASE_MS = 60_000
const BRIDGE_JITTER_MS = 60_000
const BRIDGE_MAX_MS = 600_000

export type SessionState = 'starting' | 'running' | 'stopping' | 'stopped'

export interface SessionOptions {
  noteId: string
  language: string
  keywords: string[]
  chain: AsrProviderId[]
  identity: StorageIdentity
  onSourceState(source: AudioSource, state: SourceState): void
  /** Diarization is on: chunks keep their words, and the audio is teed. */
  diarization: boolean
  /** The tee for this session (its id is the file name), when diarization is on. */
  recorderFor: ((sessionId: string) => AudioRecorder) | null
  /** The multilingual models, for the language-aware failover. */
  multiModels: { deepgram: MultiModel; assemblyai: MultiModel }
  /** The kept-audio tee for this session, while "Keep meeting audio" is on. */
  keepAudioFor: ((sessionId: string) => SessionRecorder | null) | null
  /** The attribution stamp for final system chunks. */
  attribution: SystemAttribution | null
  /** A source's failover budget ran out. */
  onFailoverExhausted?(source: AudioSource, providers: AsrProviderId[]): void
  /** The sources to transcribe; absent = both. An unlisted source never connects. */
  sources?: readonly AudioSource[]
}

/** What the session needs from speaker attribution (the speakers module). */
export interface SystemAttribution {
  /** Some attribution source is on: system chunks keep their words, and finals are stamped. */
  active(): boolean
  /** A final system chunk with its words and speaker filled in, or the chunk unchanged. */
  stamp(chunk: TranscriptChunk): TranscriptChunk
}

class SourceStream {
  readonly pending: PendingBuffer
  private conn: AsrConnection | null = null
  private providerIdx = 0
  private readonly failovers = new Map<AsrProviderId, number>()
  private failures = 0
  private readonly segments = new Map<string, string>()
  private state: SourceState = 'inactive'
  private replayTimer: NodeJS.Timeout | null = null
  private lastStartIso = ''
  private sanityLogAt = 0
  /** Set when a stop begins: no new audio, but the backlog is still sent. */
  private draining: Promise<void> | null = null
  private stopped = false
  private connecting: Promise<boolean> | null = null
  /** The last socket died with partials on screen; retract them when a replay starts. */
  private retractOnOpen = false
  private lastErrorKind: AsrError['kind'] | null = null
  /** Local bridge: the cloud provider to go back to, its timer, and the doubling backoff. */
  private bridgeReturn: AsrProviderId | null = null
  private bridgeTimer: NodeJS.Timeout | null = null
  private bridgeBackoffMs = BRIDGE_BASE_MS
  /** Local failed to start during a bridge: no more bridging for this source. */
  private bridgeDisabled = false
  /** `transcription:failover-exhausted` was reported for this source. */
  private exhaustedReported = false

  constructor(
    private readonly session: TranscriptionSession,
    readonly source: AudioSource
  ) {
    this.pending = new PendingBuffer(source)
  }

  get provider(): AsrProviderId | null {
    return this.session.chain[this.providerIdx] ?? null
  }

  start(): Promise<boolean> {
    const p = this.connect()
    this.connecting = p
    void p.finally(() => {
      if (this.connecting === p) this.connecting = null
    })
    return p
  }

  private async connect(): Promise<boolean> {
    const provider = this.provider
    if (!provider) {
      this.setState('error')
      log('error', 'asr:no-provider', { source: this.source, sessionId: this.session.id })
      return false
    }
    this.setState('starting')
    try {
      const conn = await this.session.registry[provider].connect({
        source: this.source,
        language: this.session.language,
        keywords: this.session.keywords,
        sampleRate: 16000,
        sessionId: this.session.id
      })
      if (this.stopped) {
        void conn.close()
        return false
      }
      this.attach(conn)
      return true
    } catch (err) {
      this.setState('error')
      log('error', 'asr:connect-failed', { source: this.source, provider, err })
      return false
    }
  }

  push(pcm: Buffer, captureTimeMs: number): void {
    if (this.stopped || this.draining) return
    this.pending.push({ pcm, captureTimeMs, durationMs: (pcm.byteLength / 32_000) * 1000 })
    if (!this.replayTimer) this.drain()
  }

  updateKeywords(terms: string[]): void {
    this.conn?.updateKeywords(terms)
  }

  retryNow(): void {
    this.failures = 0
    // A connect that threw left no connection behind: start a fresh one.
    if (!this.conn && !this.connecting && !this.stopped && !this.draining) {
      void this.start()
      return
    }
    this.conn?.retryNow()
  }

  /**
   * A reconfigure: the audio this source has not had transcribed moves to
   * the next session, with its capture times. A live connection keeps what it already
   * sent and answers it during its drain; only the unsent audio moves. A connection that
   * is not transcribing (reconnecting, or a model still loading) gives up everything,
   * its unanswered audio included, and is closed at once, so it cannot transcribe the
   * same audio from its own queue. Its open partials go too: the next session
   * transcribes that audio again.
   */
  takeBacklog(): AudioEntry[] {
    if (this.replayTimer) clearTimeout(this.replayTimer)
    this.replayTimer = null
    const conn = this.conn
    if (conn && this.state !== 'active') {
      this.conn = null
      this.segments.clear()
      void conn.close(1_000).catch((err: unknown) => log('warn', 'asr:close-failed', { source: this.source, err }))
    }
    if (!this.conn && this.pending.requeueInflight()) this.retractPartials()
    return this.pending.take()
  }

  /** The previous session's backlog, ahead of anything this source already holds. */
  restoreBacklog(entries: readonly AudioEntry[]): void {
    if (!entries.length || this.stopped || this.draining) return
    this.pending.restore(entries)
    if (!this.replayTimer) this.drain()
  }

  /**
   * Graceful: send what is left, close the socket, wait for its last results. When
   * the socket is between reconnect attempts, it reconnects now and replays the
   * backlog first, within `budgetMs`. Only audio still unsent at the deadline is
   * dropped, and that is logged. The budget counts awake time only, so a
   * drain that a sleep cuts short finishes on resume.
   */
  stop(budgetMs: number): Promise<void> {
    if (!this.draining) {
      const budget = new AwakeBudget(budgetMs)
      this.draining = this.drainAndClose(budget).finally(() => budget.done())
    }
    return this.draining
  }

  private async drainAndClose(budget: AwakeBudget): Promise<void> {
    if (this.replayTimer) clearTimeout(this.replayTimer)
    this.replayTimer = null
    if (this.bridgeTimer) clearTimeout(this.bridgeTimer)
    this.bridgeTimer = null
    const sendLeft = (): number => budget.left() - STOP_CLOSE_RESERVE_MS
    // A failover may be connecting the next provider right now.
    if (this.connecting) await withAwakeTimeout(this.connecting, sendLeft())
    const conn = this.conn
    if (conn) await this.sendBacklog(conn, sendLeft)
    this.stopped = true
    if (conn) await this.closeConn(conn, budget)
    if (budget.sawFreeze()) await this.replayAfterSleep(conn?.providerId ?? this.provider, budget, sendLeft)
    const left = this.pending.unsent()
    if (left.entries) {
      log('warn', 'asr:stop-dropped', {
        source: this.source,
        sessionId: this.session.id,
        bytes: left.bytes,
        ms: Math.round(left.ms)
      })
    }
    this.pending.clear()
    this.setState('inactive')
  }

  private async closeConn(conn: AsrConnection, budget: AwakeBudget): Promise<void> {
    try {
      await conn.close(Math.max(1_000, budget.left()))
    } catch (err) {
      log('warn', 'asr:close-failed', { source: this.source, err })
    }
  }

  /**
   * The system slept during this stop. The connection may have died with
   * audio it never answered (a cloud CloseStream round trip rarely fits in the seconds
   * before the freeze). That audio is replayed through a fresh connection to the same
   * provider within what is left of the budget; the dead connection's partials are
   * retracted once the fresh one opens, and stay as final text if it never does.
   */
  private async replayAfterSleep(provider: AsrProviderId | null, budget: AwakeBudget, sendLeft: () => number): Promise<void> {
    if (!provider || sendLeft() <= 0) return
    this.pending.requeueInflight()
    if (!this.pending.size) return
    log('info', 'asr:stop-replay-after-sleep', {
      source: this.source,
      provider,
      pendingMs: Math.round(this.pending.pendingDurationMs)
    })
    this.retractOnOpen = true
    this.segments.clear()
    let conn: AsrConnection
    try {
      conn = await this.session.registry[provider].connect({
        source: this.source,
        language: this.session.language,
        keywords: this.session.keywords,
        sampleRate: 16000,
        sessionId: this.session.id
      })
    } catch (err) {
      log('warn', 'asr:stop-replay-failed', { source: this.source, provider, err })
      return
    }
    this.attach(conn)
    await this.sendBacklog(conn, sendLeft)
    await this.closeConn(conn, budget)
  }

  /** Sends the pending audio before the close, reconnecting first if the socket is down. */
  private async sendBacklog(conn: AsrConnection, left: () => number): Promise<void> {
    while (this.pending.size && this.conn === conn && left() > 0) {
      if (!conn.isOpen()) {
        // A refused key will not start working now.
        if (this.lastErrorKind === 'auth') return
        log('info', 'asr:stop-reconnect', {
          source: this.source,
          provider: conn.providerId,
          pendingMs: Math.round(this.pending.pendingDurationMs)
        })
        conn.retryNow()
        if (!(await waitForOpen(conn, left()))) return
        continue
      }
      // Pace a backlog for providers that want roughly real-time audio.
      const paced = conn.replayIntervalMs > 0 && this.pending.size > 2
      const e = this.pending.peek() as AudioEntry
      if (!conn.send(e.pcm, e.captureTimeMs)) return
      this.pending.markSent()
      if (paced) await sleep(conn.replayIntervalMs)
    }
  }

  private attach(conn: AsrConnection): void {
    this.conn = conn
    conn.on('open', () => {
      if (this.conn !== conn) return
      this.lastErrorKind = null
      if (this.retractOnOpen) {
        // The replay re-transcribes the dead socket's audio, so its partials go now.
        this.retractOnOpen = false
        this.retractPartials()
      }
      this.setState('active')
      log('info', 'asr:open', { source: this.source, provider: conn.providerId, sessionId: this.session.id })
      this.drain()
    })
    conn.on('reconnect', (info) => {
      log('info', 'asr:reconnected', { source: this.source, provider: conn.providerId, ...info })
      this.failures = 0
    })
    conn.on('close', ({ willReconnect }) => {
      if (this.conn !== conn) return
      if (this.replayTimer) clearTimeout(this.replayTimer)
      this.replayTimer = null
      // The final close of a stop keeps its partials: the session finalizes them.
      if (!willReconnect || this.stopped) return
      // Unacknowledged audio is replayed on the next socket, which re-transcribes it,
      // so this socket's open partials are retracted once that socket opens. Until
      // then they stay, and a stop that cannot reconnect keeps them as final text.
      const requeued = this.pending.requeueInflight()
      this.retractOnOpen = true
      this.segments.clear()
      if (this.state === 'active') this.setState('starting')
      log('info', 'asr:dropped', { source: this.source, provider: conn.providerId, requeued })
    })
    conn.on('error', (err) => this.onError(conn, err))
    conn.on('result', (r) => {
      if (this.conn === conn) this.onResult(conn, r)
    })
    // The local engine reports what it has transcribed; that audio needs no replay.
    conn.on('progress', ({ savedThroughEpochMs }) => {
      if (this.conn === conn) this.pending.acknowledge(savedThroughEpochMs)
    })
  }

  private onError(conn: AsrConnection, err: AsrError): void {
    if (this.conn !== conn || this.stopped) return
    this.failures++
    this.lastErrorKind = err.kind
    log(err.kind === 'parse' ? 'warn' : 'error', 'asr:connection-error', {
      source: this.source,
      provider: conn.providerId,
      kind: err.kind,
      message: err.message,
      status: err.status ?? 0,
      failures: this.failures
    })
    // A stop in progress keeps this provider: sendBacklog retries it until the deadline.
    if (err.kind === 'parse' || this.draining) return
    const now = err.kind === 'auth' || err.fatal === true
    if (now || this.failures >= FAILOVER_AFTER_FAILURES) {
      if (this.failover(conn, err)) return
      // Nowhere left to fail over to (budget spent, or no other provider).
      if (!this.exhaustedReported) {
        this.exhaustedReported = true
        this.session.failoverExhausted(this.source)
      }
    }
    // With nowhere to fail over, the socket keeps reconnecting on its own, so the source
    // stays "starting" (shown as reconnecting) and shows error only for a refused key
    // or a local engine that cannot start.
    if (now) this.setState('error')
    else if (this.state === 'active') this.setState('starting')
  }

  /**
   * Moves this source to another configured provider, within the budget. The target is
   * language-aware; the reasons go to the log only.
   */
  private failover(conn: AsrConnection, err: AsrError): boolean {
    const from = conn.providerId
    const used = this.failovers.get(from) ?? 0
    if (used >= FAILOVER_BUDGET[from]) return false
    // Local failing to start while it bridges a cloud source ends bridging here.
    if (from === 'local' && err.fatal && this.bridgeReturn) this.bridgeDisabled = true
    const pick = pickFallback({
      language: this.session.language,
      failed: from,
      candidates: this.session.chain.filter((p) => p !== from && !(p === 'local' && this.bridgeDisabled)),
      evidence: this.session.evidence,
      models: this.session.multiModels,
      localCovers
    })
    log('info', 'asr:fallback', {
      source: this.source,
      from,
      to: pick.target ?? '',
      reason: pick.reason,
      required: pick.required.join(',')
    })
    if (!pick.target) return false
    this.failovers.set(from, used + 1)
    log('warn', 'asr:failover', { source: this.source, from, to: pick.target, used: used + 1 })
    const bridging = this.bridgeReturn !== null
    this.switchTo(conn, pick.target)
    if (pick.target === 'local' && from !== 'local') this.armBridge(from)
    else if (from === 'local' && bridging) this.clearBridge()
    return true
  }

  private switchTo(conn: AsrConnection, target: AsrProviderId): void {
    this.conn = null
    this.pending.requeueInflight()
    this.retractOnOpen = true
    this.segments.clear()
    void conn.close()
    this.providerIdx = Math.max(0, this.session.chain.indexOf(target))
    this.failures = 0
    void this.start()
  }

  /** Local transcribes a failed cloud source for the backoff, then the cloud is retried. */
  private armBridge(returnTo: AsrProviderId): void {
    this.clearBridge()
    this.bridgeReturn = returnTo
    const ms = this.bridgeBackoffMs + Math.random() * BRIDGE_JITTER_MS
    this.bridgeBackoffMs = Math.min(this.bridgeBackoffMs * 2, BRIDGE_MAX_MS)
    log('info', 'asr:bridge-start', { source: this.source, returnTo, ms: Math.round(ms) })
    this.bridgeTimer = setTimeout(() => this.endBridge(), ms)
  }

  private endBridge(): void {
    this.bridgeTimer = null
    const to = this.bridgeReturn
    this.bridgeReturn = null
    const conn = this.conn
    if (!to || !conn || conn.providerId !== 'local' || this.stopped || this.draining) return
    log('info', 'asr:bridge-end', { source: this.source, to })
    this.switchTo(conn, to)
  }

  private clearBridge(): void {
    if (this.bridgeTimer) clearTimeout(this.bridgeTimer)
    this.bridgeTimer = null
    this.bridgeReturn = null
  }

  private drain(): void {
    const conn = this.conn
    // During a stop, sendBacklog owns the sending.
    if (!conn || !conn.isOpen() || this.replayTimer || this.draining) return
    const interval = conn.replayIntervalMs
    if (interval > 0 && this.pending.size > 2) {
      // Pace a backlog for providers that want roughly real-time audio.
      const step = (): void => {
        this.replayTimer = null
        if (this.conn !== conn || !conn.isOpen()) return
        const e = this.pending.peek()
        if (!e) return
        if (!conn.send(e.pcm, e.captureTimeMs)) return
        this.pending.markSent()
        if (this.pending.size) this.replayTimer = setTimeout(step, interval)
      }
      step()
      return
    }
    this.drainAll()
  }

  private drainAll(): void {
    const conn = this.conn
    if (!conn) return
    for (let e = this.pending.peek(); e; e = this.pending.peek()) {
      if (!conn.send(e.pcm, e.captureTimeMs)) return
      this.pending.markSent()
    }
  }

  private retractPartials(): void {
    const partials = this.session.store.partials(this.session.noteId, this.session.id, this.source)
    if (partials.length) this.session.store.retract(this.session.noteId, partials.map((c) => c.id))
  }

  /** Provider result → chunk, merged into the store. */
  private onResult(conn: AsrConnection, r: AsrResult): void {
    if (r.isFinal) {
      this.pending.acknowledge(r.baseEpochMs + r.endMs)
      this.session.noteEvidence(r)
    }
    const empty = !r.text.trim()
    let id = this.segments.get(r.segmentKey)
    if (r.isFinal) this.segments.delete(r.segmentKey)
    if (empty) {
      // An empty interim is ignored; an empty final finalizes the open partial.
      if (r.isFinal && id) this.session.store.finalize(this.session.noteId, id)
      return
    }
    if (!id) {
      id = randomUUID()
      if (!r.isFinal) this.segments.set(r.segmentKey, id)
    }
    const startUnix = r.baseEpochMs + r.startMs
    const endUnix = r.baseEpochMs + r.endMs
    // Word details stay on chunks while diarization is on (word-level turns and the pass
    // need them; otherwise chunks carry no word details), and on system chunks
    // while attribution is active.
    const attribution = this.source === 'system' && this.session.attribution?.active() === true
    const keepWords = (this.session.diarization || attribution) && r.words.length > 0
    let chunk: TranscriptChunk = {
      id,
      document_id: this.session.noteId,
      workspace_id: this.session.identity.workspaceId,
      owner_id: this.session.identity.ownerId,
      transcription_session_id: this.session.id,
      source: this.source,
      start_timestamp: new Date(startUnix).toISOString(),
      end_timestamp: new Date(endUnix).toISOString(),
      text: r.text,
      is_final: r.isFinal,
      detected_speaker_name: null,
      detectedSpeaker: null,
      ...(keepWords
        ? {
            providerDetails: {
              words: r.words.map(providerWord),
              provider: conn.providerId,
              model: conn.model,
              wallClockAnchorMs: r.baseEpochMs,
              ...(r.turnEndScore !== undefined ? { turnEndScore: r.turnEndScore } : {})
            }
          }
        : {})
    }
    // Only a final system chunk gets a speaker; partials never do.
    if (attribution && r.isFinal) chunk = this.session.attribution?.stamp(chunk) ?? chunk
    this.sanityCheck(chunk, startUnix, endUnix, conn.providerId)
    this.session.store.upsert(chunk)
  }

  private sanityCheck(chunk: TranscriptChunk, startUnix: number, endUnix: number, provider: AsrProviderId): void {
    const problems: string[] = []
    if (endUnix < startUnix) problems.push('end-before-start')
    if (startUnix > Date.now() + FUTURE_TOLERANCE_MS) problems.push('start-in-future')
    if (this.lastStartIso && chunk.start_timestamp < this.lastStartIso) problems.push('out-of-order')
    if (chunk.start_timestamp > this.lastStartIso) this.lastStartIso = chunk.start_timestamp
    if (problems.length && Date.now() - this.sanityLogAt >= SANITY_LOG_EVERY_MS) {
      this.sanityLogAt = Date.now()
      log('warn', 'asr:timestamp-sanity', { source: this.source, provider, problems: problems.join(',') })
    }
  }

  private setState(s: SourceState): void {
    if (this.state === s) return
    this.state = s
    this.session.onSourceState(this.source, s)
  }
}

function providerWord(w: AsrResult['words'][number]): ProviderWord {
  return {
    w: w.w,
    s_ms: w.s_ms,
    e_ms: w.e_ms,
    conf: w.conf,
    ...(w.spk !== undefined ? { spk: w.spk } : {}),
    ...(w.lang !== undefined ? { lang: w.lang } : {}),
    ...(w.spk_conf !== undefined ? { spk_conf: w.spk_conf } : {}),
    ...(w.lang_conf !== undefined ? { lang_conf: w.lang_conf } : {})
  }
}

export class TranscriptionSession {
  readonly id = randomUUID()
  readonly startedAt: IsoTime = new Date().toISOString()
  readonly noteId: string
  readonly language: string
  keywords: string[]
  readonly chain: AsrProviderId[]
  readonly identity: StorageIdentity
  readonly diarization: boolean
  readonly multiModels: SessionOptions['multiModels']
  /** Final words heard per base language code. */
  readonly evidence = new Map<string, number>()
  private readonly recorder: AudioRecorder | null
  /** The kept-audio tee, while "Keep meeting audio" was on at start. */
  private readonly keeper: SessionRecorder | null
  readonly attribution: SystemAttribution | null
  private readonly onExhausted: SessionOptions['onFailoverExhausted']
  state: SessionState = 'starting'
  private readonly streams: Record<AudioSource, SourceStream>
  private stopping: Promise<void> | null = null
  private readonly notifySource: SessionOptions['onSourceState']
  /** The sources this session transcribes (both, unless a system-only capture). */
  readonly sources: readonly AudioSource[]

  constructor(
    opts: SessionOptions,
    readonly registry: AsrRegistry,
    readonly store: ChunkStore
  ) {
    this.noteId = opts.noteId
    this.language = opts.language
    this.keywords = opts.keywords
    this.chain = opts.chain
    this.identity = opts.identity
    this.notifySource = opts.onSourceState
    this.diarization = opts.diarization
    this.recorder = opts.recorderFor?.(this.id) ?? null
    this.keeper = opts.keepAudioFor?.(this.id) ?? null
    this.attribution = opts.attribution
    this.onExhausted = opts.onFailoverExhausted
    this.multiModels = opts.multiModels
    const asked = SOURCES.filter((s) => opts.sources?.includes(s))
    this.sources = asked.length > 0 ? asked : SOURCES
    this.streams = {
      microphone: new SourceStream(this, 'microphone'),
      system: new SourceStream(this, 'system')
    }
  }

  get primaryProvider(): AsrProviderId | null {
    return this.chain[0] ?? null
  }

  onSourceState(source: AudioSource, state: SourceState): void {
    if (this.state === 'stopped') return
    this.notifySource(source, state)
  }

  /** Connects its sources in parallel; fails only if all fail. */
  async start(): Promise<void> {
    const results = await Promise.all(this.sources.map((s) => this.streams[s].start()))
    if (this.state !== 'starting') return
    const ok = results.filter(Boolean).length
    if (ok === 0) log('error', 'asr:session-start-failed', { sessionId: this.id })
    else if (ok < this.sources.length) log('warn', 'asr:session-partial-start', { sessionId: this.id })
    this.state = 'running'
  }

  /** Audio arrives only while the session is starting or running. */
  feed(source: AudioSource, pcm: Buffer, captureTimeMs: number): void {
    if (this.state !== 'starting' && this.state !== 'running') return
    // A source this session doesn't transcribe has no stream to feed.
    if (!this.sources.includes(source)) return
    this.recorder?.write(source, pcm, captureTimeMs)
    // The kept recording gets exactly the batches that go to ASR.
    this.keeper?.append(source, pcm)
    this.streams[source].push(pcm, captureTimeMs)
  }

  /** A source has no provider left to fail over to (reported once per source). */
  failoverExhausted(source: AudioSource): void {
    this.onExhausted?.(source, [...this.chain])
  }

  /** Finalizes the session's kept recordings, once the session has stopped. */
  closeKeptAudio(): Promise<void> {
    return this.keeper ? this.keeper.close() : Promise.resolve()
  }

  /** Counts a final result's words per base language code. */
  noteEvidence(r: AsrResult): void {
    for (const w of r.words) {
      const tag = w.lang ?? r.language
      if (!tag) continue
      const code = baseCode(tag)
      if (code) this.evidence.set(code, (this.evidence.get(code) ?? 0) + 1)
    }
  }

  /** The teed audio, once the session has stopped. */
  closeRecorder(): Promise<RecordedFile[]> {
    return this.recorder ? this.recorder.close() : Promise.resolve([])
  }

  updateKeywords(terms: string[]): void {
    this.keywords = terms
    for (const s of this.sources) this.streams[s].updateKeywords(terms)
  }

  retryNow(): void {
    for (const s of this.sources) this.streams[s].retryNow()
  }

  /** Reconfigure: each source's untranscribed audio, for the next session. */
  takeBacklog(): Record<AudioSource, AudioEntry[]> {
    return { microphone: this.streams.microphone.takeBacklog(), system: this.streams.system.takeBacklog() }
  }

  restoreBacklog(backlog: Record<AudioSource, AudioEntry[]>): void {
    for (const s of this.sources) this.streams[s].restoreBacklog(backlog[s])
  }

  /** Drains its sources within `budgetMs`, finalizes what is left and flushes the store. */
  stop(budgetMs = DRAIN_TIMEOUT_MS): Promise<void> {
    if (this.stopping) return this.stopping
    this.state = 'stopping'
    this.stopping = (async () => {
      const drained = Promise.all(this.sources.map((s) => this.streams[s].stop(budgetMs)))
      await withAwakeTimeout(drained, budgetMs + 500)
      // Partials left after the last results are kept as final text.
      for (const s of this.sources) {
        for (const c of this.store.partials(this.noteId, this.id, s)) this.store.finalize(this.noteId, c.id)
      }
      const ok = await this.store.flush(this.noteId)
      if (!ok) log('warn', 'asr:final-flush-incomplete', { sessionId: this.id })
      this.state = 'stopped'
    })()
    return this.stopping
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** True once the connection is open, false after `ms` of awake time. */
function waitForOpen(conn: AsrConnection, ms: number): Promise<boolean> {
  if (conn.isOpen()) return Promise.resolve(true)
  if (ms <= 0) return Promise.resolve(false)
  return new Promise((resolve) => {
    const onOpen = (): void => {
      cancel()
      resolve(true)
    }
    const cancel = awakeTimer(ms, () => {
      conn.off('open', onOpen)
      resolve(false)
    })
    conn.once('open', onOpen)
  })
}
