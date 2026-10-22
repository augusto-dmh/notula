// SPDX-License-Identifier: Apache-2.0
// The notula-asr utility process entry, built to out/main/asr.js and
// forked once per audio source with one JSON argument. It runs sherpa-onnx offline
// recognition on Parakeet TDT (110M English or 0.6B v3)
// or Whisper large-v3-turbo; it never touches the network, and re-verifies
// every model file before loading.
//
// Audio arrives as s16le batches. The energy VAD (vad.ts) cuts segments; each closed
// segment is decoded once as a final, and the open one is decoded as a partial at
// most every ~1 s, with at most one partial in flight. Decodes run one at a
// time, finals first, off the message loop (decodeAsync), so pings stay answered.
//
// Whisper's hallucination guards: it only ever sees the VAD's speech segments,
// never pure silence; sherpa's default tail padding (1,000 frames: shorter paddings made
// it repeat sentences on this host); a phrase repeated back to back is kept once, and an
// output that was mostly a loop is dropped. Its partials run at most every 3 s.
//
// Every segment and partial is gain-normalized before either engine decodes it
// (gain.ts: peak to 0.5, at most ×100, silence untouched); the first boost of a session
// is logged.
//
// Whisper under `multi` detects the language from the first finals, then locks it
// (language-lock.ts): `setConfig` swaps the decode language between two decodes, with no
// reload, so no audio waits. Once locked, text mostly in another script is dropped, and
// so is each remaining word in another script. An explicit language and
// Parakeet are unchanged.

import type { OfflineRecognizer, OfflineRecognizerConfig, OfflineRecognizerResult } from 'sherpa-onnx-node'
import { normalizeGain } from './gain'
import { foreignScriptShare, LanguageLock } from './language-lock'
import type { AsrFinalizeStats, AsrToMain, AsrWorkerArgs, AsrWorkerWord, MainToAsr, WorkerLog } from './protocol'
import { SAMPLE_RATE, Segmenter, type Segment } from './vad'
import { verifyFilesSync } from './verify'

const port = process.parentPort
/** Invalid arguments or a failed load: reply `error`, then exit. */
const EXIT_AFTER_ERROR_MS = 500
/** Progress is sent when committed-through has moved by at least this much. */
const PROGRESS_STEP_MS = 500
/** A word's end is extended toward the next word's start by at most this. */
const WORD_END_EXTENSION_S = 2
const DEFAULT_TOKEN_S = 0.08
/** Whisper: sherpa's default tail padding (1,000 feature frames). */
const WHISPER_TAIL_PADDINGS = 1000
/** Whisper partials are a full decode of the open segment: at most one per this. */
const WHISPER_PARTIAL_EVERY_MS = 3_000
/** A phrase of up to this many words, repeated back to back, is a loop. */
const LOOP_MAX_PHRASE = 8
/** An output that a loop shrank to this share of its words or less is dropped. */
const LOOP_DROP_SHARE = 0.25

function send(m: AsrToMain): void {
  port.postMessage(m)
}

function log(level: WorkerLog['level'], event: string, data?: Record<string, unknown>): void {
  send({ type: 'log', level, event, ...(data ? { data } : {}) })
}

let exiting = false
function fail(message: string): void {
  if (exiting) return
  exiting = true
  send({ type: 'error', message })
  setTimeout(() => process.exit(1), EXIT_AFTER_ERROR_MS)
}

function isFile(v: unknown): boolean {
  const f = v as { path?: unknown; bytes?: unknown; sha256?: unknown } | null
  return (
    !!f &&
    typeof f.path === 'string' &&
    typeof f.bytes === 'number' &&
    typeof f.sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(f.sha256)
  )
}

function parseArgs(): AsrWorkerArgs | null {
  for (const raw of [...process.argv].reverse()) {
    if (!raw.startsWith('{')) continue
    try {
      const a = JSON.parse(raw) as Partial<AsrWorkerArgs> & { files?: Record<string, unknown>; language?: unknown }
      const f = a.files
      const common =
        a.sampleRate === SAMPLE_RATE &&
        typeof a.numThreads === 'number' &&
        typeof a.hotwordScore === 'number' &&
        !!f &&
        isFile(f['encoder']) &&
        isFile(f['decoder']) &&
        isFile(f['tokens'])
      if (common && a.engine === 'parakeet' && isFile(f['joiner'])) return a as AsrWorkerArgs
      if (common && a.engine === 'whisper' && typeof a.language === 'string' && /^[a-z]{0,3}$/.test(a.language)) {
        return a as AsrWorkerArgs
      }
    } catch {
      // not ours
    }
  }
  return null
}

/** s16le → float32 in [-1, 1). */
function toFloat(pcm: Uint8Array): Float32Array {
  const bytes = pcm.byteOffset % 2 === 0 ? pcm : pcm.slice()
  const n = bytes.byteLength >> 1
  const ints = new Int16Array(bytes.buffer, bytes.byteOffset, n)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = (ints[i] as number) / 32768
  return out
}

/**
 * Word timings from token timestamps: a token that starts with a space starts
 * a new word; without timestamps the words are spread evenly; each word's end is
 * extended to the next word's start, by at most 2 s.
 */
function tokensToWords(r: OfflineRecognizerResult, segStartMs: number, segEndMs: number): AsrWorkerWord[] {
  const tokens = r.tokens ?? []
  const ts = r.timestamps ?? []
  const durs = r.durations ?? []
  const groups: { text: string; first: number; last: number }[] = []
  tokens.forEach((tok, i) => {
    const prev = groups[groups.length - 1]
    if (!prev || tok.startsWith(' ') || tok.startsWith('▁')) groups.push({ text: tok, first: i, last: i })
    else {
      prev.text += tok
      prev.last = i
    }
  })
  const words = groups
    .map((g) => ({ ...g, text: g.text.replace(/▁/g, ' ').trim() }))
    .filter((g) => g.text.length > 0)
  if (!words.length) return []
  const spanS = Math.max(0, (segEndMs - segStartMs) / 1000)
  const timed = ts.length === tokens.length
  const raw = words.map((g, i) => {
    if (!timed) {
      const step = spanS / words.length
      return { w: g.text, s: i * step, e: (i + 1) * step }
    }
    const s = ts[g.first] as number
    const lastStart = ts[g.last] as number
    const lastDur = durs[g.last] ?? Math.max(0, (ts[g.last + 1] ?? lastStart + DEFAULT_TOKEN_S) - lastStart)
    return { w: g.text, s, e: Math.max(s, lastStart + lastDur) }
  })
  return raw.map((x, i) => {
    const next = raw[i + 1]
    const e = next ? Math.max(x.e, Math.min(next.s, x.e + WORD_END_EXTENSION_S)) : x.e
    return {
      w: x.w,
      s_ms: Math.round(segStartMs + x.s * 1000),
      e_ms: Math.round(segStartMs + Math.min(e, spanS) * 1000)
    }
  })
}

function normWord(w: string): string {
  return w.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/**
 * Whisper's loop guard: a phrase of 1–8 words said again right after itself is kept
 * once (one-word phrases only from the third time, so "no, no" stays). Returns '' when
 * the loop made up most of the output.
 */
function collapseLoops(text: string): string {
  let words = text.split(/\s+/).filter(Boolean)
  const before = words.length
  for (let n = LOOP_MAX_PHRASE; n >= 1; n--) {
    const out: string[] = []
    let i = 0
    while (i < words.length) {
      const phrase = words.slice(i, i + n).map(normWord).join(' ')
      let reps = 1
      while (
        phrase.trim().length > 0 &&
        i + (reps + 1) * n <= words.length &&
        words.slice(i + reps * n, i + (reps + 1) * n).map(normWord).join(' ') === phrase
      ) {
        reps++
      }
      if (reps >= (n >= 2 ? 2 : 3)) {
        out.push(...words.slice(i, i + n))
        i += reps * n
      } else {
        out.push(words[i] as string)
        i++
      }
    }
    words = out
  }
  if (before >= 8 && words.length <= before * LOOP_DROP_SHARE) return ''
  return words.join(' ')
}

/** Whisper reports no token times here: the words are spread over the segment. */
function evenWords(text: string, segStartMs: number, segEndMs: number): AsrWorkerWord[] {
  const words = text.split(/\s+/).filter(Boolean)
  const step = words.length ? (segEndMs - segStartMs) / words.length : 0
  return words.map((w, i) => ({ w, s_ms: Math.round(segStartMs + i * step), e_ms: Math.round(segStartMs + (i + 1) * step) }))
}

class Engine {
  private readonly segmenter: Segmenter
  private readonly finals: Segment[] = []
  private partial: Segment | null = null
  private busy = false
  private inFlightFinalStart: number | null = null
  private lastProgressMs = Number.NEGATIVE_INFINITY
  private idleWaiters: (() => void)[] = []
  private lastPartialAt = 0
  private gainLogged = false
  private readonly stats: AsrFinalizeStats = {
    segments: 0,
    partials: 0,
    decodedAudioMs: 0,
    totalDecodeMs: 0,
    totalPartialDecodeMs: 0,
    maxDecodeMs: 0
  }

  constructor(
    private readonly rec: OfflineRecognizer,
    private readonly whisper: boolean,
    /** Whisper under `multi` only; `setLanguage` points the recognizer at the lock. */
    private readonly lock: LanguageLock | null = null,
    private readonly setLanguage: (language: string) => void = () => undefined
  ) {
    this.segmenter = new Segmenter({
      final: (seg) => {
        this.finals.push(seg)
        if (this.partial?.id === seg.id) this.partial = null
      },
      partial: (seg) => {
        // Only the newest snapshot of the open segment is worth decoding.
        this.partial = seg
      }
    })
  }

  audio(pcm: Uint8Array): void {
    this.segmenter.push(toFloat(pcm))
    this.progress()
    void this.pump()
  }

  skip(ms: number): void {
    this.segmenter.skip((ms * SAMPLE_RATE) / 1000)
    this.progress()
    void this.pump()
  }

  /** Flushes the open segment and waits for every final. */
  async finalize(): Promise<AsrFinalizeStats> {
    this.segmenter.flush()
    this.partial = null
    void this.pump()
    if (this.busy || this.finals.length) await new Promise<void>((r) => this.idleWaiters.push(r))
    return this.stats
  }

  private async pump(): Promise<void> {
    if (this.busy) return
    this.busy = true
    try {
      for (;;) {
        const final = this.finals.shift()
        if (final) {
          this.inFlightFinalStart = final.startSample
          await this.decode(final, true)
          this.inFlightFinalStart = null
          continue
        }
        const p = this.partial
        this.partial = null
        if (p && this.segmenter.isOpen(p.id) && !(this.whisper && Date.now() - this.lastPartialAt < WHISPER_PARTIAL_EVERY_MS)) {
          this.lastPartialAt = Date.now()
          await this.decode(p, false)
          continue
        }
        break
      }
    } finally {
      this.busy = false
      this.inFlightFinalStart = null
      this.progress()
      if (!this.finals.length) for (const w of this.idleWaiters.splice(0)) w()
    }
  }

  private async decode(seg: Segment, final: boolean): Promise<void> {
    const stream = this.rec.createStream()
    const { samples, gain } = normalizeGain(seg.samples)
    if (gain > 1 && !this.gainLogged) {
      this.gainLogged = true
      log('info', 'asr-worker:gain-normalized', { final, segmentId: seg.id, gain: Math.round(gain * 10) / 10 })
    }
    stream.acceptWaveform({ samples, sampleRate: SAMPLE_RATE })
    const t = Date.now()
    let r: OfflineRecognizerResult
    try {
      r = await this.rec.decodeAsync(stream)
    } catch (err) {
      log('warn', 'asr-worker:decode-failed', { final, segmentId: seg.id, err: String(err) })
      return
    }
    const ms = Date.now() - t
    const audioMs = (seg.samples.length * 1000) / SAMPLE_RATE
    if (final) {
      this.stats.segments++
      this.stats.decodedAudioMs += audioMs
      this.stats.totalDecodeMs += ms
    } else {
      this.stats.partials++
      this.stats.totalPartialDecodeMs += ms
    }
    this.stats.maxDecodeMs = Math.max(this.stats.maxDecodeMs, ms)
    // A partial for a segment that has closed since is discarded.
    if (!final && !this.segmenter.isOpen(seg.id)) return
    const startMs = (seg.startSample * 1000) / SAMPLE_RATE
    const endMs = startMs + audioMs
    let text = (r.text ?? '').trim()
    if (this.whisper) {
      const kept = collapseLoops(text)
      if (kept !== text) log('info', 'asr-worker:whisper-loop', { final, segmentId: seg.id, dropped: kept === '', words: text.split(/\s+/).length })
      text = kept
    }
    if (this.lock) text = this.applyLock(seg, final, text, r.lang, audioMs)
    send({
      type: final ? 'segment' : 'partial',
      segmentId: seg.id,
      text,
      startMs: Math.round(startMs),
      endMs: Math.round(endMs),
      words: this.whisper ? evenWords(text, startMs, endMs) : tokensToWords(r, startMs, endMs)
    })
  }

  /** The safety net once locked; before it, a final is evidence toward the lock. */
  private applyLock(seg: Segment, final: boolean, text: string, rawLanguage: unknown, audioMs: number): string {
    const lock = this.lock as LanguageLock
    if (lock.language) {
      if (lock.rejects(text)) {
        log('info', 'asr-worker:script-mismatch-dropped', {
          final,
          segmentId: seg.id,
          language: lock.language,
          foreignShare: Math.round(foreignScriptShare(text, lock.language) * 100) / 100,
          chars: text.length
        })
        return ''
      }
      // Single stray words in another script go too.
      const cleaned = lock.clean(text)
      if (cleaned.removed) log('info', 'asr-worker:script-words-removed', { final, segmentId: seg.id, language: lock.language, words: cleaned.removed })
      return cleaned.text
    }
    if (!final) return text
    const decision = lock.observe(rawLanguage, text, audioMs)
    if (decision) {
      this.setLanguage(decision.language)
      log('info', 'asr-worker:language-locked', { ...decision })
    }
    return text
  }

  /** Committed-through: the open segment's start, capped by the oldest pending final. */
  private progress(): void {
    let committed = this.segmenter.committedSample()
    const pending = [this.inFlightFinalStart, this.finals[0]?.startSample].filter((v): v is number => v !== null && v !== undefined)
    if (pending.length) committed = Math.min(committed, ...pending)
    const ms = Math.round((committed * 1000) / SAMPLE_RATE)
    if (ms - this.lastProgressMs < PROGRESS_STEP_MS) return
    this.lastProgressMs = ms
    send({ type: 'progress', committedMs: ms })
  }
}

// ---------- the process ----------

let engine: Engine | null = null
const early: MainToAsr[] = []
let keywordsLogged = false

function handle(m: MainToAsr): void {
  switch (m.type) {
    case 'ping':
      send({ type: 'pong', id: m.id })
      return
    case 'shutdown':
      process.exit(0)
      return
    default:
      break
  }
  if (!engine) {
    early.push(m)
    return
  }
  switch (m.type) {
    case 'audio':
      engine.audio(m.pcm)
      return
    case 'skip':
      engine.skip(m.ms)
      return
    case 'keywords':
      // Hotwords stay off until a BPE vocabulary is pinned.
      if (!keywordsLogged && m.terms.length) log('info', 'asr-worker:hotwords-off', { terms: m.terms.length })
      keywordsLogged = true
      return
    case 'finalize':
      void engine.finalize().then((stats) => send({ type: 'finalized', stats }))
      return
  }
}

process.on('uncaughtException', (err) => fail(`engine crashed: ${err instanceof Error ? err.message : String(err)}`))

port.on('message', (e) => {
  const m = e.data as MainToAsr | null
  if (!m || typeof m !== 'object' || typeof (m as { type?: unknown }).type !== 'string') return
  handle(m)
})

function start(): void {
  const args = parseArgs()
  if (!args) {
    fail('invalid arguments')
    return
  }
  // Layer 3 of the integrity check: every file, on every start, before loading.
  const problem = verifyFilesSync(Object.values(args.files))
  if (problem) {
    fail(problem)
    return
  }
  // Loaded only after the check, so nothing unverified ever reaches the runtime.
  const sherpa = require('sherpa-onnx-node') as typeof import('sherpa-onnx-node')
  const t0 = Date.now()
  const config: OfflineRecognizerConfig =
    args.engine === 'whisper'
      ? {
          featConfig: { sampleRate: SAMPLE_RATE, featureDim: 128 },
          modelConfig: {
            whisper: {
              encoder: args.files.encoder.path,
              decoder: args.files.decoder.path,
              language: args.language,
              task: 'transcribe',
              tailPaddings: WHISPER_TAIL_PADDINGS
            },
            tokens: args.files.tokens.path,
            numThreads: args.numThreads,
            provider: 'cpu',
            debug: 0
          },
          decodingMethod: 'greedy_search'
        }
      : {
          featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
          modelConfig: {
            transducer: { encoder: args.files.encoder.path, decoder: args.files.decoder.path, joiner: args.files.joiner.path },
            tokens: args.files.tokens.path,
            numThreads: args.numThreads,
            provider: 'cpu',
            debug: 0,
            modelType: 'nemo_transducer'
          },
          decodingMethod: 'modified_beam_search',
          maxActivePaths: 4,
          hotwordsScore: args.hotwordScore
        }
  sherpa.OfflineRecognizer.createAsync(config)
    .then((rec) => {
      const whisper = args.engine === 'whisper'
      // `multi` (no language) locks after detection; an explicit language never changes.
      const lock = whisper && !args.language ? new LanguageLock() : null
      const setLanguage = (language: string): void => {
        const w = config.modelConfig.whisper
        if (w) rec.setConfig({ ...config, modelConfig: { ...config.modelConfig, whisper: { ...w, language } } })
      }
      engine = new Engine(rec, whisper, lock, setLanguage)
      log('info', 'asr-worker:loaded', { modelId: args.modelId, engine: args.engine, numThreads: args.numThreads })
      send({ type: 'ready', loadMs: Date.now() - t0 })
      for (const m of early.splice(0)) handle(m)
    })
    .catch((err: unknown) => fail(`model load failed: ${err instanceof Error ? err.message : String(err)}`))
}

start()
