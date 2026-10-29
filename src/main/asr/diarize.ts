// SPDX-License-Identifier: Apache-2.0
// On-device speaker diarization. Off by default (`transcription.diarization`).
//
// - Recording: while it is on, each session tees its sources' 16 kHz s16le batches
//   into `<userData>/tmp/<noteId>/<sessionId>-<source>.naud`. Capture gaps are filled
//   with silence, so file time stays aligned with wall-clock time.
// - Encryption at rest: the temp files are NAU1,
//   each with its own random key and id held only in this process's memory. The pass
//   hands the keys to its worker over the process port, never on the command line. A
//   file left over by a crash has no key anywhere: it is unreadable, and startup
//   deletes it.
// - Pass: when the note's capture stops, one notula-diarize process runs sherpa-onnx
//   OfflineSpeakerDiarization over all of the note's recorded audio, one source at a
//   time, in the background. Compute is capped at 10 min: on the cap
//   the pass is skipped and logged.
// - Mapping: every final word takes `merged_spk = r<N>` from the turn holding its
//   midpoint, or the nearest turn within 0.5 s, and the chunk carries the
//   pass's `mergeScopeId`.
// - Speaker profiles: the pass is step 1 of the note's post-meeting job
//   (`speakers/job.ts`, set with `setJob`). The job picks the embed mode at the start; after
//   diarization the worker sends `embedding-started`, and from then on the 10 min cap is
//   replaced by the 2 min embedding cap. On that cap, or a worker crash while embedding, the
//   turns and the clusters already reported are kept. The finished pass goes to the job,
//   which writes its `merged_spk` patch through the note's label-write queue. The job runs
//   inside the pass, so `awaitPass` covers it. Each file goes to the worker with its timing,
//   so the mic's echo cut compares the two channels in capture time. A job
//   abandoned by a resume cancels its worker (`cancel`); the next stop runs the pass again.
// - Retention: the audio stays only so a resumed note gets one consistent pass over
//   all its sessions, so its speaker letters stay consistent. It is deleted 2 h after the
//   note's last pass, when more than 8 notes hold audio, at quit, and at startup.
//   Nothing leaves the machine.

import { randomUUID } from 'node:crypto'
import { cpus } from 'node:os'
import { mkdirSync, readdirSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, utilityProcess, type UtilityProcess } from 'electron'
import type { AudioSource } from '@shared/types/common'
import type { TranscriptChunk } from '@shared/types/transcript'
import { FramedWriter, randomKey } from '../crypto/blobs'
import { log } from '../log'
import { workerEnv, workerPath } from './instance'
import { SPEAKER_PROFILE_LIMITS } from '@shared/types/speakers'
import { cleanSpans, echoOnMic, spanSeconds } from './clean-spans'
import type { LocalModelManager } from './models'
import type { DiarizeCluster, DiarizeEmbedMode, DiarizeInput, DiarizeSegment, DiarizeToMain, DiarizeWorkerArgs, VerifiedFile } from './protocol'
import { baseName } from './verify'

const MODEL = 'diarization-en' as const
const SAMPLES_PER_MS = 16
/** A gap longer than this is written as silence. */
const GAP_FILL_MIN_MS = 200
/** Longer gaps are cut to this, and the cut is recorded so mapping stays aligned. */
const GAP_FILL_MAX_MS = 10 * 60_000
/** The pass's compute cap (diarization only; embedding has its own). */
export const PASS_CAP_MS = 10 * 60_000
/**
 * How long a wait for a note's speaker labels lasts (enhance at stop, and the post-meeting
 * job's own wait): the pass cap, the embedding cap and the LLM step.
 */
export const SPEAKER_LABELS_WAIT_MS = PASS_CAP_MS + SPEAKER_PROFILE_LIMITS.embeddingCapMs + SPEAKER_PROFILE_LIMITS.llmTimeoutMs
const EMBED_CAP_MS = SPEAKER_PROFILE_LIMITS.embeddingCapMs
/** A word maps to the nearest turn within 0.5 s (8,000 samples). */
const NEAREST_TURN_S = 0.5
const KEEP_AFTER_PASS_MS = 2 * 3_600_000
const MAX_NOTES_WITH_AUDIO = 8
const CLUSTER_THRESHOLD = 0.5
/**
 * pyannote steps its 10 s window by this share. Measured on a two-voice
 * 50 s sample: 0.1 → 225 s of compute, 0.5 → 39 s, 1.0 → 12.6 s (4 threads),
 * with the same turns. Up to 15 min of audio uses 0.5; longer notes use 1.0, so an
 * hour fits the 10 min cap.
 */
const SHIFT_SHORT = 0.5
const SHIFT_LONG = 1.0
const SHORT_AUDIO_S = 15 * 60
const FILE_NAME = /^[0-9a-f-]{36}-(microphone|system)\.(naud|pcm|json)$/

/** Wall-clock time left out of a file: a capture gap longer than the fill cap. */
export interface FileCut {
  /** Capture time where the file resumes after the gap. */
  atEpochMs: number
  lostMs: number
}

/** One source's recorded audio for one session: an NAU1 file and its in-memory key. */
export interface RecordedFile {
  sessionId: string
  source: AudioSource
  path: string
  /** The NAU1 file id (a UUID bound into every frame). */
  id: string
  /** The file's key; never written anywhere. */
  key: Buffer
  baseEpochMs: number
  samples: number
  cuts: FileCut[]
}

interface OpenFile {
  /** Null until `FramedWriter.create` resolves; audio waits in `queue` meanwhile. */
  writer: FramedWriter | null
  opening: Promise<void>
  queue: Buffer[]
  failed: boolean
  path: string
  meta: string
  id: string
  key: Buffer
  baseEpochMs: number
  samples: number
  cuts: FileCut[]
}

/** Seconds into a file for a capture time, leaving out the cut gaps before it. */
export function fileSeconds(file: Pick<RecordedFile, 'baseEpochMs' | 'cuts'>, unixMs: number): number {
  let lost = 0
  for (const c of file.cuts) if (c.atEpochMs <= unixMs) lost += c.lostMs
  return (unixMs - file.baseEpochMs - lost) / 1000
}

/** The per-session tee. */
export class AudioRecorder {
  private readonly files: Partial<Record<AudioSource, OpenFile>> = {}
  private closed = false

  constructor(
    private readonly dir: string,
    private readonly sessionId: string
  ) {}

  write(source: AudioSource, pcm: Buffer, captureTimeMs: number): void {
    if (this.closed || !pcm.byteLength) return
    let f = this.files[source]
    try {
      if (!f) f = this.open(source, captureTimeMs)
      if (f.failed) return
      const lostSoFar = f.cuts.reduce((n, c) => n + c.lostMs, 0)
      const gapMs = captureTimeMs - (f.baseEpochMs + lostSoFar + f.samples / SAMPLES_PER_MS)
      if (gapMs > GAP_FILL_MIN_MS) {
        const fillMs = Math.min(gapMs, GAP_FILL_MAX_MS)
        const fill = Math.round(fillMs * SAMPLES_PER_MS)
        this.append(f, Buffer.alloc(fill * 2))
        f.samples += fill
        if (gapMs > fillMs) f.cuts.push({ atEpochMs: captureTimeMs, lostMs: gapMs - fillMs })
      }
      // The writer may hold the buffer until its next frame: never the caller's copy.
      this.append(f, Buffer.from(pcm))
      f.samples += pcm.byteLength >> 1
    } catch (err) {
      log('warn', 'asr:diarize-tee-failed', { source, err })
    }
  }

  private open(source: AudioSource, captureTimeMs: number): OpenFile {
    mkdirSync(this.dir, { recursive: true })
    const f: OpenFile = {
      writer: null,
      opening: Promise.resolve(),
      queue: [],
      failed: false,
      path: join(this.dir, `${this.sessionId}-${source}.naud`),
      meta: join(this.dir, `${this.sessionId}-${source}.json`),
      id: randomUUID(),
      key: randomKey(),
      baseEpochMs: captureTimeMs,
      samples: 0,
      cuts: []
    }
    f.opening = FramedWriter.create({ path: f.path, key: f.key, id: f.id }).then(
      (w) => {
        f.writer = w
        for (const b of f.queue.splice(0)) w.append(b)
      },
      (err: unknown) => {
        f.failed = true
        f.queue = []
        log('warn', 'asr:diarize-tee-failed', { source, err })
      }
    )
    this.files[source] = f
    this.writeMeta(source, f)
    return f
  }

  private append(f: OpenFile, pcm: Buffer): void {
    if (f.writer) f.writer.append(pcm)
    else f.queue.push(pcm)
  }

  /** Ends the files; resolves with what was recorded. */
  async close(): Promise<RecordedFile[]> {
    if (this.closed) return []
    this.closed = true
    const out: RecordedFile[] = []
    for (const source of ['microphone', 'system'] as const) {
      const f = this.files[source]
      if (!f) continue
      await f.opening
      if (!f.writer || f.failed) continue
      try {
        await f.writer.close()
      } catch (err) {
        log('warn', 'asr:diarize-tee-failed', { source, err })
        continue
      }
      this.writeMeta(source, f)
      out.push({
        sessionId: this.sessionId,
        source,
        path: f.path,
        id: f.id,
        key: f.key,
        baseEpochMs: f.baseEpochMs,
        samples: f.samples,
        cuts: f.cuts
      })
    }
    return out
  }

  private writeMeta(source: AudioSource, f: OpenFile): void {
    try {
      writeFileSync(
        f.meta,
        JSON.stringify({ sessionId: this.sessionId, source, baseEpochMs: f.baseEpochMs, samples: f.samples, cuts: f.cuts, sampleRate: 16000 })
      )
    } catch {
      // The meta file only helps a human; the pass uses memory.
    }
  }
}

interface NoteAudio {
  files: RecordedFile[]
  running: Promise<void> | null
  again: boolean
  expiry: NodeJS.Timeout | null
  touched: number
}

export interface DiarizationDeps {
  userDataPath: string
  models: LocalModelManager
}

/** What the job asks the pass to embed. `identification` is null with mode `none`. */
export interface DiarizeEmbedPlan {
  mode: DiarizeEmbedMode
  identification: VerifiedFile | null
}

/** One finished pass, handed to the post-meeting job. Vectors stay in main. */
export interface DiarizePass {
  passId: string
  /** Turns per source (`microphone`, `system`), in seconds into the source's audio. */
  turns: ReadonlyMap<string, readonly DiarizeSegment[]>
  /** The identification result per `r<N>`; empty without embedding. */
  clusters: ReadonlyMap<string, DiarizeCluster>
  /** Clean speech per `r<N>`, computed in main for every cluster. */
  cleanMs: ReadonlyMap<string, number>
  /** True when the pass maps this chunk's words (a final chunk with words of a recorded session). */
  covers(chunk: TranscriptChunk): boolean
  /** The `r<N>` of a covered chunk's word, or null when no turn is near it. */
  labelOf(chunk: TranscriptChunk, wordIndex: number): string | null
}

/** The post-meeting job's side of the pass (`speakers/job.ts`). */
export interface DiarizeJob {
  /** A pass is about to run for the note (job state `queued`). */
  queued(noteId: string): void
  /** At the pass's start (state `diarizing`): what to embed. */
  plan(noteId: string): Promise<DiarizeEmbedPlan>
  /** The rest of the job; null when the pass produced nothing (`reason` is a code). */
  run(noteId: string, pass: DiarizePass | null, reason?: string): Promise<void>
}

interface WorkerOutcome {
  turns: Map<string, DiarizeSegment[]>
  clusters: DiarizeCluster[]
}

/** Index of the turn holding `t`, else the nearest within 0.5 s, else -1. Turns sorted by start. */
export function turnAt(turns: readonly DiarizeSegment[], t: number): number {
  let lo = 0
  let hi = turns.length - 1
  let last = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if ((turns[mid] as DiarizeSegment).start <= t) {
      last = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  // Overlapping turns: the latest-starting one that still contains t.
  for (let i = last; i >= 0 && i > last - 4; i--) {
    const s = turns[i] as DiarizeSegment
    if (s.start <= t && t <= s.end) return i
  }
  let best = -1
  let bestGap = NEAREST_TURN_S
  for (const i of [last, last + 1]) {
    const s = turns[i]
    if (!s) continue
    const gap = t < s.start ? s.start - t : t - s.end
    if (gap <= bestGap) {
      bestGap = gap
      best = i
    }
  }
  return best
}

export class DiarizationService {
  private readonly notes = new Map<string, NoteAudio>()
  /** Ends the note's running worker (the pass then fails, or keeps what embedding reported). */
  private readonly cancels = new Map<string, () => void>()
  private quitting = false
  private job: DiarizeJob | null = null

  constructor(private readonly deps: DiarizationDeps) {}

  /** Set once by `registerSpeakerJob`. */
  setJob(job: DiarizeJob): void {
    this.job = job
  }

  tmpDir(noteId: string): string {
    return join(this.deps.userDataPath, 'tmp', noteId)
  }

  recorder(noteId: string, sessionId: string): AudioRecorder {
    this.note(noteId).touched = Date.now()
    return new AudioRecorder(this.tmpDir(noteId), sessionId)
  }

  /** A session ended (any reason): its audio joins the note's next pass. */
  sessionClosed(noteId: string, files: RecordedFile[]): void {
    if (!files.length) return
    const n = this.note(noteId)
    n.files.push(...files.filter((f) => f.samples > 0))
    n.touched = Date.now()
    this.evict()
  }

  /** The note's capture stopped: one pass over all of its recorded audio, in the background. */
  noteStopped(noteId: string): void {
    const n = this.notes.get(noteId)
    if (!n || !n.files.length || this.quitting) return
    if (n.expiry) clearTimeout(n.expiry)
    n.expiry = null
    const willRun = this.deps.models.isReady(MODEL)
    if (n.running) {
      n.again = true
      if (willRun) this.job?.queued(noteId)
      return
    }
    if (willRun) this.job?.queued(noteId)
    n.running = this.pass(noteId, n)
      .catch(async (err: unknown) => {
        log('warn', 'asr:diarize-failed', { noteId, err })
        // The job ends too (and lets go of the model it held).
        await this.job?.run(noteId, null, 'pass-error').catch(() => undefined)
      })
      .finally(() => {
        n.running = null
        if (n.again && !this.quitting) {
          n.again = false
          this.noteStopped(noteId)
          return
        }
        n.expiry = setTimeout(() => this.drop(noteId), KEEP_AFTER_PASS_MS)
      })
  }

  /** The note's job was abandoned (a resume): its worker stops now instead of running to its cap. */
  cancel(noteId: string): void {
    this.cancels.get(noteId)?.()
  }

  /** Resolves when the note has no diarization pass running, including a queued re-run. */
  async awaitPass(noteId: string): Promise<void> {
    const n = this.notes.get(noteId)
    while (n?.running) await n.running
  }

  /**
   * The note's diarization temp audio while it still exists (about 2 h after its pass), for
   * clips. Null when there is none. The keys never leave main.
   */
  tempAudioFor(noteId: string): readonly RecordedFile[] | null {
    const n = this.notes.get(noteId)
    return n?.files.length ? n.files : null
  }

  /** A stop or `ensureJob` would run a pass for the note: its temp audio still exists. */
  willRunPass(noteId: string): boolean {
    return !this.quitting && !!this.notes.get(noteId)?.files.length
  }

  /** At startup: temp audio left over from an earlier run is deleted. */
  cleanupStale(): void {
    const root = join(this.deps.userDataPath, 'tmp')
    let dirs: string[] = []
    try {
      dirs = readdirSync(root)
    } catch {
      return
    }
    let removed = 0
    for (const d of dirs) {
      const dir = join(root, d)
      let names: string[] = []
      try {
        names = readdirSync(dir)
      } catch {
        continue
      }
      for (const name of names) {
        if (!FILE_NAME.test(name)) continue
        try {
          rmSync(join(dir, name), { force: true })
          removed++
        } catch {
          // Next startup.
        }
      }
      removeIfEmpty(dir)
    }
    if (removed) log('info', 'asr:diarize-stale-removed', { files: removed })
  }

  /** At quit: every note's temp audio goes. */
  cleanupAll(): void {
    this.quitting = true
    for (const id of [...this.notes.keys()]) this.drop(id)
  }

  private note(noteId: string): NoteAudio {
    let n = this.notes.get(noteId)
    if (!n) {
      n = { files: [], running: null, again: false, expiry: null, touched: Date.now() }
      this.notes.set(noteId, n)
    }
    return n
  }

  /** More than 8 notes with audio: the least recently used idle one is dropped. */
  private evict(): void {
    if (this.notes.size <= MAX_NOTES_WITH_AUDIO) return
    const idle = [...this.notes.entries()].filter(([, n]) => !n.running).sort((a, b) => a[1].touched - b[1].touched)
    for (const [id] of idle) {
      if (this.notes.size <= MAX_NOTES_WITH_AUDIO) break
      this.drop(id)
    }
  }

  private drop(noteId: string): void {
    const n = this.notes.get(noteId)
    if (!n || n.running) return
    if (n.expiry) clearTimeout(n.expiry)
    this.notes.delete(noteId)
    for (const f of n.files) {
      try {
        rmSync(f.path, { force: true })
        rmSync(f.path.replace(/\.naud$/, '.json'), { force: true })
      } catch {
        // Startup cleanup removes it.
      }
    }
    removeIfEmpty(this.tmpDir(noteId))
    log('info', 'asr:diarize-audio-deleted', { noteId, files: n.files.length })
  }

  private async pass(noteId: string, n: NoteAudio): Promise<void> {
    const files = [...n.files].sort((a, b) => a.baseEpochMs - b.baseEpochMs)
    const job = this.job
    if (!this.deps.models.isReady(MODEL)) {
      log('info', 'asr:diarize-skipped', { noteId, reason: 'model-missing' })
      // A job queued at the stop ends here: the model went between the stop and the pass.
      await job?.run(noteId, null, 'model-missing')
      return
    }
    if (!job) {
      log('warn', 'asr:diarize-skipped', { noteId, reason: 'no-job' })
      return
    }
    const inputs: DiarizeInput[] = []
    const offsets = new Map<string, { offsetSec: number; file: RecordedFile }>()
    const bySource = new Map<string, RecordedFile[]>()
    // System first, so its speakers take the lower numbers.
    for (const source of ['system', 'microphone'] as const) {
      const mine = files.filter((f) => f.source === source)
      if (!mine.length) continue
      bySource.set(source, mine)
      let at = 0
      for (const f of mine) {
        offsets.set(`${f.sessionId}:${source}`, { offsetSec: at / 16000, file: f })
        at += f.samples
      }
      inputs.push({
        key: source,
        files: mine.map((f) => ({
          path: f.path,
          id: f.id,
          key: f.key.toString('base64'),
          timing: { baseEpochMs: f.baseEpochMs, samples: f.samples, cuts: f.cuts }
        }))
      })
    }
    const plan = await job.plan(noteId).catch((err: unknown): DiarizeEmbedPlan => {
      log('warn', 'asr:diarize-plan-failed', { noteId, err })
      return { mode: 'none', identification: null }
    })
    const started = Date.now()
    const audioS = files.reduce((n, f) => n + f.samples, 0) / 16000
    const outcome = await this.runWorker(noteId, inputs, audioS <= SHORT_AUDIO_S ? SHIFT_SHORT : SHIFT_LONG, plan)
    if (!outcome) {
      await job.run(noteId, null, 'pass-failed')
      return
    }
    try {
      await this.finishPass(noteId, files, outcome, offsets, bySource, started, job)
    } finally {
      // The job zeroes them when it ends; this covers a throw before it got them.
      for (const c of outcome.clusters) c.vector?.fill(0)
    }
  }

  /** The worker's turns and clusters as the job's pass. */
  private async finishPass(
    noteId: string,
    files: readonly RecordedFile[],
    outcome: WorkerOutcome,
    offsets: ReadonlyMap<string, { offsetSec: number; file: RecordedFile }>,
    bySource: ReadonlyMap<string, RecordedFile[]>,
    started: number,
    job: DiarizeJob
  ): Promise<void> {
    const results = outcome.turns
    const passId = randomUUID()
    // r<N> numbers are unique across the note's sources.
    const ids = new Map<string, number>()
    const label = (source: string, speaker: number): string => {
      const key = `${source}:${speaker}`
      let r = ids.get(key)
      if (r === undefined) {
        r = ids.size
        ids.set(key, r)
      }
      return `r${r}`
    }
    for (const source of ['system', 'microphone']) {
      for (const s of [...(results.get(source) ?? [])].sort((a, b) => a.start - b.start)) label(source, s.speaker)
    }
    const clusters = new Map<string, DiarizeCluster>()
    for (const c of outcome.clusters) if (ids.has(`${c.source}:${c.label}`)) clusters.set(label(c.source, c.label), c)
    const cleanMs = new Map<string, number>()
    for (const [source, turns] of results) {
      // The worker's echo cut: system speech on the mic's timeline.
      const other = source === 'microphone' ? echoOnMic(results.get('system') ?? [], bySource.get('system') ?? [], bySource.get('microphone') ?? []) : []
      for (const span of cleanSpans(turns, other)) {
        const r = label(source, span.speaker)
        cleanMs.set(r, (cleanMs.get(r) ?? 0) + Math.round(spanSeconds(span) * 1000))
      }
    }
    const placed = (c: TranscriptChunk): { at: { offsetSec: number; file: RecordedFile }; turns: DiarizeSegment[] } | null => {
      const at = offsets.get(`${c.transcription_session_id}:${c.source}`)
      const turns = results.get(c.source)
      return c.is_final && c.providerDetails?.words.length && at && turns ? { at, turns } : null
    }
    const pass: DiarizePass = {
      passId,
      turns: results,
      clusters,
      cleanMs,
      covers: (c) => placed(c) !== null,
      labelOf: (c, i) => {
        const p = placed(c)
        const d = c.providerDetails
        const w = d?.words[i]
        if (!p || !d || !w) return null
        const mid = d.wallClockAnchorMs + (w.s_ms + w.e_ms) / 2
        const t = p.at.offsetSec + fileSeconds(p.at.file, mid)
        const turn = turnAt(p.turns, t)
        return turn >= 0 ? label(c.source, (p.turns[turn] as DiarizeSegment).speaker) : null
      }
    }
    log('info', 'asr:diarize-done', {
      noteId,
      passId,
      speakers: ids.size,
      clusters: clusters.size,
      files: files.length,
      ms: Date.now() - started
    })
    await job.run(noteId, pass)
  }

  private runWorker(noteId: string, inputs: DiarizeInput[], windowShiftRatio: number, plan: DiarizeEmbedPlan): Promise<WorkerOutcome | null> {
    const files = this.deps.models.files(MODEL)
    const pick = (name: string): VerifiedFile => files.find((f) => baseName(f.path) === name) as VerifiedFile
    const args: DiarizeWorkerArgs = {
      files: { segmentation: pick('model.onnx'), embedding: pick('wespeaker_en_voxceleb_resnet34.onnx') },
      // Speaker profiles: the identification embedding per cluster, as the job asked.
      identification: plan.mode === 'none' ? null : plan.identification,
      embedMode: plan.identification ? plan.mode : 'none',
      // The pass runs after the meeting, so it may use more of the machine.
      numThreads: Math.max(2, Math.min(4, Math.floor(cpus().length / 2))),
      threshold: CLUSTER_THRESHOLD,
      windowShiftRatio,
      inputs
    }
    const release = this.deps.models.use(MODEL)
    return new Promise((resolve) => {
      const results = new Map<string, DiarizeSegment[]>()
      const clusters: DiarizeCluster[] = []
      let proc: UtilityProcess | null = null
      let settled = false
      // Set by `embedding-started`: diarization is done, and a failure from here keeps it.
      let embedding = false
      const finish = (ok: boolean, why?: string): void => {
        if (settled) return
        settled = true
        if (this.cancels.get(noteId) === cancel) this.cancels.delete(noteId)
        clearTimeout(cap)
        try {
          proc?.kill()
        } catch {
          // Already gone.
        }
        release()
        if (!ok && embedding) {
          // The job continues without voice for the clusters not reported yet.
          log('warn', 'asr:diarize-embed-ended', { noteId, reason: why ?? 'unknown', clusters: clusters.length })
          ok = true
        } else if (!ok) log('warn', 'asr:diarize-pass-failed', { noteId, reason: why ?? 'unknown' })
        resolve(ok ? { turns: results, clusters } : null)
      }
      const cancel = (): void => finish(false, 'cancelled')
      this.cancels.set(noteId, cancel)
      let cap = setTimeout(() => {
        // On the compute cap, skip diarization for this note and log it.
        log('warn', 'asr:diarize-cap', { noteId, capMs: PASS_CAP_MS })
        finish(false, 'compute cap reached')
      }, PASS_CAP_MS)
      try {
        // No arguments: the job carries the temp files' keys, so it goes over the port.
        proc = utilityProcess.fork(workerPath('diarize'), [], {
          serviceName: 'notula-diarize',
          env: workerEnv()
        })
      } catch (err) {
        finish(false, err instanceof Error ? err.message : String(err))
        return
      }
      const child = proc
      child.once('spawn', () => {
        try {
          child.postMessage({ type: 'start', args })
        } catch (err) {
          finish(false, err instanceof Error ? err.message : String(err))
        }
      })
      proc.on('message', (m: DiarizeToMain) => {
        if (!m || typeof m !== 'object') return
        switch (m.type) {
          case 'result':
            results.set(m.key, m.segments)
            log('info', 'asr:diarize-source', {
              noteId,
              source: m.key,
              turns: m.segments.length,
              speakers: new Set(m.segments.map((s) => s.speaker)).size,
              audioMs: m.audioMs,
              computeMs: m.computeMs
            })
            return
          case 'embedding-started':
            // The 10 min cap covered diarization; embedding runs under its own 2 min cap.
            embedding = true
            clearTimeout(cap)
            cap = setTimeout(() => {
              log('warn', 'asr:diarize-embed-cap', { noteId, capMs: EMBED_CAP_MS })
              finish(false, 'embedding cap reached')
            }, EMBED_CAP_MS)
            return
          case 'cluster':
            // Never logged: it carries the vector.
            clusters.push(m.cluster)
            return
          case 'done':
            finish(true)
            return
          case 'error':
            finish(false, m.message)
            return
          case 'log':
            log(m.level, m.event, { noteId, ...(m.data ?? {}) })
            return
        }
      })
      proc.once('exit', (code: number) => finish(false, `exited (${code})`))
    })
  }
}

function removeIfEmpty(dir: string): void {
  try {
    if (!readdirSync(dir).length) rmdirSync(dir)
  } catch {
    // Not there, or not empty.
  }
}

/** Deletes leftover temp audio at quit (best effort; startup cleans the rest). */
export function cleanupOnQuit(service: DiarizationService): void {
  app.once('will-quit', () => service.cleanupAll())
}
