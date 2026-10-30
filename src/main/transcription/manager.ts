// SPDX-License-Identifier: Apache-2.0
// The transcription manager: one per app, shared by capture (which starts, feeds
// and stops sessions through `transcriptionControl(ctx)`, api.ts) and by
// the transcription IPC handlers.
//
// `reconfigure` restarts a note's session in place on a language or
// provider change, and `restartSession` does the same swap unchanged (inactivity recovery);
// a local session whose model is
// missing downloads it first; with diarization
// on, sessions tee their audio and the note gets one diarization pass when its
// capture stops. A note that captures both sources runs its mic through the echo gate
// (echo-gate.ts) before the session, so ASR and the tee never hear the remote voices
// twice; the gate outlives a swap.

import type { PushChannel } from '@shared/ipc'
import type { AudioSource, IsoTime } from '@shared/types/common'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types/settings'
import type { AsrProviderId, TranscriptChunk, TranscriptionSessionInfo } from '@shared/types/transcript'
import { DiarizationService } from '../asr/diarize'
import { getLocalModels } from '../asr/instance'
import type { LocalModelManager } from '../asr/models'
import type { MainContext } from '../context'
import { log } from '../log'
import { getRecordings, type RecordingsService } from '../recordings/service'
import { getAttribution } from '../speakers/attribution'
import type { StorageIdentity } from '../storage/api'
import type { SourceStateListener, StartOptions } from './api'
import { ChunkStore } from './chunks'
import { EchoGate } from './echo-gate'
import { cleanKeywords } from './keywords'
import { assemblyMultiModel, deepgramMultiModel } from './languages'
import { LOCAL_ASR_MODEL, localCovers } from './providers/local'
import { createAsrRegistry, providerChain, type AsrRegistry } from './providers/registry'
import { DRAIN_TIMEOUT_MS, TranscriptionSession, type SystemAttribution } from './session'

// Declared in api.ts; re-exported for the older importers.
export type { SourceStateListener, StartOptions } from './api'

const AWAIT_STOPPED_CAP_MS = 30_000
/** At quit, capture's whole stop is capped at 10 s; the drain gets most of it. */
const SHUTDOWN_DRAIN_MS = 8_000
/** The end reason of a session restarted in place. */
export const CONFIG_CHANGED = 'config_changed'
/** The end reason of a session restarted by inactivity recovery: a swap, like `config_changed`. */
export const INACTIVITY_RECOVERY = 'inactivity_recovery'

/** End reasons of a swap: the note keeps capturing, so its capture did not stop. */
const SWAPS: ReadonlySet<string> = new Set([CONFIG_CHANGED, INACTIVITY_RECOVERY])

/**
 * The language a session actually uses: on-device
 * transcription whose model does not cover `multi` transcribes English.
 */
export function effectiveLanguage(asr: AsrProviderId, language: string): string {
  return asr === 'local' && !localCovers(language) ? 'en' : language
}

export class TranscriptionManager {
  readonly registry: AsrRegistry
  readonly store: ChunkStore
  readonly models: LocalModelManager
  readonly diarizer: DiarizationService
  /** Kept meeting audio and speaker attribution. */
  readonly recordings: RecordingsService
  readonly attribution: SystemAttribution
  /** `${noteId}:${source}` pairs whose failover exhaustion was reported (once each). */
  private readonly exhausted = new Set<string>()
  /** The running session per note (at most one note at a time in practice). */
  private readonly active = new Map<string, TranscriptionSession>()
  /** What capture asked for, per running note: `reconfigure` compares against it. */
  private readonly requested = new Map<string, { asr: AsrProviderId; language: string }>()
  /** Sessions draining after a stop, per note. */
  private readonly stopping = new Map<string, Set<Promise<void>>>()
  /**
   * Whole stops per note, up to the diarization pass being queued: the
   * drain settles before the session row, the tee and `noteStopped` are done.
   */
  private readonly stops = new Map<string, Set<Promise<unknown>>>()
  private sourceListener: SourceStateListener = () => undefined
  private identity: StorageIdentity | null = null
  /** The mic's echo gate per note capturing both sources. */
  private readonly echoGates = new Map<string, EchoGate>()
  /** Sessions whose boot threw; the user's Retry boots them again. */
  private readonly bootFailed = new Map<TranscriptionSession, StartOptions>()
  /** `start` is synchronous, so the settings it needs are mirrored here. */
  private settings: Settings = structuredClone(DEFAULT_SETTINGS)

  constructor(private readonly ctx: MainContext) {
    this.models = getLocalModels(ctx)
    this.registry = createAsrRegistry({ secrets: ctx.secrets, settings: ctx.settings, models: this.models })
    this.store = new ChunkStore(ctx)
    this.recordings = getRecordings(ctx)
    this.attribution = getAttribution(ctx)
    // The pass's chunk write goes through the note's label-write queue, from the job
    // (`speakers/job.ts` sets it on the service).
    this.diarizer = new DiarizationService({ userDataPath: ctx.userDataPath, models: this.models })
    // Start fresh creates a new workspace and owner: never stamp chunks with old ones.
    ctx.bus.on('storage:status', (s) => {
      this.identity = null
      if (s.state === 'ready') void this.loadSettings()
    })
    ctx.bus.on('settings:changed', ({ settings }) => {
      this.settings = settings
    })
    // A local source that gave up waiting for its model (120 s) starts once
    // the download finishes, so the meeting still gets its transcript.
    this.models.onState((s) => {
      if (s.modelId !== LOCAL_ASR_MODEL || s.state !== 'ready') return
      for (const session of this.active.values()) if (session.chain.includes('local')) session.retryNow()
    })
    void this.loadSettings()
  }

  private async loadSettings(): Promise<void> {
    try {
      this.settings = await this.ctx.settings.getAll()
    } catch (err) {
      log('warn', 'asr:settings-unavailable', { err })
    }
  }

  onSourceState(listener: SourceStateListener): void {
    this.sourceListener = listener
  }

  /** Starts the note's session; the sockets connect in the background. */
  start(opts: StartOptions): { sessionId: string; startedAt: IsoTime } {
    const existing = this.active.get(opts.noteId)
    if (existing) return { sessionId: existing.id, startedAt: existing.startedAt }
    const language = effectiveLanguage(opts.asr, opts.language)
    if (language !== opts.language) {
      log('info', 'asr:language-forced', { noteId: opts.noteId, asr: opts.asr, requested: opts.language, language })
    }
    const keywords = cleanKeywords(opts.keywords)
    const diarization = this.settings['transcription.diarization']
    // No raw audio on disk for a pass that cannot run: the tee needs the speaker model
    // installed. Chunks still keep their words, for a later pass on a resumed note.
    const tee = diarization && this.models.isReady('diarization-en')
    if (diarization && !tee) log('info', 'asr:diarize-tee-skipped', { noteId: opts.noteId, reason: 'model-missing' })
    const keepAudio = this.settings['audio.keepRecordings'] === true
    const session: TranscriptionSession = new TranscriptionSession(
      {
        noteId: opts.noteId,
        language,
        keywords,
        chain: [],
        identity: { workspaceId: '', ownerId: '' },
        onSourceState: (source, state) => {
          if (this.active.get(opts.noteId) === session) this.sourceListener(opts.noteId, source, state)
        },
        diarization,
        recorderFor: tee ? (sessionId) => this.diarizer.recorder(opts.noteId, sessionId) : null,
        multiModels: {
          deepgram: deepgramMultiModel(this.settings['asr.deepgram.multilingualVersion']),
          assemblyai: assemblyMultiModel(this.settings['asr.assemblyai.multilingualModel'])
        },
        // Kept audio while the setting is on at the session's start.
        keepAudioFor: (sessionId) => this.recordings.recorderFor(opts.noteId, sessionId, keepAudio),
        attribution: this.attribution,
        // Absent = both (every meeting); a system-only capture never connects a microphone.
        ...(opts.sources ? { sources: opts.sources } : {}),
        onFailoverExhausted: (source, providers) => {
          const key = `${opts.noteId}:${source}`
          if (this.exhausted.has(key)) return
          this.exhausted.add(key)
          log('warn', 'asr:failover-exhausted', { noteId: opts.noteId, source, providers: providers.join(',') })
          this.ctx.bus.emit('transcription:failover-exhausted', { noteId: opts.noteId, source, providers })
        }
      },
      this.registry,
      this.store
    )
    this.active.set(opts.noteId, session)
    this.requested.set(opts.noteId, { asr: opts.asr, language: opts.language })
    if (session.sources.length === 2 && !this.echoGates.has(opts.noteId)) {
      this.echoGates.set(opts.noteId, new EchoGate((pcm, captureTimeMs) => this.active.get(opts.noteId)?.feed('microphone', pcm, captureTimeMs)))
    }
    this.launch(session, { ...opts, language })
    return { sessionId: session.id, startedAt: session.startedAt }
  }

  /** Boots in the background; a throw marks both sources as error, so Retry shows. */
  private launch(session: TranscriptionSession, opts: StartOptions): void {
    this.bootFailed.delete(session)
    this.boot(session, opts, session.keywords).catch((err: unknown) => {
      log('error', 'asr:session-boot-failed', { sessionId: session.id, err })
      if (session.state !== 'starting') return
      this.bootFailed.set(session, opts)
      for (const s of session.sources) session.onSourceState(s, 'error')
    })
  }

  private async boot(session: TranscriptionSession, opts: StartOptions, keywords: string[]): Promise<void> {
    const ids = await this.getIdentity()
    Object.assign(session.identity, ids)
    // The user-context name dictionary joins the session keywords, de-duplicated, within the
    // 100-term cap.
    const vocabulary = await this.ctx.promptExtras.asrVocabulary().catch(() => [] as string[])
    if (vocabulary.length) {
      keywords = cleanKeywords([...keywords, ...vocabulary])
      session.keywords = keywords
    }
    const { chain, primaryUnavailable } = await providerChain(this.registry, opts.asr, opts.language)
    if (opts.asr === 'local' && primaryUnavailable === 'not-installed') {
      // The meeting waits for the model, which downloads now. The audio
      // waits in the pending buffer, then in the local pre-ready queue.
      chain.unshift('local')
      log('info', 'asr:local-model-download-for-meeting', { sessionId: session.id })
      void this.models.download(LOCAL_ASR_MODEL).catch((err: unknown) => log('warn', 'asr:local-download-start-failed', { err }))
    } else if (primaryUnavailable) {
      log('warn', 'asr:primary-unavailable', { provider: opts.asr, reason: primaryUnavailable })
    }
    session.chain.splice(0, session.chain.length, ...chain)
    if (session.state !== 'starting') return
    const provider = session.primaryProvider ?? opts.asr
    const model = await this.registry[provider].model(opts.language).catch(() => '')
    log('info', 'asr:session-start', {
      sessionId: session.id,
      noteId: opts.noteId,
      provider,
      chain: chain.join(','),
      model,
      language: opts.language,
      keywords: keywords.length,
      diarization: session.diarization
    })
    this.pushSessionInfo({
      noteId: opts.noteId,
      sessionId: session.id,
      provider,
      model,
      language: opts.language
    })
    try {
      await this.ctx.storage.createSession({
        id: session.id,
        document_id: opts.noteId,
        provider,
        model,
        language: opts.language,
        started_at: session.startedAt
      })
    } catch (err) {
      log('warn', 'asr:session-row-failed', { sessionId: session.id, err })
    }
    // A stop may have come while the row was written.
    if (session.state !== 'starting') return
    await session.start()
  }

  private async getIdentity(): Promise<StorageIdentity> {
    if (this.identity) return this.identity
    try {
      this.identity = await this.ctx.storage.identity()
      return this.identity
    } catch (err) {
      log('warn', 'asr:identity-unavailable', { err })
      return { workspaceId: '', ownerId: '' }
    }
  }

  feed(noteId: string, source: AudioSource, pcm: Buffer, captureTimeMs: number): void {
    const gate = this.echoGates.get(noteId)
    if (gate && source === 'microphone') return gate.mic(pcm, captureTimeMs)
    this.active.get(noteId)?.feed(source, pcm, captureTimeMs)
    // After the session has the system audio: the gate may release mic audio it held for it.
    if (gate) gate.system(pcm, captureTimeMs)
  }

  updateKeywords(noteId: string, keywords: string[]): void {
    this.active.get(noteId)?.updateKeywords(cleanKeywords(keywords))
  }

  retryNow(noteId: string): void {
    const session = this.active.get(noteId)
    if (!session) return
    const failed = this.bootFailed.get(session)
    if (failed) this.launch(session, failed)
    else session.retryNow()
  }

  isActive(noteId: string): boolean {
    return this.active.has(noteId)
  }

  /**
   * A language or provider change restarts the note's session in place.
   * The new session starts first, so capture's audio keeps flowing into it, and the
   * old one drains and ends with `config_changed`. Capture itself is untouched. A
   * keywords-only change is applied to the running session.
   */
  async reconfigure(
    noteId: string,
    opts: { language: string; asr: AsrProviderId; keywords: string[] }
  ): Promise<void> {
    const old = this.active.get(noteId)
    if (!old) return
    const req = this.requested.get(noteId)
    const language = effectiveLanguage(opts.asr, opts.language)
    if (req && req.asr === opts.asr && old.language === language) {
      this.updateKeywords(noteId, opts.keywords)
      return
    }
    const kind = req?.asr !== opts.asr ? 'provider_change' : 'language_change'
    log('info', 'asr:reconfigure', {
      noteId,
      kind,
      from: `${req?.asr ?? '?'}/${old.language}`,
      to: `${opts.asr}/${language}`,
      oldSessionId: old.id
    })
    await this.swap(noteId, old, opts, CONFIG_CHANGED)
  }

  /**
   * Inactivity recovery: the same swap as `reconfigure`, with the session's current
   * language, provider, keywords and sources, run even though nothing changed. The old
   * session ends with `inactivity_recovery`. Resolves once the new session has started,
   * so capture can restart its audio while the old one drains (a stalled socket can take
   * the whole drain timeout). False when the note has no running session.
   */
  async restartSession(noteId: string): Promise<boolean> {
    const old = this.active.get(noteId)
    const req = this.requested.get(noteId)
    if (!old || !req) return false
    log('info', 'asr:restart', { noteId, kind: INACTIVITY_RECOVERY, oldSessionId: old.id })
    void this.swap(noteId, old, { language: req.language, asr: req.asr, keywords: old.keywords }, INACTIVITY_RECOVERY).catch((err: unknown) =>
      log('warn', 'asr:restart-drain-failed', { noteId, err })
    )
    return true
  }

  /**
   * The new session starts first, so capture's audio keeps flowing into it; the old one's
   * untranscribed audio moves over, then it drains and ends with `reason`. The swap itself
   * is synchronous; the returned promise is the old session's drain.
   */
  private swap(
    noteId: string,
    old: TranscriptionSession,
    opts: { language: string; asr: AsrProviderId; keywords: string[] },
    reason: string
  ): Promise<void> {
    this.active.delete(noteId)
    this.bootFailed.delete(old)
    // The new session transcribes the same sources as the old one.
    this.start({ noteId, language: opts.language, keywords: opts.keywords, asr: opts.asr, sources: old.sources })
    // The old session's untranscribed audio (the minutes buffered while offline, or
    // what waits for a model) moves to the new one instead of being dropped.
    const backlog = old.takeBacklog()
    const moved = backlog.microphone.length + backlog.system.length
    if (moved) {
      const ms = [...backlog.microphone, ...backlog.system].reduce((n, e) => n + e.durationMs, 0)
      log('info', 'asr:reconfigure-backlog-moved', { noteId, entries: moved, ms: Math.round(ms) })
      this.active.get(noteId)?.restoreBacklog(backlog)
    }
    return this.retire(noteId, old, reason)
  }

  /** Drains and flushes. Resolves with the stopped session, or null if none ran. */
  stop(noteId: string, reason: string): Promise<{ sessionId: string; startedAt: IsoTime } | null> {
    const session = this.active.get(noteId)
    if (!session) return Promise.resolve(null)
    // The mic audio the gate still holds (at most 300 ms) goes to the session before its drain.
    const gate = this.echoGates.get(noteId)
    if (gate) {
      gate.flush()
      this.echoGates.delete(noteId)
      log('info', 'asr:echo-gate', { noteId, ...gate.stats })
    }
    this.active.delete(noteId)
    this.requested.delete(noteId)
    this.bootFailed.delete(session)
    if (!this.active.size) this.pushSessionInfo(null)
    const done = (async () => {
      await this.retire(noteId, session, reason)
      // The note's capture stopped: one diarization pass over all of its audio.
      if (!SWAPS.has(reason) && !this.active.has(noteId)) this.diarizer.noteStopped(noteId)
      return { sessionId: session.id, startedAt: session.startedAt }
    })()
    let set = this.stops.get(noteId)
    if (!set) {
      set = new Set()
      this.stops.set(noteId, set)
    }
    set.add(done)
    void done
      .catch(() => undefined)
      .finally(() => {
        set.delete(done)
        if (!set.size && this.stops.get(noteId) === set) this.stops.delete(noteId)
      })
    return done
  }

  /** Resolves once every stop of the note has finished, its diarization pass queued. */
  async awaitStops(noteId: string): Promise<void> {
    await Promise.allSettled([...(this.stops.get(noteId) ?? [])])
  }

  private async retire(noteId: string, session: TranscriptionSession, reason: string): Promise<void> {
    const shutdown = reason === 'app_shutdown' || reason === 'window_closed'
    const done = session.stop(shutdown ? SHUTDOWN_DRAIN_MS : DRAIN_TIMEOUT_MS)
    let set = this.stopping.get(noteId)
    if (!set) {
      set = new Set()
      this.stopping.set(noteId, set)
    }
    set.add(done)
    try {
      await done
    } finally {
      set.delete(done)
      if (!set.size) this.stopping.delete(noteId)
    }
    const endedAt = new Date().toISOString()
    try {
      await this.ctx.storage.endSession(session.id, endedAt, reason)
    } catch (err) {
      log('warn', 'asr:session-end-row-failed', { sessionId: session.id, err })
    }
    try {
      this.diarizer.sessionClosed(noteId, await session.closeRecorder())
    } catch (err) {
      log('warn', 'asr:diarize-tee-close-failed', { sessionId: session.id, err })
    }
    // The session's kept recordings are finalized with its stop (the drain is done).
    await session.closeKeptAudio().catch((err: unknown) => log('warn', 'recordings:session-close-failed', { sessionId: session.id, err }))
    log('info', 'asr:session-stopped', { sessionId: session.id, noteId, reason })
    if (!this.active.has(noteId)) this.store.release(noteId)
  }

  /** `capture:await-session-stopped`: waits for the note's session, at most 30 s. */
  async awaitStopped(noteId: string): Promise<{ waited: boolean; timedOut: boolean }> {
    const running = this.active.get(noteId)
    const draining = [...(this.stopping.get(noteId) ?? [])]
    if (!running && !draining.length) return { waited: false, timedOut: false }
    const target = (async () => {
      await Promise.all(draining)
      // A running session counts as stopped once its stop completes.
      while (this.active.get(noteId) === running && running) {
        await new Promise((r) => setTimeout(r, 100))
      }
      await Promise.all([...(this.stopping.get(noteId) ?? [])])
    })()
    let timedOut = false
    await Promise.race([
      target,
      new Promise<void>((r) =>
        setTimeout(() => {
          timedOut = true
          r()
        }, AWAIT_STOPPED_CAP_MS)
      )
    ])
    return { waited: true, timedOut }
  }

  async flush(noteId: string): Promise<void> {
    await this.store.flush(noteId)
  }

  liveChunks(noteId: string): TranscriptChunk[] {
    return this.store.liveChunks(noteId)
  }

  getTranscript(noteId: string): Promise<TranscriptChunk[]> {
    return this.store.getTranscript(noteId)
  }

  private pushSessionInfo(info: TranscriptionSessionInfo | null): void {
    for (const wc of this.ctx.windows.targets()) wc.send('transcription:session-state' satisfies PushChannel, info)
  }
}

let manager: TranscriptionManager | null = null

/** The app-wide manager; created by whichever register function runs first. */
export function getTranscriptionManager(ctx: MainContext): TranscriptionManager {
  if (!manager) manager = new TranscriptionManager(ctx)
  return manager
}
