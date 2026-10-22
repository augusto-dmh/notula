// SPDX-License-Identifier: Apache-2.0
// Dev-only check for the local engine's adaptive speech gate, its speech-level gate with
// hysteresis and gain normalization (src/main/asr/vad.ts, gain.ts). Feeds synthetic 16 kHz
// audio to the pure segmenter; no app, no audio device.
// Run: node scripts/dev/vad-check.ts   (Node's type stripping; exits 1 on a failure)

import { normalizeGain } from '../../src/main/asr/gain.ts'
import { HOP_SAMPLES, NoiseFloor, SAMPLE_RATE, Segmenter, SPEECH_RMS, type Segment } from '../../src/main/asr/vad.ts'

/** Deterministic noise (mulberry32 + Box-Muller), so every run sees the same audio. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const dbfs = (db: number): number => 10 ** (db / 20)

interface Scene {
  seconds: number
  /** Noise RMS; 0 = digital silence. */
  noise: number
  /** Speech-like bursts: start/end in seconds and their RMS (or their peak). */
  /** `dip`: the syllable envelope's low point (default 0.5; real speech dips deeper). */
  bursts: { from: number; to: number; rms: number; peak?: number; dip?: number }[]
}

function render(scene: Scene, seed = 1): Float32Array {
  const rand = rng(seed)
  const gauss = (): number => Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand())
  const out = new Float32Array(Math.round(scene.seconds * SAMPLE_RATE))
  for (let i = 0; i < out.length; i++) {
    const t = i / SAMPLE_RATE
    let v = scene.noise ? scene.noise * gauss() : 0
    for (const b of scene.bursts) {
      if (t < b.from || t >= b.to) continue
      // A voiced tone with a syllable-rate (4 Hz) envelope between 0.5 and 1, scaled so
      // the burst's RMS is about `rms` (the envelope's mean square is ~0.59).
      const dip = b.dip ?? 0.5
      const env = dip + (1 - dip) * Math.abs(Math.sin(2 * Math.PI * 4 * (t - b.from)))
      const amp = b.peak ?? b.rms / Math.sqrt(0.59 * 0.5)
      v += amp * env * Math.sin(2 * Math.PI * 180 * t)
    }
    out[i] = v
  }
  return out
}

function segments(audio: Float32Array): Segment[] {
  const out: Segment[] = []
  const seg = new Segmenter({ final: (s) => out.push(s), partial: () => undefined })
  // 100 ms pushes, like the capture batches.
  for (let at = 0; at < audio.length; at += 1_600) seg.push(audio.subarray(at, at + 1_600))
  seg.flush()
  return out
}

/** Per-hop speech decisions under the old fixed rule and under the adaptive one. */
function decisions(audio: Float32Array): { old: boolean[]; adaptive: boolean[] } {
  const floor = new NoiseFloor()
  const old: boolean[] = []
  const adaptive: boolean[] = []
  for (let at = 0; at + HOP_SAMPLES <= audio.length; at += HOP_SAMPLES) {
    let sum = 0
    for (let i = at; i < at + HOP_SAMPLES; i++) sum += (audio[i] as number) ** 2
    const level = Math.sqrt(sum / HOP_SAMPLES)
    old.push(level >= SPEECH_RMS)
    adaptive.push(level >= floor.threshold())
    floor.add(level)
  }
  return { old, adaptive }
}

const peakOf = (a: Float32Array): number => a.reduce((m, v) => Math.max(m, Math.abs(v)), 0)

const span = (s: Segment): string =>
  `${(s.startSample / SAMPLE_RATE).toFixed(2)}–${((s.startSample + s.samples.length) / SAMPLE_RATE).toFixed(2)} s`

let failed = 0
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`)
  if (!ok) failed++
}

// Four 1.5 s bursts, 2 s apart, after 3 s of noise alone.
const BURSTS = [3, 6.5, 10, 13.5].map((from) => ({ from, to: from + 1.5, rms: 0 }))
const withRms = (rms: number): Scene['bursts'] => BURSTS.map((b) => ({ ...b, rms }))

{
  const audio = render({ seconds: 17, noise: dbfs(-60), bursts: withRms(dbfs(-45)) })
  const segs = segments(audio)
  const floor = new NoiseFloor()
  for (let at = 0; at + HOP_SAMPLES <= 3 * SAMPLE_RATE; at += HOP_SAMPLES) {
    let sum = 0
    for (let i = at; i < at + HOP_SAMPLES; i++) sum += (audio[i] as number) ** 2
    floor.add(Math.sqrt(sum / HOP_SAMPLES))
  }
  const d = decisions(audio)
  check(
    'quiet speech (-45 dBFS) over a -60 dBFS floor',
    segs.length === BURSTS.length,
    `${segs.length} segments [${segs.map(span).join(', ')}]; floor ${floor.floor()?.toFixed(5)}, threshold ${floor.threshold().toFixed(5)}; old rule speech hops ${d.old.filter(Boolean).length}, adaptive ${d.adaptive.filter(Boolean).length}`
  )
}

// The measured case: a lecture in Edge through the loopback at peak 0.007, over exact
// zero or a near-zero floor. The decode then sees each segment at peak ~0.5.
for (const [label, noise] of [
  ['quiet clean speech (peak 0.007) over digital silence', 0],
  ['quiet clean speech (peak 0.007) over a 2e-5 floor', 2e-5]
] as const) {
  const audio = render({ seconds: 17, noise, bursts: BURSTS.map((b) => ({ ...b, peak: 0.007 })) }, 5)
  const segs = segments(audio)
  const gains = segs.map((s) => normalizeGain(s.samples))
  const peaks = gains.map((g) => peakOf(g.samples))
  const d = decisions(audio)
  check(
    label,
    segs.length === BURSTS.length && peaks.every((p) => Math.abs(p - 0.5) < 0.01),
    `${segs.length} segments [${segs.map(span).join(', ')}]; old rule speech hops ${d.old.filter(Boolean).length}, adaptive ${d.adaptive.filter(Boolean).length}; input peak ${peakOf(audio).toFixed(4)}, gains ${gains.map((g) => `×${g.gain.toFixed(1)}`).join(' ')}, normalized peaks ${peaks.map((p) => p.toFixed(3)).join(' ')}`
  )
}

{
  const loud = render({ seconds: 2, noise: 0, bursts: [{ from: 0, to: 2, rms: 0, peak: 0.8 }] })
  const tiny = render({ seconds: 2, noise: 0, bursts: [{ from: 0, to: 2, rms: 0, peak: 0.001 }] })
  const zero = new Float32Array(SAMPLE_RATE)
  const [l, t, z] = [normalizeGain(loud), normalizeGain(tiny), normalizeGain(zero)]
  check(
    'gain: loud untouched, cap ×100, zero untouched',
    l.gain === 1 && l.samples === loud && t.gain === 100 && Math.abs(peakOf(t.samples) - 0.1) < 0.002 && z.gain === 1 && z.samples === zero,
    `loud ×${l.gain} (peak ${peakOf(l.samples).toFixed(3)}), peak-0.001 ×${t.gain} (peak ${peakOf(t.samples).toFixed(3)}), zero ×${z.gain}`
  )
}

for (const db of [-60, -50, -45]) {
  const segs = segments(render({ seconds: 15, noise: dbfs(db), bursts: [] }, 7))
  check(`constant noise at ${db} dBFS`, segs.length === 0, `${segs.length} segments`)
}

{
  const segs = segments(new Float32Array(15 * SAMPLE_RATE))
  check('digital silence', segs.length === 0, `${segs.length} segments`)
}

{
  // Digital silence, then noise below the 0.0005 clamp: nothing.
  const audio = new Float32Array(20 * SAMPLE_RATE)
  audio.set(render({ seconds: 10, noise: dbfs(-70), bursts: [] }, 3), 10 * SAMPLE_RATE)
  const segs = segments(audio)
  check('digital silence, then -70 dBFS noise', segs.length === 0, `${segs.length} segments`)
}

{
  // Digital silence, then audible steady noise: the floor is zero until the silence is ~2 s
  // old, so the onset can read as one short segment (known limit), never more.
  const audio = new Float32Array(30 * SAMPLE_RATE)
  audio.set(render({ seconds: 20, noise: dbfs(-55), bursts: [] }, 3), 10 * SAMPLE_RATE)
  const segs = segments(audio)
  const longest = Math.max(0, ...segs.map((s) => s.samples.length / SAMPLE_RATE))
  check(
    'digital silence, then -55 dBFS noise (onset only)',
    segs.length <= 1 && longest <= 3.5,
    `${segs.length} segments [${segs.map(span).join(', ')}]`
  )
}

for (const [label, noise] of [
  ['loud speech (-20 dBFS) over a -60 dBFS floor', dbfs(-60)],
  ['loud speech (-20 dBFS) over a -30 dBFS floor', dbfs(-30)]
] as const) {
  const audio = render({ seconds: 17, noise, bursts: withRms(dbfs(-20)) }, 11)
  const d = decisions(audio)
  const diff = d.old.filter((v, i) => v !== d.adaptive[i]).length
  const segs = segments(audio)
  check(label, diff === 0, `${diff} hop decisions differ from the old 0.01 rule; ${segs.length} segments [${segs.map(span).join(', ')}]`)
}

// Quiet speech, -50 to -55 dBFS, over a -65 to -70 dBFS floor (a quiet system-audio capture), with
// syllables dipping 14 dB (dip 0.2). Each burst must be one segment that covers it.
const covers = (segs: Segment[], from: number, to: number): boolean =>
  segs.some((s) => s.startSample / SAMPLE_RATE <= from && (s.startSample + s.samples.length) / SAMPLE_RATE >= to)
for (const [speechDb, floorDb] of [
  [-50, -65],
  [-55, -65],
  [-50, -70],
  [-55, -70]
] as const) {
  const bursts = BURSTS.map((b) => ({ ...b, rms: dbfs(speechDb), dip: 0.2 }))
  const segs = segments(render({ seconds: 17, noise: dbfs(floorDb), bursts }, 13))
  check(
    `quiet speech (${speechDb} dBFS, deep syllables) over a ${floorDb} dBFS floor`,
    segs.length === BURSTS.length && bursts.every((b) => covers(segs, b.from, b.to)),
    `${segs.length} segments [${segs.map(span).join(', ')}]`
  )
}

{
  // Phrase edges: each phrase opens on a soft syllable and ends on a soft word 10 dB under
  // its body (-62 vs -52 dBFS) over a -68 floor. One segment per phrase, edges included
  // once the first phrase has taught the speech level.
  const starts = [3, 7, 11, 15]
  const bursts: Scene['bursts'] = starts.flatMap((from) => [
    { from, to: from + 0.3, rms: dbfs(-62), dip: 0.3 },
    { from: from + 0.3, to: from + 1.8, rms: dbfs(-52), dip: 0.2 },
    { from: from + 1.8, to: from + 2.3, rms: dbfs(-62), dip: 0.3 }
  ])
  const segs = segments(render({ seconds: 20, noise: dbfs(-68), bursts }, 17))
  const phrases = starts.map((from) => covers(segs, from, from + 2.3))
  check(
    'phrase edges: a soft onset and a soft last word stay in the segment (after the first phrase)',
    segs.length === starts.length && phrases.slice(1).every(Boolean),
    `${segs.length} segments [${segs.map(span).join(', ')}]; phrases covered ${phrases.map((p) => (p ? 'y' : 'n')).join('')}`
  )
}

{
  // The benchmark's level (measured: non-silent hops at p50 -73, p90 -65 dBFS) between
  // phrases of digital silence: speech at -70 dBFS RMS, under the noise-floor gate's 0.0005 (-66 dBFS)
  // clamp. The first burst teaches the speech level, so only the later ones must be whole.
  const bursts = BURSTS.map((b) => ({ ...b, rms: dbfs(-70), dip: 0.15 }))
  const audio = render({ seconds: 17, noise: 0, bursts }, 19)
  const segs = segments(audio)
  const d = decisions(audio)
  check(
    'bench-level speech (-70 dBFS) over digital silence',
    segs.length === BURSTS.length && bursts.slice(1).every((b) => covers(segs, b.from, b.to)),
    `${segs.length} segments [${segs.map(span).join(', ')}]; noise-floor-only rule speech hops ${d.old.filter(Boolean).length}, adaptive ${d.adaptive.filter(Boolean).length}`
  )
}

for (const db of [-65, -70]) {
  // Steady noise at the quiet floors: nothing alone; after digital silence, at most the noise-floor gate's
  // known onset segment (-65 dBFS is over its 0.0005 clamp), never more.
  const alone = segments(render({ seconds: 15, noise: dbfs(db), bursts: [] }, 23))
  const after = new Float32Array(25 * SAMPLE_RATE)
  after.set(render({ seconds: 15, noise: dbfs(db), bursts: [] }, 29), 10 * SAMPLE_RATE)
  const late = segments(after)
  check(`constant noise at ${db} dBFS, alone and after digital silence`, alone.length === 0 && late.length <= 1 && late.every((s) => s.samples.length <= 3.5 * SAMPLE_RATE), `${alone.length} and ${late.length} segments`)
}

{
  // Continuous quiet speech with 0.2 s pauses: past 20 s a segment closes in a pause, so
  // none ends mid-phrase at the 25 s cap, and dense speech never loses its quiet floor.
  const bursts: Scene['bursts'] = []
  for (let from = 1; from + 2.2 <= 60; from += 2.4) bursts.push({ from, to: from + 2.2, rms: dbfs(-55), dip: 0.2 })
  const segs = segments(render({ seconds: 60, noise: dbfs(-70), bursts }, 31))
  const longest = Math.max(...segs.map((s) => s.samples.length / SAMPLE_RATE))
  const cut = segs.slice(0, -1).filter((s) => {
    const end = (s.startSample + s.samples.length) / SAMPLE_RATE
    return bursts.some((b) => end > b.from + 0.05 && end < b.to - 0.05)
  })
  check(
    'continuous quiet speech: all of it in segments that close in pauses, never past 25 s',
    longest <= 25 && cut.length === 0 && bursts.every((b) => covers(segs, b.from, b.to)),
    `${segs.length} segments [${segs.map(span).join(', ')}]; ${cut.length} end inside a phrase`
  )
}

console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
process.exit(failed ? 1 : 0)
