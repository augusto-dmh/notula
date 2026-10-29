// SPDX-License-Identifier: Apache-2.0
// The notula-diarize utility process entry, built to out/main/diarize.js
// and forked for one offline diarization pass per note after stop. It reads only the
// session's temp audio files and writes only its result messages. No network.
//
// The temp files are NAU1, encrypted at rest. The job, with each
// file's key, arrives as the first port message (`start`), never on the command line;
// the plaintext exists only in this process's memory.
//
// sherpa-onnx OfflineSpeakerDiarization: pyannote segmentation-3.0 + WeSpeaker
// ResNet-34 embeddings + its built-in clustering, one source at a time. The model
// files are re-verified before loading, as the ASR worker does. Main
// enforces the 10 min compute cap by killing this process.
//
// Speaker profiles: when main asks (`embedMode` `all` or `mic`, with the `speaker-id`
// extractor ready), diarization of every input is followed by `embedding-started` and one
// `cluster` message per cluster: its clean spans (`clean-spans.ts`) embedded with a second
// SpeakerEmbeddingExtractor, each L2-normalized, averaged by duration and normalized again.
// A span is embedded from its clean pieces only (the gaps step 4 joined are left out), and the
// mic's echo cut uses the system turns mapped onto the mic's timeline (`echoOnMic`, from each
// file's timing). Main caps this phase at 2 min on its own timer. Vectors go to main over the
// port only, never into a log line.
//
// Memory: the last input's samples stay in memory for embedding, and are released before any
// other input is read again, so at most one source's audio is held at a time.

import { BlobIntegrityError, readFramed } from '../crypto/blobs'
import { cleanSpans, echoOnMic, spanSeconds, type CleanSpan } from './clean-spans'
import type {
  DiarizeEmbedMode,
  DiarizeFile,
  DiarizeFileTiming,
  DiarizeInput,
  DiarizeSegment,
  DiarizeStart,
  DiarizeToMain,
  DiarizeWorkerArgs,
  VerifiedFile,
  WorkerLog
} from './protocol'
import { verifyFilesSync } from './verify'

const port = process.parentPort
const SAMPLE_RATE = 16000
/** The input keys (`diarize.ts` keys inputs by `AudioSource`). */
const MIC = 'microphone'
const SYSTEM = 'system'
/** Under this much clean speech a cluster gets no vector, so voice can't name it. */
const MIN_CLEAN_MS = 3000
const EMBED_MODES: readonly unknown[] = ['all', 'mic', 'none'] satisfies DiarizeEmbedMode[]

type Sherpa = typeof import('sherpa-onnx-node')
type Extractor = InstanceType<Sherpa['SpeakerEmbeddingExtractor']>

function send(m: DiarizeToMain): void {
  port.postMessage(m)
}

function log(level: WorkerLog['level'], event: string, data?: Record<string, unknown>): void {
  send({ type: 'log', level, event, ...(data ? { data } : {}) })
}

function validArgs(a: Partial<DiarizeWorkerArgs> | undefined): a is DiarizeWorkerArgs {
  return (
    !!a &&
    !!a.files?.segmentation &&
    !!a.files.embedding &&
    Array.isArray(a.inputs) &&
    a.inputs.every((i) => Array.isArray(i?.files)) &&
    typeof a.threshold === 'number' &&
    typeof a.windowShiftRatio === 'number' &&
    EMBED_MODES.includes(a.embedMode) &&
    (a.identification === null || typeof a.identification?.path === 'string')
  )
}

/** One decrypted file's PCM; a missing or damaged file is logged and reads as what was readable. */
async function readFile(f: DiarizeFile): Promise<Buffer[]> {
  const parts: Buffer[] = []
  try {
    const key = Buffer.from(f.key, 'base64')
    for await (const pcm of readFramed({ path: f.path, key, id: f.id, allowTruncated: true })) parts.push(pcm)
  } catch (err) {
    const why = err instanceof BlobIntegrityError ? 'integrity' : (err as { code?: unknown }).code === 'ENOENT' ? 'missing' : 'read'
    log('warn', 'diarize-worker:file-unreadable', { file: f.path.slice(-60), why })
  }
  return parts
}

/** The input's files back to back, as float32 samples. */
async function readSamples(files: DiarizeFile[]): Promise<Float32Array> {
  const parts: Buffer[] = []
  for (const f of files) parts.push(...(await readFile(f)))
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

/** Whether the input's clusters get an identification embedding. */
function inScope(mode: DiarizeEmbedMode, key: string): boolean {
  return mode === 'all' || (mode === 'mic' && key === MIC)
}

function normalized(v: Float32Array | Float64Array): Float32Array {
  let n = 0
  for (const x of v) n += x * x
  const len = Math.sqrt(n)
  return Float32Array.from(v, (x) => (len > 0 ? x / len : x))
}

/** The identification extractor, re-verified first; null (logged) when it can't load. */
function loadExtractor(sherpa: Sherpa, file: VerifiedFile, numThreads: number): Extractor | null {
  if (verifyFilesSync([file])) {
    log('warn', 'diarize-worker:identification-unavailable', { why: 'integrity' })
    return null
  }
  try {
    return new sherpa.SpeakerEmbeddingExtractor({ model: file.path, numThreads, debug: 0, provider: 'cpu' })
  } catch {
    log('warn', 'diarize-worker:identification-unavailable', { why: 'load' })
    return null
  }
}

/** A span's clean pieces back to back (the gaps step 4 joined are left out). */
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

/**
 * The cluster vector: each span embedded and L2-normalized, their mean weighted by
 * duration, normalized again. Null when no span could be embedded.
 */
function clusterVector(ex: Extractor, samples: Float32Array, spans: readonly CleanSpan[]): Float32Array | null {
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

/**
 * One `cluster` message per speaker of the input, so the ones sent before main's cap are kept.
 * `cleanMs` is the selected spans' total; under 3 s, or with `ex` null, the vector is null.
 */
function embedInput(ex: Extractor | null, key: string, samples: Float32Array, turns: DiarizeSegment[], echo: DiarizeSegment[]): void {
  const t = Date.now()
  const spans = cleanSpans(turns, echo)
  const labels = [...new Set(turns.map((s) => s.speaker))].sort((a, b) => a - b)
  let vectors = 0
  for (const label of labels) {
    const speechMs = Math.round(turns.reduce((n, s) => n + (s.speaker === label ? (s.end - s.start) * 1000 : 0), 0))
    const mine = spans.filter((s) => s.speaker === label)
    const cleanMs = Math.round(mine.reduce((n, s) => n + spanSeconds(s) * 1000, 0))
    let vector: Float32Array | null = null
    if (ex && cleanMs >= MIN_CLEAN_MS) {
      try {
        vector = clusterVector(ex, samples, mine)
      } catch {
        log('warn', 'diarize-worker:embed-failed', { source: key, label })
      }
    }
    if (vector) vectors++
    send({ type: 'cluster', cluster: { source: key, label, speechMs, cleanMs, vector } })
  }
  // Counts only: a vector never goes into a log line.
  log('info', 'diarize-worker:embedded', { source: key, clusters: labels.length, vectors, ms: Date.now() - t })
}

/** The input's file timings, when every file carries one. */
function timings(input: DiarizeInput | undefined): DiarizeFileTiming[] | null {
  const out = (input?.files ?? []).map((f) => f.timing)
  return input && out.every((t): t is DiarizeFileTiming => !!t && Number.isFinite(t.baseEpochMs) && Array.isArray(t.cuts)) ? out : null
}

/** System-channel speech on the mic's timeline, aligned through capture time. */
function micEcho(args: DiarizeWorkerArgs, turns: Map<string, DiarizeSegment[]>): DiarizeSegment[] {
  const system = turns.get(SYSTEM) ?? []
  const from = timings(args.inputs.find((i) => i.key === SYSTEM))
  const to = timings(args.inputs.find((i) => i.key === MIC))
  if (!system.length) return []
  if (from && to) return echoOnMic(system, from, to)
  log('warn', 'diarize-worker:echo-unaligned', { turns: system.length })
  return system
}

/** The last input's samples, kept for embedding; emptied by the first reader so they can be freed. */
interface Kept {
  key: string
  samples: Float32Array | null
}

/** The embedding phase, after every input is diarized and under main's own 2 min cap. */
async function embedClusters(
  sherpa: Sherpa,
  args: DiarizeWorkerArgs,
  identification: VerifiedFile,
  turns: Map<string, DiarizeSegment[]>,
  kept: Kept | null
): Promise<void> {
  const scope: DiarizeInput[] = args.inputs.filter((i) => inScope(args.embedMode, i.key) && turns.get(i.key)?.length)
  if (!scope.length) {
    kept?.samples?.fill(0)
    return
  }
  send({ type: 'embedding-started' })
  const ex = loadExtractor(sherpa, identification, args.numThreads)
  // The audio still in memory goes first: its clusters are reported before any re-read.
  scope.sort((a, b) => Number(b.key === kept?.key) - Number(a.key === kept?.key))
  for (const input of scope) {
    let samples: Float32Array
    if (kept?.samples && kept.key === input.key) {
      samples = kept.samples
      // The holder lets go here, so this input's audio is freed before the next one is read.
      kept.samples = null
    } else samples = ex ? await readSamples(input.files) : new Float32Array(0)
    // On the mic, system-channel speech is echo residue.
    const echo = input.key === MIC ? micEcho(args, turns) : []
    embedInput(ex, input.key, samples, turns.get(input.key) ?? [], echo)
    samples.fill(0)
  }
}

async function main(args: DiarizeWorkerArgs): Promise<void> {
  const problem = verifyFilesSync([args.files.segmentation, args.files.embedding])
  if (problem) {
    send({ type: 'error', message: problem })
    return
  }
  const sherpa = require('sherpa-onnx-node') as Sherpa
  let sd: InstanceType<typeof sherpa.OfflineSpeakerDiarization>
  try {
    sd = new sherpa.OfflineSpeakerDiarization({
      segmentation: { pyannote: { model: args.files.segmentation.path, windowShiftRatio: args.windowShiftRatio }, numThreads: args.numThreads, debug: 0, provider: 'cpu' },
      embedding: { model: args.files.embedding.path, numThreads: args.numThreads, debug: 0, provider: 'cpu' },
      clustering: { numClusters: -1, threshold: args.threshold },
      minDurationOn: 0.3,
      minDurationOff: 0.5
    })
  } catch (err) {
    send({ type: 'error', message: `model load failed: ${err instanceof Error ? err.message : String(err)}` })
    return
  }
  if (sd.sampleRate !== SAMPLE_RATE) {
    send({ type: 'error', message: `unexpected model sample rate ${sd.sampleRate}` })
    return
  }
  // Without a voice row on and the extractor ready, no vector is ever computed.
  const identification = args.embedMode === 'none' ? null : args.identification
  const turns = new Map<string, DiarizeSegment[]>()
  // The last input's audio stays in memory when it will be embedded, so it isn't read twice.
  let kept: Kept | null = null
  for (const [i, input] of args.inputs.entries()) {
    const samples = await readSamples(input.files)
    const audioMs = Math.round((samples.length * 1000) / SAMPLE_RATE)
    const t = Date.now()
    // Under a second of audio has no speakers worth separating.
    const segments = (samples.length >= SAMPLE_RATE ? sd.process(samples) : []).map((s) => ({ start: s.start, end: s.end, speaker: s.speaker }))
    turns.set(input.key, segments)
    const keep = !!identification && i === args.inputs.length - 1 && inScope(args.embedMode, input.key) && segments.length > 0
    if (keep) kept = { key: input.key, samples }
    else samples.fill(0)
    send({ type: 'result', key: input.key, segments, audioMs, computeMs: Date.now() - t })
  }
  if (identification) await embedClusters(sherpa, args, identification, turns, kept)
  // Main kills the process once it has the results.
  send({ type: 'done' })
}

process.on('uncaughtException', (err) => send({ type: 'error', message: err instanceof Error ? err.message : String(err) }))

// The listener also keeps the process alive until main has the results and kills it;
// an early exit could otherwise overtake the last messages.
let started = false
port.on('message', (e) => {
  const m = e.data as Partial<DiarizeStart> | null
  if (started || !m || m.type !== 'start') return
  started = true
  if (!validArgs(m.args)) {
    send({ type: 'error', message: 'invalid arguments' })
    return
  }
  main(m.args).catch((err: unknown) => send({ type: 'error', message: err instanceof Error ? err.message : String(err) }))
})
