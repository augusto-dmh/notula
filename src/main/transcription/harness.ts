// SPDX-License-Identifier: Apache-2.0
// Dev-only seam harness: with `NOTULA_DEV_SPEECH_HARNESS=1` in an unpackaged
// build, once storage is ready it dictates 10 s of `NOTULA_DEV_SPEECH_WAV` (16 kHz mono 16-bit WAV)
// through `ctx.speech` with each provider, then plays a 5-line script through `startSimulated` on
// a new note. Everything is logged as `speech-harness:*` lines; nothing else changes. Packaged
// builds never run it.
//
// Multilingual options, all dev-only:
// - `NOTULA_DEV_SPEECH_LANGUAGE` (default `en`): the dictation language.
// - `NOTULA_DEV_SPEECH_DOWNLOAD`: comma-separated model ids, downloaded through the model
//   manager (the real fetch, pins and extraction) before anything else.
// - `NOTULA_DEV_SPEECH_MEETING`: a session language (`pt-BR`, `multi`, `en`). The whole WAV
//   plays in real time through the local provider on two sources at once (microphone and
//   system, as in a meeting); the finals, the worker load time and peak memory are logged.
// - `NOTULA_DEV_SPEECH_PREFER` (`accuracy` | `speed`): sets `asr.local.prefer` first.
// - `NOTULA_DEV_SPEECH_GEMINI_MOCK`: a loopback base URL serving Gemini-shaped answers; the
//   OpenAI-compatible provider lists models and runs `test` against it.

import { readFileSync } from 'node:fs'
import { app } from 'electron'
import { GEMINI_PRESET } from '@shared/types/enhance'
import type { AsrProviderId, LocalModelId } from '@shared/types/transcript'
import { getLocalModels } from '../asr/instance'
import { MODEL_MANIFEST } from '../asr/manifest'
import type { MainContext } from '../context'
import { log } from '../log'
import { buildProvider } from '../llm/registry'
import { egressBlocked } from '../privacy'
import { RecognizerError, type SimulatedLine } from './api'
import { transcriptionControl } from './index'
import { getTranscriptionManager } from './manager'
import type { AsrResult } from './providers/types'

const DICTATE_MS = 10_000
const FEED_MS = 100

function pcmFromWav(path: string): Buffer {
  const b = readFileSync(path)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file')
  let i = 12
  while (i + 8 <= b.length) {
    const id = b.toString('ascii', i, i + 4)
    const size = b.readUInt32LE(i + 4)
    if (id === 'fmt ') {
      const channels = b.readUInt16LE(i + 10)
      const rate = b.readUInt32LE(i + 12)
      const bits = b.readUInt16LE(i + 22)
      if (channels !== 1 || rate !== 16_000 || bits !== 16) throw new Error('the harness WAV must be 16 kHz mono 16-bit')
    }
    if (id === 'data') return b.subarray(i + 8, Math.min(b.length, i + 8 + size))
    i += 8 + size + (size % 2)
  }
  throw new Error('no data chunk')
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function dictate(ctx: MainContext, choice: AsrProviderId, pcm: Buffer, language: string): Promise<void> {
  const started = Date.now()
  const rec = ctx.speech.openRecognizer({ purpose: 'dictation', choice, language, keyterms: ['Notula', 'offsite'] })
  try {
    // Real-time pacing, as a microphone would deliver it.
    const ready = rec.ready.then(
      () => true,
      (err: unknown) => err
    )
    const bytes = Math.min(pcm.byteLength, DICTATE_MS * 32)
    for (let at = 0; at < bytes; at += FEED_MS * 32) {
      rec.feed(pcm.subarray(at, Math.min(bytes, at + FEED_MS * 32)))
      await sleep(FEED_MS)
    }
    const r = await ready
    if (r !== true) throw r
    const out = await rec.finish()
    log('info', 'speech-harness:dictation', {
      choice,
      provider: rec.provider,
      ok: true,
      audioMs: out.audioMs,
      language: out.language ?? '',
      text: out.text.slice(0, 300),
      ms: Date.now() - started
    })
  } catch (err) {
    rec.cancel()
    log('info', 'speech-harness:dictation', {
      choice,
      provider: rec.provider,
      ok: false,
      reason: err instanceof RecognizerError ? err.reason : 'error',
      message: err instanceof Error ? err.message : String(err),
      ms: Date.now() - started
    })
  }
}

/** The given processes' peak working set (KB, Windows) by pid. */
function peaks(pids: number[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const m of app.getAppMetrics()) {
    if (pids.includes(m.pid)) out[String(m.pid)] = m.memory.peakWorkingSetSize ?? 0
  }
  return out
}

async function download(ctx: MainContext, ids: string[]): Promise<void> {
  const models = getLocalModels(ctx)
  for (const id of ids) {
    if (!Object.hasOwn(MODEL_MANIFEST, id)) continue
    const started = Date.now()
    const ok = await models.ensureReady(id as LocalModelId)
    log('info', 'speech-harness:download', { modelId: id, ok, ms: Date.now() - started, state: models.stateNow(id as LocalModelId).state })
  }
}

/** Two sources through the local provider, the WAV in real time on each. */
async function meeting(ctx: MainContext, pcm: Buffer, language: string): Promise<void> {
  const local = getTranscriptionManager(ctx).registry.local
  const available = await local.available(language)
  const model = await local.model(language)
  log('info', 'speech-harness:meeting-start', { language, model, available: available.ok ? 'ok' : available.reason })
  if (!available.ok) return
  const t0 = Date.now()
  // The workers: the utility processes that appear with these connections.
  const before = new Set(app.getAppMetrics().map((m) => m.pid))
  const sources = ['microphone', 'system'] as const
  const conns = await Promise.all(
    sources.map((source) => local.connect({ source, language, keywords: [], sampleRate: 16000, sessionId: `harness-${t0}` }))
  )
  const texts = sources.map(() => new Map<string, string>())
  const readyMs: number[] = sources.map(() => -1)
  conns.forEach((c, i) => {
    c.on('result', (r: AsrResult) => {
      if (r.isFinal) (texts[i] as Map<string, string>).set(r.segmentKey, r.text)
    })
    c.once('open', () => {
      readyMs[i] = Date.now() - t0
    })
    c.on('error', (e) => log('warn', 'speech-harness:meeting-error', { source: sources[i], message: e.message }))
  })
  const feedStart = Date.now()
  for (let at = 0; at < pcm.byteLength; at += FEED_MS * 32) {
    const piece = pcm.subarray(at, Math.min(pcm.byteLength, at + FEED_MS * 32))
    for (const c of conns) c.send(Buffer.from(piece), feedStart + at / 32)
    await sleep(FEED_MS)
  }
  const fedAt = Date.now()
  const peakKb = peaks(app.getAppMetrics().filter((m) => m.type === 'Utility' && !before.has(m.pid)).map((m) => m.pid))
  await Promise.all(conns.map((c) => c.close(60_000)))
  log('info', 'speech-harness:meeting', {
    language,
    model,
    audioMs: Math.round(pcm.byteLength / 32),
    readyMs: readyMs.join(','),
    tailMs: Date.now() - fedAt,
    peakWorkingSetMB: Object.values(peakKb).map((kb) => Math.round(kb / 1024)).join(','),
    microphone: [...(texts[0] as Map<string, string>).values()].join(' ').slice(0, 1200),
    system: [...(texts[1] as Map<string, string>).values()].join(' ').slice(0, 1200)
  })
}

/** The Gemini preset's paths against a loopback mock (never Google itself). */
async function geminiMock(ctx: MainContext, base: string): Promise<void> {
  const saved = await ctx.settings.getAll()
  try {
    await ctx.secrets.set('llm.openai', 'harness-key')
    const settings = { ...saved, 'llm.provider': 'openai' as const, 'llm.openai.baseUrl': base, 'llm.openai.model': GEMINI_PRESET.model }
    const p = buildProvider('openai', settings, ctx.secrets)
    const models = await p.listModels(AbortSignal.timeout(10_000))
    let test = 'ok'
    await p.test(AbortSignal.timeout(10_000)).catch((err: unknown) => {
      test = err instanceof Error ? err.message : String(err)
    })
    const presetBlocked = await egressBlocked(
      { settings: { get: async (k: string) => ({ ...settings, 'privacy.localOnly': true })[k as keyof typeof settings] } as never },
      { kind: 'llm' }
    )
    log('info', 'speech-harness:gemini-mock', { models: models.join(','), test, localOnlyBlocks: presetBlocked })
  } catch (err) {
    log('warn', 'speech-harness:gemini-mock-failed', { message: err instanceof Error ? err.message : String(err) })
  } finally {
    await ctx.secrets.clear('llm.openai')
  }
}

async function simulate(ctx: MainContext): Promise<void> {
  const note = await ctx.storage.createNote({ origin: 'new_note_button', title: 'Speech harness demo', transcribe: false, created_via: 'desktop' })
  const lines: SimulatedLine[] = [
    { atMs: 0, durationMs: 1_200, speaker: 'Notula Demo', text: 'Welcome to the demo meeting.' },
    { atMs: 1_500, durationMs: 1_200, speaker: 'Notula Demo', text: 'Your own notes go on the right.' },
    { atMs: 3_000, durationMs: 1_200, speaker: 'Notula Demo', text: 'The transcript fills in below.' },
    { atMs: 4_500, durationMs: 1_200, speaker: 'Notula Demo', text: 'We have twelve thousand dollars for the offsite.' },
    { atMs: 6_000, durationMs: 1_200, speaker: 'Notula Demo', text: 'Stop the meeting to get enhanced notes.' }
  ]
  const control = transcriptionControl(ctx)
  const session = control.startSimulated(note.id, lines)
  session.onLine((i) => log('info', 'speech-harness:simulated-line', { index: i }))
  const ended = new Promise<string>((resolve) => session.onEnded(resolve))
  // Pause for 1 s in the middle: the rest of the script shifts by the pause.
  await sleep(2_000)
  session.pause()
  await sleep(1_000)
  session.resume()
  const reason = await ended
  const chunks = await control.getTranscript(note.id)
  log('info', 'speech-harness:simulated', {
    noteId: note.id,
    sessionId: session.sessionId,
    reason,
    chunks: chunks.length,
    speakers: [...new Set(chunks.map((c) => c.detected_speaker_name ?? ''))].join(','),
    sources: [...new Set(chunks.map((c) => c.source))].join(','),
    final: chunks.every((c) => c.is_final)
  })
}

export function maybeRunSpeechHarness(ctx: MainContext): void {
  if (app.isPackaged || process.env['NOTULA_DEV_SPEECH_HARNESS'] !== '1') return
  let ran = false
  const run = async (): Promise<void> => {
    if (ran) return
    ran = true
    await sleep(5_000)
    log('info', 'speech-harness:start', {})
    const ids = (process.env['NOTULA_DEV_SPEECH_DOWNLOAD'] ?? '').split(',').map((x) => x.trim()).filter(Boolean)
    if (ids.length) await download(ctx, ids).catch((err: unknown) => log('warn', 'speech-harness:download-failed', { err }))
    const prefer = process.env['NOTULA_DEV_SPEECH_PREFER']?.trim()
    if (prefer === 'accuracy' || prefer === 'speed') await ctx.settings.set('asr.local.prefer', prefer)
    const mock = process.env['NOTULA_DEV_SPEECH_GEMINI_MOCK']?.trim()
    if (mock) await geminiMock(ctx, mock)
    const wav = process.env['NOTULA_DEV_SPEECH_WAV']?.trim()
    const language = process.env['NOTULA_DEV_SPEECH_LANGUAGE']?.trim() || 'en'
    if (wav) {
      try {
        const pcm = pcmFromWav(wav)
        for (const choice of ['local', 'deepgram', 'assemblyai'] as const) await dictate(ctx, choice, pcm, language)
        const meet = process.env['NOTULA_DEV_SPEECH_MEETING']?.trim()
        if (meet) await meeting(ctx, pcm, meet)
      } catch (err) {
        log('warn', 'speech-harness:wav-failed', { err })
      }
    } else log('info', 'speech-harness:no-wav', {})
    await simulate(ctx).catch((err: unknown) => log('warn', 'speech-harness:simulated-failed', { err }))
    log('info', 'speech-harness:done', {})
  }
  ctx.bus.on('storage:status', (s) => {
    if (s.state === 'ready') void run()
  })
  void ctx.storage
    .status()
    .then((s) => {
      if (s.state === 'ready') void run()
    })
    .catch(() => undefined)
}
