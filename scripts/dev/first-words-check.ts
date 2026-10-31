// SPDX-License-Identifier: Apache-2.0
// Dev-only check that a dictation's first words reach the decoder, on a fresh (cold) worker and
// on a kept-warm one serving its second dictation (src/main/asr/vad.ts `startSession`). Feeds
// synthetic 16 kHz audio to the pure segmenter in the order the main process sends it: the
// session start, then for a reused worker the clock gap as a skip, then 100 ms chunks.
// No app, no audio device, no speech.
// Run: node scripts/dev/first-words-check.ts   (Node's type stripping; exits 1 on a failure)

import { HEAD_PRE_ROLL_SAMPLES, HOP_SAMPLES, PRE_ROLL_HOPS, SAMPLE_RATE, Segmenter, type Segment } from '../../src/main/asr/vad.ts'

/** A voiced tone with a 4 Hz syllable envelope at about `rms`, over light noise (0 = digital silence). */
function tone(seconds: number, rms: number, noise = 0.0003, seed = 7): Float32Array {
  const out = new Float32Array(Math.round(seconds * SAMPLE_RATE))
  let s = seed
  for (let i = 0; i < out.length; i++) {
    s = (s * 16807) % 2147483647
    const t = i / SAMPLE_RATE
    const env = 0.5 + 0.5 * Math.abs(Math.sin(2 * Math.PI * 4 * t))
    const voice = rms ? (rms / Math.sqrt(0.59 * 0.5)) * env * Math.sin(2 * Math.PI * 180 * t) : 0
    out[i] = voice + noise * ((s / 2147483647) * 2 - 1) * 1.7
  }
  return out
}

const join = (...parts: Float32Array[]): Float32Array => {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** A dictation on `seg`: its segments, with starts in ms from its first sample. */
function dictate(seg: Segmenter, out: Segment[], audio: Float32Array, opts: { session: boolean; gapMs?: number }): { startMs: number; ms: number }[] {
  out.length = 0
  if (opts.session) seg.startSession()
  if (opts.gapMs) seg.skip((opts.gapMs * SAMPLE_RATE) / 1000)
  const from = seg.position
  for (let at = 0; at < audio.length; at += 1_600) seg.push(audio.subarray(at, at + 1_600))
  seg.flush()
  return out.map((s) => ({ startMs: Math.round(((s.startSample - from) * 1000) / SAMPLE_RATE), ms: Math.round((s.samples.length * 1000) / SAMPLE_RATE) }))
}

function worker(): { seg: Segmenter; out: Segment[] } {
  const out: Segment[] = []
  return { seg: new Segmenter({ final: (s) => out.push(s), partial: () => undefined }), out }
}

let failed = 0
function check(name: string, ok: boolean, detail: unknown): void {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}  ${JSON.stringify(detail)}`)
  if (!ok) failed++
}

// "Shopping list." said softly right at the press (under the 0.01 gate a fresh floor starts
// with), a pause, then the list at a normal level.
const heading = (rms: number): Float32Array => join(tone(0.7, rms), tone(0.5, 0), tone(2, 0.03), tone(1, 0))
// A previous dictation: loud speech in a noisier room, which shapes a reused worker's floor.
const before = join(tone(0.3, 0), tone(3, 0.05, 0.003, 11), tone(1, 0, 0.003, 13))

for (const rms of [0.003, 0.006, 0.012]) {
  const control = worker()
  const old = dictate(control.seg, control.out, heading(rms), { session: false })
  if (rms < 0.008) check(`control: without a session a soft heading (rms ${rms}) is cut`, (old[0]?.startMs ?? 0) > 500, old)

  const cold = worker()
  const c = dictate(cold.seg, cold.out, heading(rms), { session: true })
  check(`cold: the heading (rms ${rms}) starts the first segment`, c[0]?.startMs === 0 && (c[0]?.ms ?? 0) >= 3_000, c)

  const warm = worker()
  dictate(warm.seg, warm.out, before, { session: true })
  const w1 = dictate(warm.seg, warm.out, heading(rms), { session: true, gapMs: 150_000 })
  check(`warm, second dictation: the heading (rms ${rms}) starts the first segment`, w1[0]?.startMs === 0 && (w1[0]?.ms ?? 0) >= 3_000, w1)
  // A third in a row, right after the second (the clock gap is under the 3 s skip threshold).
  const w2 = dictate(warm.seg, warm.out, heading(rms), { session: true })
  check(`warm, third dictation in a row: the heading (rms ${rms}) starts the first segment`, w2[0]?.startMs === 0, w2)
}

// A tone burst at t = 0, then silence: the first chunk is delivered and not trimmed.
for (const kind of ['cold', 'warm'] as const) {
  const wk = worker()
  if (kind === 'warm') dictate(wk.seg, wk.out, before, { session: true })
  const r = dictate(wk.seg, wk.out, join(tone(0.6, 0.05), tone(1.5, 0)), { session: true, ...(kind === 'warm' ? { gapMs: 60_000 } : {}) })
  check(`${kind}: a burst at t = 0 is one segment from sample 0, burst whole`, r.length === 1 && r[0]?.startMs === 0 && (r[0]?.ms ?? 0) >= 600, r)
}

// The head is the session's first 3 s only: speech that starts later gets the usual pre-roll.
{
  const wk = worker()
  const r = dictate(wk.seg, wk.out, join(tone(5, 0), tone(1.5, 0.05), tone(1.5, 0)), { session: true })
  const pre = 5_000 - (r[0]?.startMs ?? 0)
  check('late speech: only the usual pre-roll', r.length === 1 && pre <= (PRE_ROLL_HOPS * HOP_SAMPLES * 1000) / SAMPLE_RATE + 32, { ...r[0], preRollMs: pre })
}
{
  // Speech just inside the head keeps everything since the start, and never more than the head.
  const wk = worker()
  const r = dictate(wk.seg, wk.out, join(tone(2.5, 0), tone(1.5, 0.05), tone(1.5, 0)), { session: true })
  check('speech at 2.5 s: kept from the start', r[0]?.startMs === 0 && (HEAD_PRE_ROLL_SAMPLES * 1000) / SAMPLE_RATE >= 2_500, r)
}

if (failed) {
  console.error(`\n${failed} check(s) failed`)
  process.exit(1)
}
console.log('\nall first-words checks passed')
