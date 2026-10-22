// SPDX-License-Identifier: Apache-2.0
// registerTranscription(): the transcript and ASR-key IPC (`transcript:get`, the `asr:*-key`
// channels and `asr:test`). Sessions themselves are started and stopped by capture through
// `transcriptionControl(ctx)`. Handlers are registered with literal channels only.
//
// Exports: `registerTranscription(ctx): TranscriptionService`,
// `transcriptionControl(ctx): TranscriptionControl` and `createSpeechApi(ctx): SpeechApi`.

import { ipcMain } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq } from '@shared/ipc'
import type { ProviderTestResult } from '@shared/types/common'
import type { SecretId } from '@shared/types/settings'
import type { AsrProviderId, CloudAsrProviderId, TranscriptChunk } from '@shared/types/transcript'
import type { MainContext, TranscriptionService } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { apiKeyProblem } from '../secrets'
import { getLocalModels } from '../asr/instance'
import type { SpeechApi, TranscriptionControl } from './api'
import { getTranscriptionManager } from './manager'
import { startSimulatedSession } from './simulated'
import { createSpeechService } from './speech'

export type {
  RecognizerFailure,
  RecognizerOptions,
  SimulatedLine,
  SimulatedSession,
  SourceStateListener,
  SpeechApi,
  SpeechRecognizer,
  StartOptions,
  TranscriptionControl
} from './api'
export { RecognizerError } from './api'

/** The capture → transcription seam. */
export function transcriptionControl(ctx: MainContext): TranscriptionControl {
  const m = getTranscriptionManager(ctx)
  return {
    start: (opts) => m.start(opts),
    feed: (noteId, source, pcm, captureTimeMs) => m.feed(noteId, source, pcm, captureTimeMs),
    updateKeywords: (noteId, keywords) => m.updateKeywords(noteId, keywords),
    retryNow: (noteId) => m.retryNow(noteId),
    isActive: (noteId) => m.isActive(noteId),
    stop: (noteId, reason) => m.stop(noteId, reason),
    awaitStopped: (noteId) => m.awaitStopped(noteId),
    flush: (noteId) => m.flush(noteId),
    awaitSpeakerLabels: async (noteId) => {
      const { timedOut } = await m.awaitStopped(noteId)
      // The pass is queued only after the drain, the session row and the tee are done:
      // a wait that started during the drain must not see "no pass" too early.
      if (!timedOut) await m.awaitStops(noteId)
      await m.flush(noteId)
      await m.diarizer.awaitPass(noteId)
    },
    liveChunks: (noteId) => m.liveChunks(noteId),
    getTranscript: (noteId) => m.getTranscript(noteId),
    onSourceState: (listener) => m.onSourceState(listener),
    reconfigure: (noteId, opts) => m.reconfigure(noteId, opts),
    // The demo's scripted lines as final system chunks.
    startSimulated: (noteId, lines) => startSimulatedSession(ctx, m.store, noteId, lines)
  }
}

/**
 * Recognizers over the transcription providers for dictation and chat voice input
 * (transcription/speech.ts).
 */
export function createSpeechApi(ctx: MainContext): SpeechApi {
  return createSpeechService(ctx, getLocalModels(ctx))
}

const CLOUD: readonly CloudAsrProviderId[] = ['deepgram', 'assemblyai']
const ALL: readonly AsrProviderId[] = ['deepgram', 'assemblyai', 'local']
const MAX_KEY_LENGTH = 512

function cloudProvider(req: unknown): CloudAsrProviderId {
  const p = (req as { provider?: unknown } | null)?.provider
  if (typeof p !== 'string' || !CLOUD.includes(p as CloudAsrProviderId)) {
    throw notulaError('invalid-input', 'Unknown transcription provider.')
  }
  return p as CloudAsrProviderId
}

function secretId(provider: CloudAsrProviderId): SecretId {
  return provider === 'deepgram' ? 'asr.deepgram' : 'asr.assemblyai'
}

function noteId(req: unknown): string {
  const id = (req as { noteId?: unknown } | null)?.noteId
  if (typeof id !== 'string' || !id) throw notulaError('invalid-input', 'noteId is required.')
  return id
}

export function registerTranscription(ctx: MainContext): TranscriptionService {
  const manager = getTranscriptionManager(ctx)

  ipcMain.handle('transcript:get' satisfies InvokeChannel, (_e, req: InvokeReq<'transcript:get'>): Promise<TranscriptChunk[]> =>
    manager.getTranscript(noteId(req))
  )

  ipcMain.handle('asr:set-key' satisfies InvokeChannel, async (_e, req: InvokeReq<'asr:set-key'>): Promise<void> => {
    const provider = cloudProvider(req)
    const key = typeof req?.key === 'string' ? req.key.trim() : ''
    // A zero-width or non-ASCII character would make every connect throw.
    const problem = key.length > MAX_KEY_LENGTH ? 'That is too long to be an API key.' : apiKeyProblem(key)
    if (problem) throw expected(notulaError('invalid-input', problem))
    await ctx.secrets.set(secretId(provider), key)
    log('info', 'asr:key-set', { provider })
  })

  ipcMain.handle('asr:has-key' satisfies InvokeChannel, async (_e, req: InvokeReq<'asr:has-key'>): Promise<boolean> => {
    const id = secretId(cloudProvider(req))
    if (await ctx.secrets.has(id)) return true
    // Dev builds may resolve a key from NOTULA_SECRET_* that `has` does not see.
    return ctx.isDev && (await ctx.secrets.get(id)) !== null
  })

  ipcMain.handle('asr:clear-key' satisfies InvokeChannel, async (_e, req: InvokeReq<'asr:clear-key'>): Promise<void> => {
    const provider = cloudProvider(req)
    await ctx.secrets.clear(secretId(provider))
    log('info', 'asr:key-cleared', { provider })
  })

  ipcMain.handle('asr:test' satisfies InvokeChannel, async (_e, req: InvokeReq<'asr:test'>): Promise<ProviderTestResult> => {
    const p = (req as { provider?: unknown } | null)?.provider
    if (typeof p !== 'string' || !ALL.includes(p as AsrProviderId)) {
      throw notulaError('invalid-input', 'Unknown transcription provider.')
    }
    try {
      const r = await manager.registry[p as AsrProviderId].test()
      return r.error ? { ok: r.ok, error: r.error } : { ok: r.ok }
    } catch (err) {
      log('warn', 'asr:test-failed', { provider: p, err })
      return { ok: false, error: err instanceof Error ? err.message : 'The test failed.' }
    }
  })

  return {
    flush: (id) => manager.flush(id),
    liveChunks: (id) => manager.liveChunks(id)
  }
}
