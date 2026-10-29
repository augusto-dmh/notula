// SPDX-License-Identifier: Apache-2.0
// The self voice: Record my voice and the passive rule. Both add exemplars
// to the `is_self` person through the StorageApi; the note job matches them like anyone else's.
//
// - Record my voice: `voiceprint:record-sample` and the `sample-audio` / `cancel-sample` sends.
//   The renderer captures a 30 s guided sample, main holds it in memory only and the
//   notula-voiceprint worker separates and embeds it; the PCM is zeroed after use. The dominant
//   speaker (≥ 20 s, share ≥ 0.8) adds one self mic exemplar `via sample`, turns Recognize my
//   voice on, and asks for a relabel.
// - Keep improving from my online meetings (`selfPassive`, called by the note job): with
//   `speakers.selfVoice` and `speakers.selfPassive` on, in a meeting classified `online` (with
//   ≥ 3 final system chunks), the dominant mic cluster (≥ 20 s, share ≥ 0.8) adds a self
//   exemplar `via passive`, under the far-from-profile check. Never on `in_person` or `unknown`.
// - Retired with the Labs row: the mic-only second pass, the audio tap, `voiceprint-tmp/` (swept
//   once more at start), the `Me` / `Speaker N` relabel and its 1-of-1 self match.
// - Privacy: vectors stay in main, the worker port and storage; never IPC, logs or files.

import { randomUUID } from 'node:crypto'
import { cpus } from 'node:os'
import { rmSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { app, ipcMain, utilityProcess, type UtilityProcess, type WebContents } from 'electron'
import { notulaError } from '@shared/errors'
import type { InvokeChannel, InvokeReq, InvokeRes, PushChannel, SendChannel } from '@shared/ipc'
import { identityPassId } from '@shared/lib/speakers'
import { SPEAKER_PROFILE_LIMITS } from '@shared/types/speakers'
import { VOICEPRINT_LIMITS as L, type VoiceprintSampleResult } from '@shared/types/voiceprint'
import { getLocalModels, workerEnv } from '../asr/instance'
import type { VerifiedFile } from '../asr/protocol'
import { baseName } from '../asr/verify'
import type { MainContext } from '../context'
import { expected } from '../ipc-expected'
import { log } from '../log'
import { getCalibration } from '../speakers/calibration'
import { pushSpeakerPeopleChanged } from '../speakers/people-ipc'
import { requestRelabel } from '../speakers/relabel'
import { startVHarness, vHarness, vHarnessOn } from './harness'
import { classify, dominant } from './math'
import type { VoiceprintJob, VoiceprintToMain } from './protocol'

const SEPARATION = 'diarization-en' as const
const JOB_CAP_MS = 2 * 60_000
const CLUSTER_THRESHOLD = 0.5
const MAX_SAMPLE_MS = 60_000
/** Notes whose mic apps are remembered for the classification, newest last. */
const APPS_NOTES_MAX = 50

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

/** The mic apps seen while each note was captured, for `classify` (in memory only). */
const appsByNote = new Map<string, Set<string>>()

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

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

async function selfPerson(ctx: MainContext): Promise<{ id: string }> {
  return ctx.storage.ensureSelfPerson((await ctx.settings.get('profile.name')).trim() || null)
}

/** Adds one self mic exemplar; on `added`, the person page and the relabel follow. */
async function addSelfExemplar(
  ctx: MainContext,
  e: { modelId: string; vector: Float32Array; cleanMs: number; via: 'sample' | 'passive'; noteId: string | null; identityKey: string | null; farCosine: number | null }
): Promise<boolean> {
  const self = await selfPerson(ctx)
  const label = e.identityKey ? e.identityKey.slice(e.identityKey.lastIndexOf(':') + 1) : null
  const r = await ctx.storage.addSpeakerExemplar({
    personId: self.id,
    modelId: e.modelId,
    channel: 'mic',
    vector: e.vector,
    cleanMs: e.cleanMs,
    weight: Math.min(1, e.cleanMs / SPEAKER_PROFILE_LIMITS.exemplarWeightFullMs),
    sourceNoteId: e.noteId,
    sourcePassId: e.identityKey ? identityPassId(e.identityKey) : null,
    sourceLabel: label,
    spanStartMs: null,
    spanEndMs: null,
    via: e.via,
    farCosine: e.farCosine
  })
  log('info', 'voiceprint:self-exemplar', { via: e.via, status: r.status, cleanMs: e.cleanMs })
  if (r.status !== 'added') return false
  pushSpeakerPeopleChanged(ctx, self.id)
  void requestRelabel(ctx, self.id).catch((err: unknown) => log('warn', 'speakers:relabel-failed', { err: errText(err) }))
  return true
}

export function registerVoiceprint(ctx: MainContext): void {
  let sample: Sample | null = null
  let micApps: string[] = []
  const capturing = new Map<string, string>()

  // The retired mic tap's folder: anything left there is unreadable (its key lived only in
  // memory) and is never written again.
  try {
    rmSync(join(ctx.userDataPath, 'voiceprint-tmp'), { recursive: true, force: true })
  } catch (err) {
    log('warn', 'voiceprint:temp-sweep-failed', { err: errText(err) })
  }

  app.once('will-quit', () => {
    sample?.finish('cancelled')
    killWorker()
  })

  // ---------- the meeting's apps, for the online rule ----------

  function remember(noteId: string, ids: Iterable<string>): void {
    const set = appsByNote.get(noteId) ?? new Set<string>()
    for (const id of ids) set.add(id)
    appsByNote.delete(noteId)
    appsByNote.set(noteId, set)
    while (appsByNote.size > APPS_NOTES_MAX) appsByNote.delete(appsByNote.keys().next().value as string)
  }

  ctx.bus.on('meetings:mic-apps', (e) => {
    micApps = e.apps.map((a) => a.appId)
    for (const noteId of capturing.values()) remember(noteId, micApps)
  })
  ctx.bus.on('capture:started', (e) => {
    capturing.set(e.sessionId, e.noteId)
    remember(e.noteId, micApps)
  })
  ctx.bus.on('capture:stopped', (e) => {
    capturing.delete(e.sessionId)
  })

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

  /** The separation files and the identification extractor; null while either model is missing. */
  function modelFiles(): { files: VoiceprintJob['files']; modelId: string } | null {
    const models = getLocalModels(ctx)
    const id = models.speakerId()
    if (!id || !models.isReady(SEPARATION)) return null
    const files = models.files(SEPARATION)
    const pick = (name: string): VerifiedFile => files.find((f) => baseName(f.path) === name) as VerifiedFile
    return { files: { segmentation: pick('model.onnx'), embedding: pick('wespeaker_en_voxceleb_resnet34.onnx'), identification: id.file }, modelId: id.modelId }
  }

  /** Runs the sample job; null when it failed. */
  async function runJob(files: VoiceprintJob['files'], pcm: Buffer, audioS: number): Promise<JobResult | null> {
    const models = getLocalModels(ctx)
    const job: VoiceprintJob = {
      type: 'job',
      jobId: randomUUID(),
      files,
      numThreads: Math.max(2, Math.min(4, Math.floor(cpus().length / 2))),
      windowShiftRatio: audioS <= 15 * 60 ? 0.5 : 1.0,
      clusterThreshold: CLUSTER_THRESHOLD,
      minSegmentMs: L.minSegmentMs,
      pcm: new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    }
    const releases = [models.use(SEPARATION), models.use('speaker-id')]
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
          log('warn', 'voiceprint:worker-start-failed', { err: errText(err) })
          settle(job.jobId, null)
        }
      })
    } finally {
      for (const release of releases) release()
    }
  }

  /** The dominant speaker of a sample (20 s, share 0.8) becomes a self exemplar. Zeroes the PCM. */
  async function enrolSample(pcm: Buffer, durationMs: number): Promise<VoiceprintSampleResult> {
    const m = modelFiles()
    if (!m) {
      pcm.fill(0)
      return { enrolled: false, speechMs: 0, reason: 'model-missing' }
    }
    let r: JobResult | null
    try {
      r = await runJob(m.files, pcm, durationMs / 1000)
    } finally {
      pcm.fill(0)
    }
    if (!r) return { enrolled: false, speechMs: 0, reason: 'model-missing' }
    const d = dominant(r.speakers)
    const vector = d.speaker?.vector
    try {
      if (!d.speaker || !vector) return { enrolled: false, speechMs: d.speechMs, reason: d.reason ?? 'too-little-speech' }
      await addSelfExemplar(ctx, { modelId: m.modelId, vector, cleanMs: d.speaker.cleanMs, via: 'sample', noteId: null, identityKey: null, farCosine: null })
      // Recording a sample turns the row on.
      if (!(await ctx.settings.get('speakers.selfVoice'))) await ctx.settings.set('speakers.selfVoice', true)
      return { enrolled: true, speechMs: d.speechMs, reason: null }
    } finally {
      for (const s of r.speakers) s.vector?.fill(0)
    }
  }

  if (vHarnessOn()) {
    vHarness.sample = enrolSample
    vHarness.classify = classify
    startVHarness(ctx)
  }

  // ---------- IPC (literal channels) ----------

  ipcMain.handle(
    'voiceprint:record-sample' satisfies InvokeChannel,
    async (e, req: InvokeReq<'voiceprint:record-sample'>): Promise<InvokeRes<'voiceprint:record-sample'>> => {
      const sessionId = typeof req?.sessionId === 'string' ? req.sessionId : ''
      const durationMs = Math.round(Number(req?.durationMs))
      if (!sessionId || !Number.isFinite(durationMs) || durationMs < 5_000 || durationMs > MAX_SAMPLE_MS) {
        throw expected(notulaError('invalid-input', 'A sample of 5 to 60 seconds is required.'))
      }
      const fail = (reason: VoiceprintSampleResult['reason']): VoiceprintSampleResult => ({ enrolled: false, speechMs: 0, reason })
      if (!modelFiles()) return fail('model-missing')
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
}

// ---------- speaker profiles: the passive self rule ----------

/** The job's mic clusters of one pass. The vectors live only in the job's memory with only Recognize my voice on. */
export interface SelfPassiveInput {
  noteId: string
  /** The installed identification extractor's id (its SHA-256). */
  modelId: string
  micClusters: {
    identityKey: string
    /** Word time. */
    speechMs: number
    cleanMs: number
    /** The cluster's share of the mic channel's speech. */
    share: number
    vector: Float32Array | null
  }[]
}

/**
 * Called by the job after `decide`. With `speakers.selfPassive` on, in a meeting classified
 * `online`, the dominant mic cluster (≥ 20 s, share ≥ 0.8) adds a self exemplar `via passive`.
 */
export async function selfPassive(ctx: MainContext, input: SelfPassiveInput): Promise<void> {
  const settings = await ctx.settings.getAll()
  if (!settings['speakers.selfVoice'] || !settings['speakers.selfPassive']) return
  const skip = (reason: string): void => log('info', 'voiceprint:passive-skipped', { noteId: input.noteId, reason })
  const chunks = await ctx.storage.getTranscript(input.noteId)
  const value = classify(chunks, appsByNote.get(input.noteId) ?? [])
  if (value !== 'online') return skip(value)
  const systemChunks = chunks.filter((c) => c.source === 'system' && c.is_final && c.text.trim()).length
  if (systemChunks < L.enrolMinSystemChunks) return skip('few-system-chunks')
  const top = [...input.micClusters].sort((a, b) => b.speechMs - a.speechMs)[0]
  if (!top || top.speechMs < L.enrolDominantMs) return skip('too-little-speech')
  if (top.share < L.enrolShare) return skip('not-dominant')
  if (!top.vector) return skip('no-vector')
  const calibration = getCalibration(ctx).file
  await addSelfExemplar(ctx, {
    modelId: input.modelId,
    vector: top.vector,
    cleanMs: top.cleanMs,
    via: 'passive',
    noteId: input.noteId,
    identityKey: top.identityKey,
    farCosine: calibration?.farCosine.mic ?? null
  })
}
