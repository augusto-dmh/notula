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

import { BlobIntegrityError, readFramed } from '../crypto/blobs'
import type { DiarizeFile, DiarizeStart, DiarizeToMain, DiarizeWorkerArgs, WorkerLog } from './protocol'
import { verifyFilesSync } from './verify'

const port = process.parentPort
const SAMPLE_RATE = 16000

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
    typeof a.windowShiftRatio === 'number'
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

async function main(args: DiarizeWorkerArgs): Promise<void> {
  const problem = verifyFilesSync([args.files.segmentation, args.files.embedding])
  if (problem) {
    send({ type: 'error', message: problem })
    return
  }
  const sherpa = require('sherpa-onnx-node') as typeof import('sherpa-onnx-node')
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
  for (const input of args.inputs) {
    const samples = await readSamples(input.files)
    const audioMs = Math.round((samples.length * 1000) / SAMPLE_RATE)
    const t = Date.now()
    // Under a second of audio has no speakers worth separating.
    const segments = samples.length >= SAMPLE_RATE ? sd.process(samples) : []
    samples.fill(0)
    send({
      type: 'result',
      key: input.key,
      segments: segments.map((s) => ({ start: s.start, end: s.end, speaker: s.speaker })),
      audioMs,
      computeMs: Date.now() - t
    })
  }
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
