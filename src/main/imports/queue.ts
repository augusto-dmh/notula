// SPDX-License-Identifier: Apache-2.0
// The recording import queue.
//
// - Paths only: main validates each path again (an existing file, ≤ 500 MB, not empty, .mp3/.m4a/
//   .aac/.wav) and reads the file itself; the renderer never sends bytes.
// - At most 5 in progress; jobs persist in `audio_imports` and run one at a time, so a CPU-bound
//   local engine is never shared.
// - Per job: `creating` (a note titled with the file name, `transcribe` false, entry origin
//   `audio-import`, stored creation source = the platform) → `reading` → `transcribing`
//   → `summarizing` (`ctx.enhance.autoGenerate`) → `complete`, or `failed` with its message.
// - Engine: the user's `asr.provider`. Cloud sends the original file; local decodes it in the media
//   worker. A codec WebCodecs lacks goes to the cloud when a cloud key exists. Local-only mode
//   allows only the local engine.
// - Restart: an unfinished job is re-queued once if its file still exists with the same size;
//   otherwise it fails with "Import interrupted. Add the file again to retry."

import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import { basename, extname, isAbsolute } from 'node:path'
import type { PushChannel } from '@shared/ipc'
import type { CreationSource } from '@shared/types/notes'
import { IMPORT_LIMITS, type ImportEngine, type ImportJob, type ImportPhase } from '@shared/types/recordings'
import { DELETED_CHUNK_MARKER, type CloudAsrProviderId, type TranscriptChunk } from '@shared/types/transcript'
import type { MainContext } from '../context'
import { log } from '../log'
import { egressBlocked } from '../privacy'
import { getSpeakerNames } from '../speakers/names'
import type { ImportJobRow } from '../storage/api'
import { effectiveLanguage, type TranscriptionManager } from '../transcription/manager'
import { LOCAL_ASR_MODEL, pickLocalModel } from '../transcription/providers/local'
import { ImportFailure, transcribeInCloud } from './cloud'
import { transcribeLocally } from './local'
import { MediaDecodeError, type MediaHost } from './media'
import type { MediaFormat } from './media-protocol'

export const COPY = {
  empty: 'The file is empty.',
  large: `File is over ${IMPORT_LIMITS.maxBytes / 1_048_576} MB. Trim or split it.`,
  type: 'Only MP3, M4A, AAC or WAV files are supported.',
  unreadable: 'The file could not be read.',
  limit: 'Too many imports at once. Wait for some to finish.',
  interrupted: 'Import interrupted. Add the file again to retry.',
  transcribe: 'Notula couldn’t transcribe this file. Try again.',
  read: 'Notula could not read this audio file.',
  summary: 'Transcribed, but enhanced notes failed. Retry from the note.',
  localOnly: 'Local-only mode is on. Choose on-device transcription to import recordings.',
  failed: 'Couldn’t process the audio. Check that the file plays, then import it again.',
  noEngine: 'Set up transcription in Settings ▸ AI to import recordings.'
} as const

/** An internal marker in `error` while a job runs again after a restart (never shown). */
const REQUEUED = '__requeued__'
const REQUEUED_SUMMARY = '__requeued__:summarizing'
const ACTIVE: readonly ImportPhase[] = ['queued', 'creating', 'reading', 'transcribing', 'summarizing']
const MAX_PATHS = 50

const FORMATS: Record<string, MediaFormat> = { '.mp3': 'mp3', '.m4a': 'm4a', '.aac': 'aac', '.wav': 'wav' }

function creationSource(): CreationSource {
  switch (process.platform) {
    case 'darwin':
      return 'macOS'
    case 'win32':
      return 'Windows'
    case 'linux':
      return 'desktop'
    default:
      return 'unknown'
  }
}

/** The job as the renderer sees it: no source path, no internal markers. */
export function publicJob(j: ImportJob | ImportJobRow): ImportJob {
  return {
    id: j.id,
    note_id: j.note_id,
    file_name: j.file_name,
    size_bytes: j.size_bytes,
    phase: j.phase,
    error: j.error?.startsWith(REQUEUED) ? null : j.error,
    engine: j.engine,
    created_at: j.created_at,
    updated_at: j.updated_at
  }
}

export class ImportQueue {
  private running: string | null = null
  private abort: AbortController | null = null
  private pumping = false
  private restored = false

  constructor(
    private readonly ctx: MainContext,
    private readonly manager: TranscriptionManager,
    private readonly media: MediaHost
  ) {}

  private push(job: ImportJob): void {
    for (const wc of this.ctx.windows.targets()) wc.send('imports:changed' satisfies PushChannel, job)
  }

  private async update(id: string, patch: { note_id?: string | null; phase?: ImportPhase; error?: string | null; engine?: ImportEngine | null }): Promise<ImportJob> {
    const job = await this.ctx.storage.updateImportJob(id, patch)
    const out = publicJob(job)
    this.push(out)
    return out
  }

  async list(): Promise<ImportJob[]> {
    return (await this.ctx.storage.listImportJobs()).map(publicJob)
  }

  /** `imports:start`: validated jobs are queued; the rest come back failed with their reason. */
  async start(paths: unknown): Promise<ImportJob[]> {
    if (!Array.isArray(paths)) throw new ImportFailure('paths must be a list')
    const unique = [...new Set(paths.filter((p): p is string => typeof p === 'string' && p.length > 0 && p.length < 4_000))].slice(0, MAX_PATHS)
    const inProgress = (await this.ctx.storage.listImportJobs()).filter((j) => ACTIVE.includes(j.phase)).length
    let room = Math.max(0, IMPORT_LIMITS.maxInProgress - inProgress)
    const out: ImportJob[] = []
    for (const path of unique) {
      const name = basename(path)
      let size = 0
      let error: string | null = null
      const ext = extname(name).toLowerCase()
      try {
        if (!isAbsolute(path)) throw new Error('relative')
        const st = statSync(path)
        if (!st.isFile()) throw new Error('not a file')
        size = st.size
        if (!(IMPORT_LIMITS.extensions as readonly string[]).includes(ext)) error = COPY.type
        else if (size === 0) error = COPY.empty
        else if (size > IMPORT_LIMITS.maxBytes) error = COPY.large
      } catch {
        error = COPY.unreadable
      }
      if (!error && room <= 0) error = COPY.limit
      if (error) {
        const now = new Date().toISOString()
        const job: ImportJob = { id: randomUUID(), note_id: null, file_name: name, size_bytes: size, phase: 'failed', error, engine: null, created_at: now, updated_at: now }
        log('info', 'imports:refused', { reason: error, bytes: size })
        out.push(job)
        this.push(job)
        continue
      }
      room--
      const job = await this.ctx.storage.createImportJob({ id: randomUUID(), file_name: name, source_path: path, size_bytes: size })
      log('info', 'imports:queued', { jobId: job.id, bytes: size, ext })
      out.push(publicJob(job))
      this.push(publicJob(job))
    }
    void this.pump()
    return out
  }

  /** `imports:dismiss`: a finished job leaves the list; a waiting one is dropped; the running one stops. */
  async dismiss(jobId: string): Promise<void> {
    if (jobId === this.running) {
      this.abort?.abort()
      return
    }
    await this.ctx.storage.deleteImportJob(jobId)
  }

  /** At startup: unfinished jobs are re-queued once when their file is unchanged. */
  async restore(): Promise<void> {
    if (this.restored) return
    this.restored = true
    for (const j of await this.ctx.storage.listImportJobs()) {
      if (!ACTIVE.includes(j.phase)) continue
      let unchanged = false
      try {
        const st = statSync(j.source_path)
        unchanged = st.isFile() && st.size === j.size_bytes
      } catch {
        unchanged = false
      }
      const again = j.phase !== 'queued' && j.error?.startsWith(REQUEUED)
      if (!unchanged || again) {
        await this.update(j.id, { phase: 'failed', error: COPY.interrupted })
        log('info', 'imports:interrupted', { jobId: j.id, unchanged })
        continue
      }
      if (j.phase !== 'queued') {
        const marker = j.phase === 'summarizing' ? REQUEUED_SUMMARY : REQUEUED
        await this.update(j.id, { phase: 'queued', error: marker })
        log('info', 'imports:requeued', { jobId: j.id, from: j.phase })
      }
    }
    void this.pump()
  }

  /** At quit: the running job stops where it is; the next start re-queues it once. */
  stopAll(): void {
    this.abort?.abort()
  }

  private async pump(): Promise<void> {
    if (this.pumping) return
    this.pumping = true
    try {
      for (;;) {
        const next = (await this.ctx.storage.listImportJobs()).find((j) => j.phase === 'queued')
        if (!next) return
        await this.run(next)
      }
    } catch (err) {
      log('error', 'imports:pump-failed', { err })
    } finally {
      this.pumping = false
    }
  }

  private async engineFor(): Promise<{ engine: ImportEngine; reason: string | null }> {
    const s = await this.ctx.settings.getAll()
    const localModel = pickLocalModel(this.manager.models, effectiveLanguage('local', s['asr.language']), s)
    const localReady = !!localModel && this.manager.models.isReady(localModel)
    const provider = s['asr.provider']
    if (provider === 'local') return localReady ? { engine: 'local', reason: null } : { engine: 'local', reason: COPY.noEngine }
    if (await egressBlocked(this.ctx, { kind: 'asr', provider })) return { engine: provider, reason: COPY.localOnly }
    if (await this.ctx.secrets.get(provider === 'deepgram' ? 'asr.deepgram' : 'asr.assemblyai')) return { engine: provider, reason: null }
    return localReady ? { engine: 'local', reason: null } : { engine: provider, reason: COPY.noEngine }
  }

  /** A cloud provider that may take a file the local decoder cannot read. */
  private async cloudFallback(): Promise<CloudAsrProviderId | null> {
    const s = await this.ctx.settings.getAll()
    const order: CloudAsrProviderId[] = s['asr.provider'] === 'assemblyai' ? ['assemblyai', 'deepgram'] : ['deepgram', 'assemblyai']
    for (const p of order) {
      if (await egressBlocked(this.ctx, { kind: 'asr', provider: p })) continue
      if (await this.ctx.secrets.get(p === 'deepgram' ? 'asr.deepgram' : 'asr.assemblyai')) return p
    }
    return null
  }

  private async run(job: ImportJobRow): Promise<void> {
    this.running = job.id
    const abort = new AbortController()
    this.abort = abort
    const resumeSummary = job.error === REQUEUED_SUMMARY && job.note_id !== null
    try {
      // creating
      let noteId = job.note_id
      if (noteId && !(await this.ctx.storage.getNote(noteId))) throw new ImportFailure(COPY.failed)
      if (!noteId) {
        await this.update(job.id, { phase: 'creating', error: null })
        const title = basename(job.file_name, extname(job.file_name)) || job.file_name
        const note = await this.ctx.storage.createNote({ origin: 'audio-import', title, transcribe: false, created_via: creationSource() })
        noteId = note.id
        await this.update(job.id, { note_id: noteId })
        log('info', 'imports:note-created', { jobId: job.id, noteId })
      }
      if (!resumeSummary) await this.transcribe(job, noteId, abort.signal)
      // The import's speaker labels are final now (provider labels, or the local pass): name
      // suggestions may run, as after a meeting's stop.
      getSpeakerNames(this.ctx).trigger(noteId, 'import')
      // summarizing: the normal summary
      await this.update(job.id, { phase: 'summarizing', error: null })
      try {
        const r = await this.ctx.enhance.autoGenerate(noteId)
        log('info', 'imports:summary', { jobId: job.id, generated: r !== null })
      } catch (err) {
        log('warn', 'imports:summary-failed', { jobId: job.id, err })
        throw new ImportFailure(COPY.summary)
      }
      await this.update(job.id, { phase: 'complete', error: null })
      log('info', 'imports:complete', { jobId: job.id })
    } catch (err) {
      const message = abort.signal.aborted ? 'Import cancelled.' : err instanceof ImportFailure ? err.message : COPY.failed
      if (!(err instanceof ImportFailure)) log('error', 'imports:failed', { jobId: job.id, err })
      else log('warn', 'imports:failed', { jobId: job.id, reason: message })
      if (abort.signal.aborted && this.quitting) return
      await this.update(job.id, { phase: 'failed', error: message }).catch(() => undefined)
    } finally {
      this.running = null
      this.abort = null
    }
  }

  quitting = false

  private async transcribe(job: ImportJobRow, noteId: string, signal: AbortSignal): Promise<void> {
    // A re-run replaces what an interrupted run wrote.
    const old = (await this.ctx.storage.getTranscript(noteId)).filter((c) => c.text !== DELETED_CHUNK_MARKER)
    if (old.length) {
      await this.ctx.storage.upsertChunks(old.map((c) => ({ ...c, text: DELETED_CHUNK_MARKER, is_final: true, providerDetails: undefined })))
      log('info', 'imports:previous-run-cleared', { jobId: job.id, chunks: old.length })
    }
    const { engine, reason } = await this.engineFor()
    if (reason) {
      await this.update(job.id, { engine })
      throw new ImportFailure(reason)
    }
    await this.update(job.id, { phase: 'reading', engine, error: null })
    const settings = await this.ctx.settings.getAll()
    const anchor = Date.now()
    const identity = await this.ctx.storage.identity()
    const ext = extname(job.file_name).toLowerCase()
    const format = FORMATS[ext] ?? 'mp3'
    const sessionId = randomUUID()
    let chunks = 0
    const startSession = async (provider: ImportEngine, model: string, language: string): Promise<void> => {
      await this.ctx.storage
        .createSession({ id: sessionId, document_id: noteId, provider, model, language, started_at: new Date(anchor).toISOString() })
        .catch((err: unknown) => log('warn', 'imports:session-row-failed', { err }))
    }
    const cloud = async (provider: CloudAsrProviderId): Promise<void> => {
      if (await egressBlocked(this.ctx, { kind: 'asr', provider })) throw new ImportFailure(COPY.localOnly)
      const language = settings['asr.language']
      await startSession(provider, provider === 'deepgram' ? 'nova-3' : 'assemblyai', language)
      log('info', 'imports:cloud-start', { jobId: job.id, provider, bytes: job.size_bytes })
      const result = await transcribeInCloud(this.ctx, provider, { path: job.source_path, ext }, language, signal, () => {
        void this.update(job.id, { phase: 'transcribing' })
      })
      await this.update(job.id, { phase: 'transcribing' })
      for (const t of result.turns) {
        const chunk: TranscriptChunk = {
          id: randomUUID(),
          document_id: noteId,
          workspace_id: identity.workspaceId,
          owner_id: identity.ownerId,
          transcription_session_id: sessionId,
          source: 'system',
          start_timestamp: new Date(anchor + t.startMs).toISOString(),
          end_timestamp: new Date(anchor + Math.max(t.endMs, t.startMs)).toISOString(),
          text: t.text,
          is_final: true,
          detected_speaker_name: null,
          detectedSpeaker: null,
          // Provider speaker labels stay as `spk`, so the view uses word-level turns.
          ...(t.words.length ? { providerDetails: { words: t.words, provider, model: result.model, wallClockAnchorMs: anchor } } : {})
        }
        this.manager.store.upsert(chunk)
        chunks++
      }
      await this.manager.store.flush(noteId)
    }
    try {
      if (engine === 'local') {
        const language = effectiveLanguage('local', settings['asr.language'])
        const modelId = pickLocalModel(this.manager.models, language, settings) ?? LOCAL_ASR_MODEL
        await startSession('local', modelId, language)
        const diarize = settings['transcription.diarization'] && this.manager.models.isReady('diarization-en')
        try {
          const r = await transcribeLocally(this.manager, this.media, {
            jobId: job.id,
            path: job.source_path,
            format,
            size: job.size_bytes,
            noteId,
            sessionId,
            baseEpochMs: anchor,
            identity,
            diarize,
            modelId,
            language,
            signal,
            onTranscribing: () => void this.update(job.id, { phase: 'transcribing' })
          })
          chunks = r.chunks
        } catch (err) {
          if (!(err instanceof MediaDecodeError)) throw err
          if (signal.aborted) throw new ImportFailure('Import cancelled.')
          log('warn', 'imports:decode-failed', { jobId: job.id, code: err.code, message: err.message })
          // A codec WebCodecs lacks goes to the cloud path when a cloud key exists.
          const fallback = err.code === 'unsupported' ? await this.cloudFallback() : null
          if (!fallback) throw new ImportFailure(COPY.read)
          await this.update(job.id, { engine: fallback })
          await cloud(fallback)
        }
      } else {
        await cloud(engine)
      }
    } finally {
      await this.ctx.storage.endSession(sessionId, new Date().toISOString(), signal.aborted ? 'import_cancelled' : 'import_complete').catch(() => undefined)
    }
    if (!chunks) throw new ImportFailure(COPY.transcribe)
    log('info', 'imports:transcribed', { jobId: job.id, engine, chunks })
  }
}

