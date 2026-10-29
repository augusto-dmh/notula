// SPDX-License-Identifier: Apache-2.0
// Local transcription of an imported recording: the media
// worker decodes the file to 16 kHz s16le mono in 1 s batches; main feeds them to a notula-asr
// worker as fast as it accepts them, at most 30 s ahead of its
// committed position. With "Separate speakers" on, the same audio is teed (NAU1) and one
// diarization pass runs over it.

import { randomUUID } from 'node:crypto'
import { rmSync } from 'node:fs'
import { IMPORT_LIMITS } from '@shared/types/recordings'
import type { LocalAsrModelId, ProviderWord, TranscriptChunk } from '@shared/types/transcript'
import type { AudioRecorder } from '../asr/diarize'
import { log } from '../log'
import type { StorageIdentity } from '../storage/api'
import type { TranscriptionManager } from '../transcription/manager'
import { LocalConnection } from '../transcription/providers/local'
import type { AsrResult } from '../transcription/providers/types'
import { ImportFailure } from './cloud'
import { MediaDecodeError, type MediaHost } from './media'
import type { MediaFormat } from './media-protocol'

const BYTES_PER_MS = 32
const DRAIN_MS = 60_000

export interface LocalImportInput {
  jobId: string
  path: string
  format: MediaFormat
  size: number
  noteId: string
  sessionId: string
  baseEpochMs: number
  identity: StorageIdentity
  diarize: boolean
  /** The on-device model and the language it transcribes. */
  modelId: LocalAsrModelId
  language: string
  signal: AbortSignal
  /** The first PCM reached the engine. */
  onTranscribing(): void
}

export async function transcribeLocally(manager: TranscriptionManager, media: MediaHost, input: LocalImportInput): Promise<{ chunks: number; audioMs: number }> {
  if (!manager.models.isReady(input.modelId)) throw new ImportFailure('The on-device speech model is not downloaded.')
  const conn = new LocalConnection(manager.models, 'system', [], input.modelId, input.language).start()
  const tee: AudioRecorder | null = input.diarize ? manager.diarizer.recorder(input.noteId, input.sessionId) : null
  let chunks = 0
  let fedMs = 0
  let committed = input.baseEpochMs
  let fatal: string | null = null
  const pending: { seq: number; endEpochMs: number }[] = []
  let first = true

  const onResult = (r: AsrResult): void => {
    if (!r.isFinal || !r.text.trim()) return
    const words: ProviderWord[] = r.words.map((w) => ({ w: w.w, s_ms: w.s_ms, e_ms: w.e_ms, conf: w.conf }))
    const chunk: TranscriptChunk = {
      id: randomUUID(),
      document_id: input.noteId,
      workspace_id: input.identity.workspaceId,
      owner_id: input.identity.ownerId,
      transcription_session_id: input.sessionId,
      source: 'system',
      start_timestamp: new Date(r.baseEpochMs + r.startMs).toISOString(),
      end_timestamp: new Date(r.baseEpochMs + r.endMs).toISOString(),
      text: r.text.trim(),
      is_final: true,
      detected_speaker_name: null,
      detectedSpeaker: null,
      // The diarization pass maps words to turns; without it the words are not kept.
      ...(input.diarize && words.length
        ? { providerDetails: { words, provider: 'local' as const, model: input.modelId, wallClockAnchorMs: r.baseEpochMs } }
        : {})
    }
    manager.store.upsert(chunk)
    chunks++
  }
  conn.on('result', onResult)
  conn.on('error', (e) => {
    if (e.fatal) fatal = e.message
  })

  let run: ReturnType<MediaHost['decode']> | null = null
  const tryAck = (): void => {
    // Decoding stays at most 30 s ahead of what the engine has committed.
    while (pending.length && (pending[0] as { endEpochMs: number }).endEpochMs - committed <= IMPORT_LIMITS.localAheadMs) {
      run?.ack((pending.shift() as { seq: number }).seq)
    }
  }
  conn.on('progress', ({ savedThroughEpochMs }) => {
    committed = Math.max(committed, savedThroughEpochMs)
    tryAck()
  })

  const abort = (): void => run?.cancel()
  input.signal.addEventListener('abort', abort, { once: true })
  let decoded = false
  try {
    run = media.decode(input.jobId, input.path, input.format, input.size, {
      onPcm: (seq, pcm) => {
        if (input.signal.aborted || fatal) return
        const at = input.baseEpochMs + fedMs
        conn.send(pcm, at)
        tee?.write('system', pcm, at)
        fedMs += pcm.byteLength / BYTES_PER_MS
        pending.push({ seq, endEpochMs: input.baseEpochMs + fedMs })
        if (first) {
          first = false
          input.onTranscribing()
        }
        tryAck()
      }
    })
    const { ms } = await run.done
    if (fatal) throw new ImportFailure('Notula couldn’t transcribe this file. Try again.')
    log('info', 'imports:local-decoded', { jobId: input.jobId, ms: Math.round(ms) })
    const ok = await conn.drain(DRAIN_MS)
    if (!ok) log('warn', 'imports:local-drain-timeout', { jobId: input.jobId })
    decoded = true
  } catch (err) {
    if (err instanceof MediaDecodeError) throw err
    throw err instanceof ImportFailure ? err : new ImportFailure('Notula couldn’t transcribe this file. Try again.')
  } finally {
    input.signal.removeEventListener('abort', abort)
    conn.off('result', onResult)
    await conn.close(5_000).catch(() => undefined)
    // A failed run leaves no temp audio behind (the encrypted tee is unreadable anyway).
    if (!decoded && tee) {
      for (const f of await tee.close().catch(() => [])) rmSync(f.path, { force: true })
    }
  }
  await manager.store.flush(input.noteId)
  if (tee) {
    // One diarization pass over the decoded audio, then the letters are on the words. The
    // pass is step 1 of the note's post-meeting job (speaker profiles), which
    // runs inside it: `awaitPass` resolves once the job wrote its names or ended.
    manager.diarizer.sessionClosed(input.noteId, await tee.close())
    manager.diarizer.noteStopped(input.noteId)
    await manager.diarizer.awaitPass(input.noteId)
  }
  return { chunks, audioMs: Math.round(fedMs) }
}
