// SPDX-License-Identifier: Apache-2.0
// notula-voiceprint: Record my voice's guided sample. It separates the
// speakers of the in-memory sample and gives each one an identification vector.
// Forked on demand by main and killed after 60 s idle. No network, no disk reads or writes
// beyond the model files: the sample arrives over the port and is zeroed after use.
//
// sherpa-onnx: OfflineSpeakerDiarization (pyannote segmentation-3.0 + WeSpeaker ResNet-34, the
// `diarization-en` files) separates the speakers. Each speaker's vector comes from the
// `speaker-id` SpeakerEmbeddingExtractor over the clean spans (`clean-spans.ts`), exactly as the note job's
// cluster vectors do (`asr/diarize-worker.ts`), so a sample lands in the same voice space. The
// model files are re-verified before loading.

import { SPEAKER_PROFILE_LIMITS } from '@shared/types/speakers'
import { cleanSpans, spanSeconds, type CleanSpan } from '../asr/clean-spans'
import type { DiarizeSegment } from '../asr/protocol'
import { verifyFilesSync } from '../asr/verify'
import type { VoiceprintJob, VoiceprintSpeaker, VoiceprintToMain } from './protocol'

const port = process.parentPort
const SAMPLE_RATE = 16000

function send(m: VoiceprintToMain): void {
  port.postMessage(m)
}

function toFloat(pcm: Uint8Array): Float32Array {
  const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength - (pcm.byteLength % 2))
  const n = buf.byteLength >> 1
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768
  buf.fill(0)
  return out
}

function normalized(v: Float32Array | Float64Array): Float32Array {
  let n = 0
  for (const x of v) n += x * x
  const len = Math.sqrt(n)
  return Float32Array.from(v, (x) => (len > 0 ? x / len : x))
}

type Sherpa = typeof import('sherpa-onnx-node')
type Extractor = InstanceType<Sherpa['SpeakerEmbeddingExtractor']>
let sherpa: Sherpa | null = null
let cache: { key: string; sd: InstanceType<Sherpa['OfflineSpeakerDiarization']>; ex: Extractor } | null = null

function engines(job: VoiceprintJob): NonNullable<typeof cache> {
  const f = job.files
  const key = `${f.segmentation.sha256}:${f.embedding.sha256}:${f.identification.sha256}:${job.windowShiftRatio}:${job.clusterThreshold}`
  if (cache && cache.key === key) return cache
  const problem = verifyFilesSync([f.segmentation, f.embedding, f.identification])
  if (problem) throw new Error(problem)
  sherpa ??= require('sherpa-onnx-node') as Sherpa
  const sd = new sherpa.OfflineSpeakerDiarization({
    segmentation: { pyannote: { model: f.segmentation.path, windowShiftRatio: job.windowShiftRatio }, numThreads: job.numThreads, debug: 0, provider: 'cpu' },
    embedding: { model: f.embedding.path, numThreads: job.numThreads, debug: 0, provider: 'cpu' },
    clustering: { numClusters: -1, threshold: job.clusterThreshold },
    minDurationOn: 0.3,
    minDurationOff: 0.5
  })
  const ex = new sherpa.SpeakerEmbeddingExtractor({ model: f.identification.path, numThreads: job.numThreads, debug: 0, provider: 'cpu' })
  if (sd.sampleRate !== SAMPLE_RATE) throw new Error(`unexpected model sample rate ${sd.sampleRate}`)
  cache = { key, sd, ex }
  return cache
}

/** A span's clean pieces back to back (the gaps the selector joined are left out). */
function spanSamples(samples: Float32Array, s: CleanSpan): Float32Array {
  const ranges = s.pieces
    .map((p) => [Math.max(0, Math.floor(p.start * SAMPLE_RATE)), Math.min(samples.length, Math.floor(p.end * SAMPLE_RATE))] as const)
    .filter(([from, to]) => to > from)
  const out = new Float32Array(ranges.reduce((n, [from, to]) => n + to - from, 0))
  let at = 0
  for (const [from, to] of ranges) {
    out.set(samples.subarray(from, to), at)
    at += to - from
  }
  return out
}

/** Each span embedded and L2-normalized, their mean weighted by duration, normalized again. */
function speakerVector(ex: Extractor, samples: Float32Array, spans: readonly CleanSpan[]): Float32Array | null {
  let sum: Float64Array | null = null
  let weight = 0
  for (const s of spans) {
    const piece = spanSamples(samples, s)
    if (!piece.length) continue
    const stream = ex.createStream()
    stream.acceptWaveform({ samples: piece, sampleRate: SAMPLE_RATE })
    stream.inputFinished()
    const w = piece.length / SAMPLE_RATE
    piece.fill(0)
    if (!ex.isReady(stream)) continue
    const v = normalized(ex.compute(stream, false))
    sum ??= new Float64Array(v.length)
    for (let i = 0; i < sum.length; i++) sum[i] = (sum[i] as number) + (v[i] as number) * w
    weight += w
  }
  return sum && weight > 0 ? normalized(sum) : null
}

function runJob(job: VoiceprintJob): void {
  const t = Date.now()
  const { sd, ex } = engines(job)
  const samples = toFloat(job.pcm)
  const audioMs = Math.round((samples.length * 1000) / SAMPLE_RATE)
  const raw = samples.length >= SAMPLE_RATE ? sd.process(samples) : []
  const minS = job.minSegmentMs / 1000
  const segments: DiarizeSegment[] = raw
    .filter((s) => s.end - s.start >= minS)
    .map((s) => ({ start: s.start, end: s.end, speaker: s.speaker }))
    .sort((a, b) => a.start - b.start)
  const spans = cleanSpans(segments, [])
  const speakers: VoiceprintSpeaker[] = []
  for (const speaker of [...new Set(segments.map((s) => s.speaker))].sort((a, b) => a - b)) {
    const speechMs = Math.round(segments.reduce((n, s) => n + (s.speaker === speaker ? (s.end - s.start) * 1000 : 0), 0))
    const mine = spans.filter((s) => s.speaker === speaker)
    const cleanMs = Math.round(mine.reduce((n, s) => n + spanSeconds(s) * 1000, 0))
    const vector = cleanMs >= SPEAKER_PROFILE_LIMITS.vectorMinCleanMs ? speakerVector(ex, samples, mine) : null
    speakers.push({ speaker, speechMs, cleanMs, vector })
  }
  samples.fill(0)
  send({ type: 'result', jobId: job.jobId, audioMs, computeMs: Date.now() - t, speakers })
}

process.on('uncaughtException', (err) => send({ type: 'error', jobId: null, message: err instanceof Error ? err.message : String(err) }))

// One job at a time, in arrival order; the listener keeps the process alive until main kills it.
let chain: Promise<void> = Promise.resolve()
port.on('message', (e) => {
  const job = e.data as Partial<VoiceprintJob> | null
  if (!job || job.type !== 'job' || typeof job.jobId !== 'string' || !job.files || !(job.pcm instanceof Uint8Array)) return
  const jobId = job.jobId
  chain = chain
    .then(() => runJob(job as VoiceprintJob))
    .catch((err: unknown) => send({ type: 'error', jobId, message: err instanceof Error ? err.message : String(err) }))
})
