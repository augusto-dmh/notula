// SPDX-License-Identifier: Apache-2.0
// The voiceprint: the `voiceprint:*` IPC, the audio tap and the notula-voiceprint worker.
//
// - Opt-in only. Turning `voiceprint.enabled` on enrols nobody: enrolment is "Record my voice" (a
//   30 s sample the renderer captures and sends, held in memory only) or the
//   separate passive switch (`voiceprint.passive`, main-only).
// - The tap: only while enabled and (a profile exists or passive is on), the microphone of each
//   session goes to `<userData>/voiceprint-tmp/<sessionId>.naud` (NAU1). Its key lives only in this
//   process's memory, so a file left by a crash is unreadable and start-up deletes it.
// - After `capture:stopped`: classify. In person with a profile → diarize the mic temp,
//   embed each speaker, match, label `Me` / `Speaker N`, write chunk revisions
//   and push `transcript:changed`. Online with passive on → enrol the dominant speaker and fold.
//   Otherwise, with a profile, the temp file is kept for 2 h so "This was an in-person meeting"
//   can still run on it; then it is deleted (also at quit and at start-up).
// - Privacy: vectors stay in main, the worker port and storage; never IPC, logs or files.
//   The best cosine and margin are logged at debug level only. Forget deletes with
//   secure delete on.

import { randomUUID } from 'node:crypto'
import { cpus } from 'node:os'
import { mkdirSync, readdirSync, rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { app, ipcMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel, SendChannel } from '@shared/ipc'
import type { DetectedSpeaker, TranscriptChanged, TranscriptChunk } from '@shared/types/transcript'
import {
  VOICEPRINT_LIMITS as L,
  VOICEPRINT_MODEL_ID,
  type VoiceprintClassification,
  type VoiceprintIdentifyResult,
  type VoiceprintSampleResult,
  type VoiceprintStatus
} from '@shared/types/voiceprint'
import { getLocalModels } from '../asr/instance'
import { workerEnv } from '../asr/instance'
import type { VerifiedFile } from '../asr/protocol'
import { baseName } from '../asr/verify'
import { FramedWriter, randomKey } from '../crypto/blobs'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import type { VoiceprintRow } from '../storage/api'
import { startVHarness, vHarness, vHarnessOn } from './harness'
import { assignSpeaker, classify, dominant, fold, labels, matchSelf, type Anchor } from './math'
import type { VoiceprintAudio, VoiceprintJob, VoiceprintSpeaker, VoiceprintToMain } from './protocol'

const MODEL = 'diarization-en' as const
const KEEP_FOR_IDENTIFY_MS = 2 * 3_600_000
const JOB_CAP_MS = 10 * 60_000
const GAP_ANCHOR_MS = 200
const CLUSTER_THRESHOLD = 0.5
const MAX_SAMPLE_MS = 60_000
const FILE_NAME = /^[0-9a-f-]{36}\.naud$/

interface TempAudio {
  noteId: string
  sessionId: string
  path: string
  id: string
  key: Buffer
  anchors: Anchor[]
  samples: number
}

interface Session extends TempAudio {
  writer: FramedWriter | null
  opening: Promise<void>
  early: Buffer[]
  nextUnixMs: number | null
  appsSeen: Set<string>
  failed: boolean
}

interface Sample {
  sessionId: string
  sender: WebContents
  parts: Buffer[]
  bytes: number
  targetBytes: number
  startedAt: number
  finish(r: 'done' | 'cancelled' | 'timeout'): void
}

type JobResult = Extract<VoiceprintToMain, { type: 'result' }>

function workerPath(): string {
  const here = basename(__dirname) === 'chunks' ? dirname(__dirname) : __dirname
  return join(here, 'voiceprint.js')
}

function rms(pcm: Buffer): number {
  const n = pcm.byteLength >> 1
  if (!n) return 0
  let sum = 0
  for (let i = 0; i < n; i++) {
    const x = pcm.readInt16LE(i * 2) / 32768
    sum += x * x
  }
  return Math.min(1, Math.sqrt(sum / n) * 4)
}

export function registerVoiceprint(ctx: MainContext): void {
  const tmpDir = join(ctx.userDataPath, 'voiceprint-tmp')
  const sessions = new Map<string, Session>()
  const kept = new Map<string, TempAudio & { expiry: NodeJS.Timeout }>()
  let micApps: string[] = []
  let lastClassification: VoiceprintStatus['lastClassification'] = null
  let profilePresent = false
  let sample: Sample | null = null

  // ---------- files ----------

  function removeFile(path: string): void {
    try {
      rmSync(path, { force: true })
    } catch (err) {
      log('warn', 'voiceprint:temp-delete-failed', { err })
    }
  }

  function dropKept(noteId: string): void {
    const k = kept.get(noteId)
    if (!k) return
    clearTimeout(k.expiry)
    kept.delete(noteId)
    k.key.fill(0)
    removeFile(k.path)
  }

  function sweepTemp(): void {
    try {
      for (const f of readdirSync(tmpDir)) {
        if (FILE_NAME.test(f) || f.endsWith('.naud')) removeFile(join(tmpDir, f))
      }
    } catch {
      // No folder yet.
    }
  }

  // Leftovers from a crash have no key anywhere: unreadable, deleted now.
  sweepTemp()
  app.once('will-quit', () => {
    for (const s of sessions.values()) void s.writer?.abort()
    for (const id of [...kept.keys()]) dropKept(id)
    sweepTemp()
    killWorker()
  })

  // ---------- status ----------

  function modelReady(): boolean {
    try {
      return getLocalModels(ctx).isReady(MODEL)
    } catch {
      return false
    }
  }

  async function profile(): Promise<VoiceprintRow | null> {
    try {
      const p = await ctx.storage.getVoiceprint(VOICEPRINT_MODEL_ID)
      profilePresent = !!p && p.centroids.length > 0
      return p
    } catch {
      return null
    }
  }

  async function status(): Promise<VoiceprintStatus> {
    const [s, p] = await Promise.all([ctx.settings.getAll(), profile()])
    return {
      enabled: s['voiceprint.enabled'],
      modelReady: modelReady(),
      passiveEnrolment: s['voiceprint.enabled'] && s['voiceprint.passive'],
      profile: {
        present: !!p && p.centroids.length > 0,
        totalSpeechMs: p?.total_speech_ms ?? 0,
        updatedAt: p?.updated_at ?? null,
        centroidCount: p?.centroids.length ?? 0
      },
      lastClassification
    }
  }

  async function push(): Promise<VoiceprintStatus> {
    const st = await status()
    for (const wc of ctx.windows.targets()) wc.send('voiceprint:status-changed' satisfies PushChannel, st)
    return st
  }

  // ---------- the worker ----------

  let worker: UtilityProcess | null = null
  let idle: NodeJS.Timeout | null = null
  const jobs = new Map<string, { resolve(r: JobResult | null): void; cap: NodeJS.Timeout }>()

  function killWorker(): void {
    if (idle) clearTimeout(idle)
    idle = null
    const w = worker
    worker = null
    for (const [id, j] of jobs) {
      clearTimeout(j.cap)
      j.resolve(null)
      jobs.delete(id)
    }
    try {
      w?.kill()
    } catch {
      // Gone.
    }
  }

  function settle(jobId: string, r: JobResult | null): void {
    const j = jobs.get(jobId)
    if (!j) return
    clearTimeout(j.cap)
    jobs.delete(jobId)
    j.resolve(r)
    if (!jobs.size) {
      if (idle) clearTimeout(idle)
      idle = setTimeout(killWorker, L.workerIdleMs)
      idle.unref()
    }
  }

  function ensureWorker(): UtilityProcess {
    if (worker) return worker
    const w = utilityProcess.fork(workerPath(), [], { serviceName: 'notula-voiceprint', env: workerEnv() })
    w.on('message', (m: VoiceprintToMain) => {
      if (!m || typeof m !== 'object') return
      if (m.type === 'result') settle(m.jobId, m)
      else if (m.type === 'error') {
        log('warn', 'voiceprint:worker-error', { message: m.message })
        if (m.jobId) settle(m.jobId, null)
      } else if (m.type === 'log') log(m.level, m.event, m.data)
    })
    w.once('exit', (code: number) => {
      if (worker === w) {
        worker = null
        if (jobs.size) log('warn', 'voiceprint:worker-exited', { code })
        for (const id of [...jobs.keys()]) settle(id, null)
      }
    })
    worker = w
    return w
  }

  /** Runs one diarize-and-embed job; null when the model is missing or the job failed. */
  async function runJob(audio: VoiceprintAudio, audioS: number): Promise<JobResult | null> {
    if (!modelReady()) return null
    const models = getLocalModels(ctx)
    const files = models.files(MODEL)
    const pick = (name: string): VerifiedFile => files.find((f) => baseName(f.path) === name) as VerifiedFile
    const job: VoiceprintJob = {
      type: 'job',
      jobId: randomUUID(),
      files: { segmentation: pick('model.onnx'), embedding: pick('wespeaker_en_voxceleb_resnet34.onnx') },
      numThreads: Math.max(2, Math.min(4, Math.floor(cpus().length / 2))),
      windowShiftRatio: audioS <= 15 * 60 ? 0.5 : 1.0,
      clusterThreshold: CLUSTER_THRESHOLD,
      minSegmentMs: L.minSegmentMs,
      audio
    }
    const release = models.use(MODEL)
    if (idle) clearTimeout(idle)
    idle = null
    try {
      return await new Promise<JobResult | null>((resolve) => {
        const cap = setTimeout(() => {
          log('warn', 'voiceprint:job-cap', { capMs: JOB_CAP_MS })
          killWorker()
        }, JOB_CAP_MS)
        jobs.set(job.jobId, { resolve, cap })
        try {
          ensureWorker().postMessage(job)
        } catch (err) {
          log('warn', 'voiceprint:worker-start-failed', { err })
          settle(job.jobId, null)
        }
      })
    } finally {
      release()
    }
  }

  // ---------- profile updates ----------

  async function enrol(speaker: VoiceprintSpeaker & { vector: number[] }, ms: number, source: string): Promise<void> {
    const now = new Date().toISOString()
    const prev = await profile()
    const centroids = fold(prev?.centroids ?? [], speaker.vector, ms, now)
    await ctx.storage.saveVoiceprint({
      id: prev?.id ?? randomUUID(),
      model_id: VOICEPRINT_MODEL_ID,
      centroids,
      total_speech_ms: (prev?.total_speech_ms ?? 0) + ms,
      updated_at: now
    })
    profilePresent = true
    log('info', 'voiceprint:enrolled', { source, speechMs: ms, centroids: centroids.length })
  }

  // ---------- relabel ----------

  async function relabel(noteId: string, audio: TempAudio, chunks: TranscriptChunk[]): Promise<VoiceprintIdentifyResult> {
    const skipped = (reason: VoiceprintIdentifyResult['reason']): VoiceprintIdentifyResult => ({
      action: 'skipped',
      labeled: 0,
      unlabeled: 0,
      selfMatched: false,
      reason
    })
    const p = await profile()
    if (!p || !p.centroids.length) return skipped('no-profile')
    const r = await runJob({ kind: 'naud', path: audio.path, id: audio.id, key: audio.key.toString('base64') }, audio.samples / 16000)
    if (!r) return skipped('no-audio')
    const diarizedMs = r.segments.reduce((n, s) => n + (s.end - s.start) * 1000, 0)
    if (diarizedMs < L.relabelMinMs) return skipped('too-little-speech')
    if (r.speakers.length < 2) return skipped('single-speaker')
    const m = matchSelf(r.speakers, p.centroids)
    log('debug', 'voiceprint:match', { best: Number(m.best.toFixed(3)), margin: Number(m.margin.toFixed(3)), matched: m.self !== null })
    const names = labels(r.segments, m.self)
    const revised: TranscriptChunk[] = []
    let unlabeled = 0
    for (const c of chunks) {
      if (c.source !== 'microphone' || !c.is_final || !c.text.trim()) continue
      const spk = assignSpeaker(c, r.segments, audio.anchors)
      const name = spk === null ? undefined : names.get(spk)
      if (spk === null || !name) {
        unlabeled++
        continue
      }
      const detected: DetectedSpeaker = { participantId: `diarized-${spk}`, participantName: name, source: 'diarization' }
      revised.push({ ...c, detected_speaker_name: name, detectedSpeaker: detected })
    }
    if (revised.length) {
      await ctx.storage.upsertChunks(revised)
      const ev: TranscriptChanged = { noteId, upserted: revised, removedIds: [] }
      for (const wc of ctx.windows.targets()) wc.send('transcript:changed' satisfies PushChannel, ev)
      ctx.bus.emit('transcript:changed', ev)
    }
    log('info', 'voiceprint:relabelled', { noteId, labeled: revised.length, unlabeled, speakers: r.speakers.length, selfMatched: m.self !== null })
    return { action: 'relabelled', labeled: revised.length, unlabeled, selfMatched: m.self !== null, reason: m.self === null ? 'no-match' : null }
  }

  function keepForIdentify(a: TempAudio): void {
    dropKept(a.noteId)
    const expiry = setTimeout(() => dropKept(a.noteId), KEEP_FOR_IDENTIFY_MS)
    expiry.unref()
    kept.set(a.noteId, { ...a, expiry })
  }

  // ---------- after capture ----------

  async function afterSession(s: Session): Promise<void> {
    let keep = false
    try {
      if (s.writer) await s.writer.close()
      else await s.opening.catch(() => undefined).then(() => s.writer?.close())
      const all = await ctx.storage.getTranscript(s.noteId)
      const chunks = all.filter((c) => c.transcription_session_id === s.sessionId)
      const value: VoiceprintClassification = classify(chunks, s.appsSeen)
      lastClassification = { noteId: s.noteId, value, at: new Date().toISOString() }
      log('info', 'voiceprint:classified', { noteId: s.noteId, value })
      const st = await ctx.settings.getAll()
      if (!st['voiceprint.enabled'] || s.failed) return
      const p = await profile()
      if (value === 'in_person' && p?.centroids.length) {
        await relabel(s.noteId, s, chunks)
      } else if (value === 'online' && st['voiceprint.passive']) {
        const systemChunks = chunks.filter((c) => c.source === 'system' && c.is_final && c.text.trim()).length
        if (systemChunks < L.enrolMinSystemChunks) {
          log('info', 'voiceprint:enrol-skipped', { noteId: s.noteId, reason: 'few-system-chunks' })
        } else {
          const r = await runJob({ kind: 'naud', path: s.path, id: s.id, key: s.key.toString('base64') }, s.samples / 16000)
          const d = r ? dominant(r.speakers) : null
          if (d?.speaker?.vector) await enrol(d.speaker as VoiceprintSpeaker & { vector: number[] }, d.speechMs, 'online_meeting_listen')
          else log('info', 'voiceprint:enrol-skipped', { noteId: s.noteId, reason: r ? d?.reason : 'no-result' })
        }
      } else if (p?.centroids.length) {
        keep = true
      }
    } catch (err) {
      log('warn', 'voiceprint:pass-failed', { noteId: s.noteId, err })
    } finally {
      if (keep) keepForIdentify(s)
      else {
        s.key.fill(0)
        removeFile(s.path)
      }
      void push()
    }
  }

  // ---------- the tap ----------

  function openSession(noteId: string, sessionId: string): Session {
    mkdirSync(tmpDir, { recursive: true })
    const id = randomUUID()
    const s: Session = {
      noteId,
      sessionId,
      id,
      key: randomKey(),
      path: join(tmpDir, `${id}.naud`),
      anchors: [],
      writer: null,
      opening: Promise.resolve(),
      early: [],
      samples: 0,
      nextUnixMs: null,
      appsSeen: new Set(micApps),
      failed: false
    }
    s.opening = FramedWriter.create({ path: s.path, key: s.key, id })
      .then((w) => {
        s.writer = w
        for (const b of s.early) w.append(b)
        s.early = []
      })
      .catch((err: unknown) => {
        s.failed = true
        s.early = []
        log('warn', 'voiceprint:temp-open-failed', { err })
      })
    return s
  }

  ctx.audioTaps.register((f) => {
    if (f.source !== 'microphone') return
    const s = sessions.get(f.sessionId)
    if (!s || s.failed) return
    if (s.nextUnixMs === null || Math.abs(f.captureTimeMs - s.nextUnixMs) > GAP_ANCHOR_MS) s.anchors.push({ sample: s.samples, unixMs: f.captureTimeMs })
    const n = f.pcm.byteLength >> 1
    s.samples += n
    s.nextUnixMs = f.captureTimeMs + n / 16
    const copy = Buffer.from(f.pcm)
    if (s.writer) s.writer.append(copy)
    else s.early.push(copy)
  })

  ctx.bus.on('meetings:mic-apps', (e) => {
    micApps = e.apps.map((a) => a.appId)
    for (const s of sessions.values()) for (const id of micApps) s.appsSeen.add(id)
  })

  ctx.bus.on('capture:started', (e) => {
    void (async () => {
      const st = await ctx.settings.getAll()
      if (!st['voiceprint.enabled']) return
      await profile()
      if (!profilePresent && !st['voiceprint.passive']) return
      if (!sessions.has(e.sessionId)) sessions.set(e.sessionId, openSession(e.noteId, e.sessionId))
      // A new session of the note supersedes audio kept from an earlier one.
      dropKept(e.noteId)
    })().catch((err: unknown) => log('warn', 'voiceprint:session-start-failed', { err }))
  })

  ctx.bus.on('capture:stopped', (e) => {
    const s = sessions.get(e.sessionId)
    if (!s) return
    sessions.delete(e.sessionId)
    void afterSession(s)
  })

  ctx.bus.on('settings:changed', (e) => {
    if (!e.keys.includes('voiceprint.enabled') || e.settings['voiceprint.enabled']) return
    // Off: no tap, no temp audio, no worker; passive needs the feature.
    for (const s of sessions.values()) void s.writer?.abort()
    sessions.clear()
    for (const id of [...kept.keys()]) dropKept(id)
    sample?.finish('cancelled')
    killWorker()
    if (e.settings['voiceprint.passive']) void ctx.settings.set('voiceprint.passive', false)
    void push()
  })

  /** The dominant speaker of a sample (20 s, share 0.8) folds into the profile. Zeroes the PCM. */
  async function enrolSample(pcm: Buffer, durationMs: number): Promise<VoiceprintSampleResult> {
    const r = await runJob({ kind: 'pcm', pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) }, durationMs / 1000)
    pcm.fill(0)
    if (!r) return { enrolled: false, speechMs: 0, reason: 'model-missing' }
    const d = dominant(r.speakers)
    if (!d.speaker?.vector) return { enrolled: false, speechMs: d.speechMs, reason: d.reason ?? 'too-little-speech' }
    await enrol(d.speaker as VoiceprintSpeaker & { vector: number[] }, d.speechMs, 'sample')
    void push()
    return { enrolled: true, speechMs: d.speechMs, reason: null }
  }

  if (vHarnessOn()) {
    vHarness.sample = enrolSample
    vHarness.relabel = relabel
    vHarness.classify = classify
    vHarness.calibrate = async (pcm) => {
      const p = await profile()
      const r = await runJob({ kind: 'pcm', pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength) }, pcm.length / 32_000)
      if (!r || !p) return null
      return { ...matchSelf(r.speakers, p.centroids), speakers: r.speakers.length, segments: r.segments }
    }
    startVHarness(ctx)
  }

  // ---------- IPC (literal channels) ----------

  ipcMain.handle('voiceprint:get-status' satisfies InvokeChannel, (): Promise<VoiceprintStatus> => status())

  ipcMain.handle(
    'voiceprint:record-sample' satisfies InvokeChannel,
    async (e, req: InvokeReq<'voiceprint:record-sample'>): Promise<InvokeRes<'voiceprint:record-sample'>> => {
      const sessionId = typeof req?.sessionId === 'string' ? req.sessionId : ''
      const durationMs = Math.round(Number(req?.durationMs))
      if (!sessionId || !Number.isFinite(durationMs) || durationMs < 5_000 || durationMs > MAX_SAMPLE_MS) {
        throw expected(notulaError('invalid-input', 'A sample of 5 to 60 seconds is required.'))
      }
      if (!(await ctx.settings.get('voiceprint.enabled'))) throw expected(notulaError('invalid-input', 'Recognize my voice is off in Labs.'))
      const fail = (reason: VoiceprintSampleResult['reason']): VoiceprintSampleResult => ({ enrolled: false, speechMs: 0, reason })
      if (!modelReady()) return fail('model-missing')
      sample?.finish('cancelled')
      let settle!: (r: 'done' | 'cancelled' | 'timeout') => void
      const ended = new Promise<'done' | 'cancelled' | 'timeout'>((resolve) => (settle = resolve))
      const s: Sample = {
        sessionId,
        sender: e.sender,
        parts: [],
        bytes: 0,
        targetBytes: Math.round((durationMs * 16000 * 2) / 1000),
        startedAt: Date.now(),
        finish: (r) => {
          if (sample !== s) return
          clearTimeout(timer)
          sample = null
          if (r !== 'done') for (const p of s.parts) p.fill(0)
          settle(r)
        }
      }
      const timer = setTimeout(() => s.finish('timeout'), durationMs * 2 + 10_000)
      sample = s
      const outcome = await ended
      if (outcome === 'cancelled') return fail('cancelled')
      if (outcome === 'timeout') return fail('mic-error')
      const pcm = Buffer.concat(s.parts)
      for (const p of s.parts) p.fill(0)
      return enrolSample(pcm, durationMs)
    }
  )

  ipcMain.on('voiceprint:sample-audio' satisfies SendChannel, (e, msg: { sessionId?: unknown; pcm?: unknown }) => {
    const s = sample
    if (!s || e.sender !== s.sender || msg?.sessionId !== s.sessionId || !(msg.pcm instanceof Uint8Array)) return
    const room = s.targetBytes - s.bytes
    if (room <= 0) return
    const take = Math.min(room, msg.pcm.byteLength - (msg.pcm.byteLength % 2))
    const buf = Buffer.from(msg.pcm.buffer, msg.pcm.byteOffset, take)
    const copy = Buffer.from(buf)
    s.parts.push(copy)
    s.bytes += take
    const elapsedMs = Math.round((s.bytes / 32_000) * 1000)
    if (!s.sender.isDestroyed()) {
      s.sender.send('voiceprint:sample-progress' satisfies PushChannel, { sessionId: s.sessionId, elapsedMs, level: rms(copy) })
    }
    if (s.bytes >= s.targetBytes) s.finish('done')
  })

  ipcMain.on('voiceprint:cancel-sample' satisfies SendChannel, (e, msg: { sessionId?: unknown }) => {
    if (sample && e.sender === sample.sender && msg?.sessionId === sample.sessionId) sample.finish('cancelled')
  })

  ipcMain.handle(
    'voiceprint:set-passive' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'voiceprint:set-passive'>): Promise<InvokeRes<'voiceprint:set-passive'>> => {
      if (typeof req?.enabled !== 'boolean') throw expected(notulaError('invalid-input', 'On or off is required.'))
      if (req.enabled && !(await ctx.settings.get('voiceprint.enabled'))) {
        throw expected(notulaError('invalid-input', 'Turn on Recognize my voice first.'))
      }
      await ctx.settings.set('voiceprint.passive', req.enabled)
      log('info', 'voiceprint:passive', { enabled: req.enabled })
      return push()
    }
  )

  ipcMain.handle(
    'voiceprint:identify-note' satisfies InvokeChannel,
    async (_e, req: InvokeReq<'voiceprint:identify-note'>): Promise<InvokeRes<'voiceprint:identify-note'>> => {
      const noteId = typeof req?.noteId === 'string' ? req.noteId : ''
      if (!noteId) throw expected(notulaError('invalid-input', 'A note is required.'))
      if (!(await ctx.settings.get('voiceprint.enabled'))) throw expected(notulaError('invalid-input', 'Recognize my voice is off in Labs.'))
      if (ctx.capture.isCapturing() && ctx.capture.currentNoteId() === noteId) throw expected(notulaError('busy', 'Stop the transcript first'))
      const k = kept.get(noteId)
      if (!k) return { action: 'skipped', labeled: 0, unlabeled: 0, selfMatched: false, reason: 'no-audio' }
      const chunks = (await ctx.storage.getTranscript(noteId)).filter((c) => c.transcription_session_id === k.sessionId)
      lastClassification = { noteId, value: 'in_person', at: new Date().toISOString() }
      const r = await relabel(noteId, k, chunks)
      if (r.action === 'relabelled') dropKept(noteId)
      void push()
      return r
    }
  )

  ipcMain.handle('voiceprint:forget' satisfies InvokeChannel, async (): Promise<InvokeRes<'voiceprint:forget'>> => {
    const n = await ctx.storage.deleteVoiceprints()
    profilePresent = false
    for (const id of [...kept.keys()]) dropKept(id)
    log('info', 'voiceprint:forgotten', { rows: n })
    await push()
    return { ok: true }
  })
}
