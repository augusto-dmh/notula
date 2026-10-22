// SPDX-License-Identifier: Apache-2.0
// notula-voiceprint: the mic-only diarization pass and one speaker
// embedding per diarized speaker.
// Forked on demand by main and killed after 60 s idle. No network, no disk writes: it reads only
// the NAU1 temp file main names (with its key over the port) or the in-memory sample.
//
// sherpa-onnx: OfflineSpeakerDiarization (pyannote segmentation-3.0 + WeSpeaker ResNet-34, the same
// files as the `diarization-en` model), then SpeakerEmbeddingExtractor on each speaker's longest
// segments, averaged by duration and L2-normalized. The model files are re-verified before loading.

import { BlobIntegrityError, readFramed } from '../crypto/blobs'
import type { VoiceprintJob, VoiceprintSegment, VoiceprintSpeaker, VoiceprintToMain } from './protocol'
import { verifyFilesSync } from '../asr/verify'

const port = process.parentPort
const SAMPLE_RATE = 16000
/** Per speaker: the longest segments embedded, each cut to at most this long. */
const EMBED_SEGMENTS = 12
const EMBED_MAX_S = 8
/** Shorter segments still count as speech, but are too short for a stable embedding. */
const EMBED_MIN_S = 0.6

function send(m: VoiceprintToMain): void {
  port.postMessage(m)
}

function log(level: 'debug' | 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>): void {
  send({ type: 'log', level, event, ...(data ? { data } : {}) })
}

function toFloat(parts: Buffer[]): Float32Array {
  const total = parts.reduce((n, b) => n + (b.byteLength >> 1), 0)
  const out = new Float32Array(total)
  let at = 0
  for (const b of parts) {
    const n = b.byteLength >> 1
    for (let i = 0; i < n; i++) out[at + i] = b.readInt16LE(i * 2) / 32768
    at += n
    b.fill(0)
  }
  return out
}

async function samplesOf(job: VoiceprintJob): Promise<Float32Array> {
  if (job.audio.kind === 'pcm') {
    const pcm = job.audio.pcm
    const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2))
    return toFloat([buf])
  }
  const parts: Buffer[] = []
  try {
    const key = Buffer.from(job.audio.key, 'base64')
    for await (const pcm of readFramed({ path: job.audio.path, key, id: job.audio.id, allowTruncated: true })) parts.push(pcm)
  } catch (err) {
    const why = err instanceof BlobIntegrityError ? 'integrity' : (err as { code?: unknown }).code === 'ENOENT' ? 'missing' : 'read'
    log('warn', 'voiceprint-worker:file-unreadable', { why })
  }
  return toFloat(parts)
}

function normalize(v: Float32Array | number[]): number[] {
  let n = 0
  for (const x of v) n += x * x
  const len = Math.sqrt(n)
  return len > 0 ? Array.from(v, (x) => x / len) : Array.from(v)
}

type Sherpa = typeof import('sherpa-onnx-node')
let sherpa: Sherpa | null = null
let cache: { key: string; sd: InstanceType<Sherpa['OfflineSpeakerDiarization']>; ex: InstanceType<Sherpa['SpeakerEmbeddingExtractor']> } | null = null

function engines(job: VoiceprintJob): NonNullable<typeof cache> {
  const key = `${job.files.segmentation.sha256}:${job.files.embedding.sha256}:${job.windowShiftRatio}:${job.clusterThreshold}`
  if (cache && cache.key === key) return cache
  const problem = verifyFilesSync([job.files.segmentation, job.files.embedding])
  if (problem) throw new Error(problem)
  sherpa ??= require('sherpa-onnx-node') as Sherpa
  const sd = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: job.files.segmentation.path, windowShiftRatio: job.windowShiftRatio }, numThreads: job.numThreads, debug: 0, provider: 'cpu' },
    embedding: { model: job.files.embedding.path, numThreads: job.numThreads, debug: 0, provider: 'cpu' },
    clustering: { numClusters: -1, threshold: job.clusterThreshold },
    minDurationOn: 0.3,
    minDurationOff: 0.5
  })
  const ex = new sherpa.SpeakerEmbeddingExtractor({ model: job.files.embedding.path, numThreads: job.numThreads, debug: 0, provider: 'cpu' })
  if (sd.sampleRate !== SAMPLE_RATE) throw new Error(`unexpected model sample rate ${sd.sampleRate}`)
  cache = { key, sd, ex }
  return cache
}

function embed(ex: NonNullable<typeof cache>['ex'], samples: Float32Array, segs: VoiceprintSegment[]): number[] | null {
  const usable = segs
    .filter((s) => s.end - s.start >= EMBED_MIN_S)
    .sort((a, b) => b.end - b.start - (a.end - a.start))
    .slice(0, EMBED_SEGMENTS)
  if (!usable.length) return null
  let sum: number[] | null = null
  let weight = 0
  for (const s of usable) {
    const len = Math.min(s.end - s.start, EMBED_MAX_S)
    const mid = (s.start + s.end) / 2
    const from = Math.max(0, Math.floor((mid - len / 2) * SAMPLE_RATE))
    const to = Math.min(samples.length, Math.floor((mid + len / 2) * SAMPLE_RATE))
    if (to - from < EMBED_MIN_S * SAMPLE_RATE) continue
    const stream = ex.createStream()
    stream.acceptWaveform({ samples: samples.slice(from, to), sampleRate: SAMPLE_RATE })
    stream.inputFinished()
    if (!ex.isReady(stream)) continue
    const v = normalize(ex.compute(stream, false))
    const w = (to - from) / SAMPLE_RATE
    if (!sum) sum = v.map((x) => x * w)
    else for (let i = 0; i < sum.length; i++) sum[i] = (sum[i] as number) + (v[i] ?? 0) * w
    weight += w
  }
  return sum && weight > 0 ? normalize(sum) : null
}

async function runJob(job: VoiceprintJob): Promise<void> {
  const t = Date.now()
  const { sd, ex } = engines(job)
  const samples = await samplesOf(job)
  const audioMs = Math.round((samples.length * 1000) / SAMPLE_RATE)
  const raw = samples.length >= SAMPLE_RATE ? sd.process(samples) : []
  const minS = job.minSegmentMs / 1000
  const segments: VoiceprintSegment[] = raw
    .filter((s) => s.end - s.start >= minS)
    .map((s) => ({ start: s.start, end: s.end, speaker: s.speaker }))
    .sort((a, b) => a.start - b.start)
  const bySpeaker = new Map<number, VoiceprintSegment[]>()
  for (const s of segments) bySpeaker.set(s.speaker, [...(bySpeaker.get(s.speaker) ?? []), s])
  const speakers: VoiceprintSpeaker[] = []
  for (const [speaker, segs] of bySpeaker) {
    const speechMs = Math.round(segs.reduce((n, s) => n + (s.end - s.start) * 1000, 0))
    speakers.push({ speaker, speechMs, vector: embed(ex, samples, segs) })
  }
  samples.fill(0)
  send({ type: 'result', jobId: job.jobId, audioMs, computeMs: Date.now() - t, segments, speakers })
}

process.on('uncaughtException', (err) => send({ type: 'error', jobId: null, message: err instanceof Error ? err.message : String(err) }))

// One job at a time, in arrival order; the listener keeps the process alive until main kills it.
let chain: Promise<void> = Promise.resolve()
port.on('message', (e) => {
  const job = e.data as Partial<VoiceprintJob> | null
  if (!job || job.type !== 'job' || typeof job.jobId !== 'string' || !job.files || !job.audio) return
  const jobId = job.jobId
  chain = chain
    .then(() => runJob(job as VoiceprintJob))
    .catch((err: unknown) => send({ type: 'error', jobId, message: err instanceof Error ? err.message : String(err) }))
})
