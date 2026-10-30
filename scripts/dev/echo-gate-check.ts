// SPDX-License-Identifier: Apache-2.0
// Dev-only check for the mic's echo gate (src/main/transcription/echo-gate.ts). Synthetic
// two-channel scenes: speech-like voices (harmonic tones with syllable envelopes, no real
// voice), the system voice echoed into the mic at a delay, level and room tail, the user's
// voice on the mic. Each scene goes through the gate in 100 ms batches, like capture, and the
// local engine's segmenter (src/main/asr/vad.ts) shows what would be transcribed.
// Run: node scripts/dev/echo-gate-check.ts   (Node's type stripping; exits 1 on a failure)
//
// With `--manifest <m>` it instead replays a speaker-bench manifest's two-channel meetings (outside
// the repo) and prints, per meeting, the share of frames kept on the user's speech, on echo only
// and on both, and the segmenter's speech time over echo before and after the gate. With
// `--echo <ms> <dB>`, for a set composed with exactly that echo (the public set: 80 −30), the
// user's own signal is the mic minus that echo, so it also prints the share of the user's
// voiced frames (over −50 dBFS) kept, alone and while the system speaks.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { Segmenter, type Segment } from '../../src/main/asr/vad.ts'
import { EchoGate } from '../../src/main/transcription/echo-gate.ts'

const RATE = 16_000
const BATCH = 1_600
const FRAME = 320

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

/**
 * A speech-like voice: syllables of 120–320 ms (harmonics of a gliding pitch under two moving
 * formant peaks), 40–200 ms apart, inside the given talk spans. Scaled to `level` dBFS RMS
 * over its syllables.
 */
function voice(seconds: number, spans: [number, number][], f0: number, level: number, seed: number): Float32Array {
  const rand = rng(seed)
  const out = new Float32Array(Math.round(seconds * RATE))
  for (const [from, to] of spans) {
    let t = from
    while (t < to) {
      const len = 0.12 + 0.2 * rand()
      const end = Math.min(to, t + len)
      const p0 = f0 * (0.85 + 0.3 * rand())
      const p1 = f0 * (0.85 + 0.3 * rand())
      const fa = 300 + 600 * rand()
      const fb = 900 + 1600 * rand()
      let phase = 0
      for (let i = Math.round(t * RATE); i < Math.round(end * RATE) && i < out.length; i++) {
        const x = (i / RATE - t) / (end - t)
        const pitch = p0 + (p1 - p0) * x
        phase += (2 * Math.PI * pitch) / RATE
        let v = 0
        for (let h = 1; pitch * h < 5_000; h++) {
          const f = pitch * h
          const g = Math.exp(-(((f - fa) / 200) ** 2)) + 0.6 * Math.exp(-(((f - fb) / 300) ** 2)) + 0.05
          v += (g / Math.sqrt(h)) * Math.sin(h * phase)
        }
        out[i] = v * Math.sqrt(Math.max(0, Math.sin(Math.PI * x)))
      }
      t = end + 0.04 + 0.16 * rand()
    }
  }
  let sum = 0
  let n = 0
  for (const v of out) {
    if (v === 0) continue
    sum += v * v
    n++
  }
  const scale = n ? dbfs(level) / Math.sqrt(sum / n) : 0
  for (let i = 0; i < out.length; i++) out[i] = (out[i] as number) * scale
  return out
}

function noise(seconds: number, level: number, seed: number): Float32Array {
  const rand = rng(seed)
  const out = new Float32Array(Math.round(seconds * RATE))
  for (let i = 0; i < out.length; i++) out[i] = dbfs(level) * Math.sqrt(-2 * Math.log(rand() || 1e-12)) * Math.cos(2 * Math.PI * rand())
  return out
}

/** The system voice as the mic hears it: delayed, at a gain, with an exponential room tail, softly clipped. */
function echoOf(sys: Float32Array, delayMs: number, gainDb: number, rt60: number, seed: number, clip = false): Float32Array {
  const rand = rng(seed)
  const d = Math.round((delayMs * RATE) / 1000)
  const irLen = rt60 > 0 ? Math.round(rt60 * RATE) : 1
  const ir = new Float32Array(irLen)
  ir[0] = 1
  // A sparse tail: one reflection every ~2 ms, decaying 60 dB over rt60.
  for (let i = 32; i < irLen; i += 16 + Math.floor(rand() * 32)) ir[i] = (rand() * 2 - 1) * 0.5 * 10 ** ((-3 * i) / irLen)
  const out = new Float32Array(sys.length)
  const g = dbfs(gainDb)
  for (let i = 0; i < sys.length; i++) {
    const v = sys[i] as number
    if (v === 0) continue
    for (let k = 0; k < irLen; k++) {
      const w = ir[k] as number
      if (w === 0) continue
      const j = i + d + k
      if (j >= out.length) break
      out[j] = (out[j] as number) + v * w * g
    }
  }
  if (clip) for (let i = 0; i < out.length; i++) out[i] = Math.tanh((out[i] as number) * 8) / 8
  return out
}

function mix(...parts: Float32Array[]): Float32Array {
  const out = new Float32Array(Math.max(...parts.map((p) => p.length)))
  for (const p of parts) for (let i = 0; i < p.length; i++) out[i] = (out[i] as number) + (p[i] as number)
  return out
}

function toPcm(a: Float32Array, from: number, to: number): Buffer {
  const b = Buffer.alloc((to - from) * 2)
  for (let i = from; i < to; i++) b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(((a[i] as number) || 0) * 32768))), (i - from) * 2)
  return b
}

/** Feeds both channels in 100 ms batches (mic first, or the system a batch late) and returns the gated mic. */
function run(mic: Float32Array, sys: Float32Array | null, opts: { systemLate?: boolean; onBatch?: (gate: EchoGate, seconds: number) => void } = {}): { out: Float32Array; times: number[]; gate: EchoGate; maxHeld: number } {
  const parts: Buffer[] = []
  const times: number[] = []
  let fed = 0
  let maxHeld = 0
  const gate = new EchoGate((pcm, t) => {
    parts.push(pcm)
    times.push(t)
  })
  const t0 = 1_700_000_000_000
  let late: [Buffer, number] | null = null
  for (let at = 0; at < mic.length; at += BATCH) {
    const to = Math.min(mic.length, at + BATCH)
    const t = t0 + (at * 1000) / RATE
    gate.mic(toPcm(mic, at, to), t)
    fed++
    maxHeld = Math.max(maxHeld, fed - parts.length)
    opts.onBatch?.(gate, at / RATE)
    if (!sys) continue
    const s: [Buffer, number] = [toPcm(sys, at, to), t]
    if (opts.systemLate) {
      if (late) gate.system(...late)
      late = s
    } else gate.system(...s)
  }
  if (late) gate.system(...late)
  gate.flush()
  const pcm = Buffer.concat(parts)
  const out = new Float32Array(pcm.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = pcm.readInt16LE(i * 2) / 32768
  return { out, times, gate, maxHeld }
}

function segments(audio: Float32Array): Segment[] {
  const out: Segment[] = []
  const seg = new Segmenter({ final: (s) => out.push(s), partial: () => undefined })
  for (let at = 0; at < audio.length; at += BATCH) seg.push(audio.subarray(at, at + BATCH))
  seg.flush()
  return out
}

/** Seconds of segmenter speech inside the given spans. */
function segmentedIn(segs: Segment[], spans: [number, number][]): number {
  let s = 0
  for (const g of segs) {
    const a = g.startSample / RATE
    const b = (g.startSample + g.samples.length) / RATE
    for (const [from, to] of spans) s += Math.max(0, Math.min(b, to) - Math.max(a, from))
  }
  return s
}

/** Per 20 ms frame: the energy of `ref` and the output/input energy ratio. */
function frameGains(input: Float32Array, out: Float32Array): number[] {
  const g: number[] = []
  for (let at = 0; at + FRAME <= input.length; at += FRAME) {
    let a = 0
    let b = 0
    for (let i = at; i < at + FRAME; i++) {
      a += (input[i] as number) ** 2
      b += (out[i] as number) ** 2
    }
    g.push(a > 0 ? b / a : 1)
  }
  return g
}

function frameActive(signal: Float32Array, level: number): boolean[] {
  const act: boolean[] = []
  for (let at = 0; at + FRAME <= signal.length; at += FRAME) {
    let e = 0
    for (let i = at; i < at + FRAME; i++) e += (signal[i] as number) ** 2
    act.push(e / FRAME > dbfs(level) ** 2)
  }
  return act
}

/** The share of `which` frames (from second `after`) whose gain is about 1 (kept) or under −10 dB (gated). */
function share(gains: number[], which: boolean[], after: number, kind: 'kept' | 'gated'): number {
  let n = 0
  let hit = 0
  const from = Math.round((after * RATE) / FRAME)
  for (let k = from; k < gains.length; k++) {
    if (!which[k]) continue
    n++
    const g = gains[k] as number
    if (kind === 'kept' ? g > 0.9 : g < 0.1) hit++
  }
  return n ? hit / n : 1
}

let failed = 0
function check(name: string, ok: boolean, detail: string): void {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`)
  if (!ok) failed++
}

const pct = (x: number): string => `${(100 * x).toFixed(1)} %`

function turns(seconds: number, seed: number, talk: [number, number], gap: [number, number], start = 0.5): [number, number][] {
  const rand = rng(seed)
  const out: [number, number][] = []
  let t = start
  while (t < seconds - 0.5) {
    const len = talk[0] + (talk[1] - talk[0]) * rand()
    out.push([t, Math.min(seconds - 0.2, t + len)])
    t += len + gap[0] + (gap[1] - gap[0]) * rand()
  }
  return out
}

const NOT = (a: boolean[]): boolean[] => a.map((x) => !x)
const AND = (a: boolean[], b: boolean[]): boolean[] => a.map((x, i) => x && !!b[i])

function synthetic(): void {
  const S = 60
  const WARM = 10
  const far = turns(S, 1, [2, 6], [0.3, 1.2])
  const sys = voice(S, far, 120, -24, 11)
  const floor = noise(S, -70, 12)

  // 1. The bench's echo: 80 ms, −30 dB, no room.
  for (const [name, echo] of [
    ['echo only, 80 ms at −30 dB', echoOf(sys, 80, -30, 0, 2)],
    ['echo only, room: 180 ms at −18 dB, 0.5 s tail, clipped', echoOf(sys, 180, -18, 0.5, 3, true)],
    ['echo only, 20 ms at −24 dB, 0.3 s tail', echoOf(sys, 20, -24, 0.3, 4)]
  ] as const) {
    const mic = mix(echo, floor)
    const { out, gate } = run(mic, sys)
    const echoFrames = frameActive(echo, -60)
    const gated = share(frameGains(mic, out), echoFrames, WARM, 'gated')
    const spans: [number, number][] = [[WARM, S]]
    const before = segmentedIn(segments(mic), spans)
    const after = segmentedIn(segments(out), spans)
    check(`${name}: gated after warm-up, and the segmenter goes quiet`, gated >= 0.9 && after <= 0.1 * before, `${pct(gated)} of echo frames gated; segments ${before.toFixed(1)} s → ${after.toFixed(1)} s; lag ${gate.stats.lagMs} ms, ρ ${gate.stats.rho.toFixed(2)}`)
  }

  // 2. Double talk: the user (−22 dBFS) over a strong room echo, half their turns inside the remote's,
  //    after 15 s in which only the remote talks (the gate needs two clear 3 s blocks to arm).
  {
    const echo = echoOf(sys, 120, -18, 0.5, 5, true)
    const near = turns(S, 6, [1, 4], [1, 4], 15)
    const user = voice(S, near, 210, -22, 13)
    const mic = mix(echo, user, floor)
    const { out } = run(mic, sys)
    const userFrames = frameActive(user, -45)
    const both = AND(userFrames, frameActive(echo, -60))
    const g = frameGains(mic, out)
    const kept = share(g, userFrames, 0, 'kept')
    const keptBoth = share(g, both, 0, 'kept')
    const echoOnly = AND(frameActive(echo, -60), NOT(frameActive(user, -80)))
    const gated = share(g, echoOnly, 15, 'gated')
    const lost = segmentedIn(segments(mic), near) - segmentedIn(segments(out), near)
    check('double talk over a room echo at −18 dB: the user is kept, the echo between their turns gated', kept >= 0.98 && keptBoth >= 0.97 && lost <= 0.2 && gated >= 0.5, `${pct(kept)} of user frames kept, ${pct(keptBoth)} while both talk; ${lost.toFixed(2)} s of user speech lost to the segmenter; ${pct(gated)} of echo-only frames gated`)
  }

  // 3. A quiet user (−40 dBFS) against an echo at −24 dB: still kept.
  {
    const echo = echoOf(sys, 80, -24, 0.3, 7)
    const near = turns(S, 8, [1, 3], [1, 3], 2)
    const user = voice(S, near, 190, -40, 14)
    const mic = mix(echo, user, floor)
    const { out } = run(mic, sys)
    const kept = share(frameGains(mic, out), frameActive(user, -60), 0, 'kept')
    check('a quiet user (−40 dBFS) over an echo at −24 dB: kept', kept >= 0.97, `${pct(kept)} of user frames kept`)
  }

  // 4. Headphones: no echo, the remote talks all the time, the user talks over it. Never armed.
  {
    const cont = voice(S, [[0.2, S - 0.2]], 130, -24, 15)
    const near = turns(S, 9, [2, 6], [0.5, 2], 1)
    const user = voice(S, near, 200, -26, 16)
    const mic = mix(user, floor)
    const { out, gate } = run(mic, cont)
    const kept = share(frameGains(mic, out), frameActive(user, -60), 0, 'kept')
    check('headphones, the user talking over constant system speech: never armed, all kept', gate.stats.armedFrames === 0 && kept === 1, `${gate.stats.armedFrames} armed frames, ${pct(kept)} kept, ρ ${gate.stats.rho.toFixed(2)}`)
  }

  // 5. The user talking most of the time over a video played on speakers.
  {
    const cont = voice(S, [[0.2, S - 0.2]], 130, -24, 17)
    const echo = echoOf(cont, 60, -24, 0.3, 18)
    const near = turns(S, 10, [3, 8], [0.3, 1.5], 0.5)
    const user = voice(S, near, 220, -24, 19)
    const mic = mix(echo, user, floor)
    const { out } = run(mic, cont)
    const kept = share(frameGains(mic, out), frameActive(user, -50), 0, 'kept')
    check('the user talking over a video on speakers most of the time: kept', kept >= 0.97, `${pct(kept)} of user frames kept`)
  }

  // 6. Headphones plugged in after 30 s of speakers: the gate disarms, and the user is kept throughout.
  {
    const L = 120
    const remote = voice(L, turns(L, 21, [2, 6], [0.3, 1.2]), 125, -24, 22)
    const echo = echoOf(remote, 90, -24, 0.3, 23)
    for (let i = 30 * RATE; i < echo.length; i++) echo[i] = 0
    const near = turns(L, 24, [1, 3], [2, 5], 40)
    const user = voice(L, near, 205, -26, 25)
    const mic = mix(echo, user, noise(L, -70, 26))
    let armedAt30 = false
    const { out, gate } = run(mic, remote, { onBatch: (g, t) => (armedAt30 ||= t >= 29 && t < 30 && g.stats.lagMs !== null) })
    const kept = share(frameGains(mic, out), frameActive(user, -50), 0, 'kept')
    check('headphones plugged in mid-meeting: disarmed, the user kept', armedAt30 && gate.stats.lagMs === null && kept >= 0.99, `armed at 30 s: ${armedAt30}, at the end: ${gate.stats.lagMs !== null}; ${pct(kept)} of user frames kept`)
  }

  // 7. Mechanics: no system audio passes the mic unchanged; a late system batch still gates;
  //    every sample comes out, in order, with its capture time.
  {
    const near = turns(S, 11, [1, 4], [1, 4])
    const mic = mix(voice(S, near, 200, -22, 20), floor)
    for (const [name, ref] of [['no system audio', null], ['a silent system channel', new Float32Array(mic.length)]] as const) {
      const { out, times, maxHeld } = run(mic, ref)
      let same = out.length === mic.length
      for (let i = 0; same && i < mic.length; i++) same = Math.round((mic[i] as number) * 32768) === Math.round((out[i] as number) * 32768)
      const ordered = times.every((t, i) => i === 0 || t > (times[i - 1] as number))
      check(`${name}: the mic passes bit for bit, in order, held at most 400 ms`, same && ordered && times.length === Math.ceil(mic.length / BATCH) && maxHeld <= 4, `${out.length}/${mic.length} samples, ${times.length} batches, at most ${maxHeld} held`)
    }

    const echo = echoOf(sys, 80, -30, 0, 21)
    const m2 = mix(echo, floor)
    const late = run(m2, sys, { systemLate: true })
    const gated = share(frameGains(m2, late.out), frameActive(echo, -60), WARM, 'gated')
    check('the system channel a batch late: still gated, held at most 400 ms', late.out.length === m2.length && gated >= 0.9 && late.maxHeld <= 4, `${pct(gated)} of echo frames gated, at most ${late.maxHeld} batches held`)
  }
}

// ---------- the bench manifest ----------

function readWav(path: string): Float32Array {
  const b = readFileSync(path)
  let i = 12
  while (i + 8 <= b.length) {
    const id = b.toString('ascii', i, i + 4)
    const size = b.readUInt32LE(i + 4)
    if (id === 'data') {
      const n = Math.min(size, b.length - i - 8) >> 1
      const out = new Float32Array(n)
      for (let k = 0; k < n; k++) out[k] = b.readInt16LE(i + 8 + k * 2) / 32768
      return out
    }
    i += 8 + size + (size % 2)
  }
  throw new Error(`no data chunk: ${path}`)
}

function manifestRun(path: string, only: string | null, echo: { ms: number; db: number } | null): void {
  const m = JSON.parse(readFileSync(path, 'utf8')) as {
    people: { id: string; self?: boolean }[]
    meetings: { id: string; audio: { channel: string; path: string }[]; labels?: string }[]
  }
  const dir = dirname(path)
  const self = m.people.find((p) => p.self)?.id
  const sum = { self: [0, 0], echo: [0, 0], both: [0, 0], voiced: [0, 0], voicedOver: [0, 0], segEchoBefore: 0, segEchoAfter: 0, segSelfBefore: 0, segSelfAfter: 0 }
  for (const meeting of m.meetings) {
    if (only && meeting.id !== only) continue
    const micA = meeting.audio.find((a) => a.channel === 'mic')
    const sysA = meeting.audio.find((a) => a.channel === 'system')
    if (!micA || !sysA) continue
    const mic = readWav(resolve(dir, micA.path))
    const sys = readWav(resolve(dir, sysA.path))
    const labels = (JSON.parse(readFileSync(resolve(dir, meeting.labels ?? `labels/${meeting.id}.json`), 'utf8')) as { spans: { channel: string; startMs: number; endMs: number; person: string }[] }).spans
    const frames = Math.floor(mic.length / FRAME)
    const mark = (pred: (l: { channel: string; person: string }) => boolean, padMs = 0): boolean[] => {
      const a = new Array<boolean>(frames).fill(false)
      for (const l of labels) {
        if (!pred(l)) continue
        for (let k = Math.floor(l.startMs / 20); k < Math.min(frames, Math.ceil((l.endMs + padMs) / 20)); k++) a[k] = true
      }
      return a
    }
    const selfF = mark((l) => l.channel === 'mic' && l.person === self)
    const sysF = mark((l) => l.channel === 'system', 300)
    const { out, gate } = run(mic, sys)
    const g = frameGains(mic, out)
    const count = (which: boolean[], kind: 'kept' | 'gated'): [number, number] => {
      let n = 0
      let hit = 0
      for (let k = 0; k < frames; k++) {
        if (!which[k]) continue
        n++
        if (kind === 'kept' ? (g[k] as number) > 0.9 : (g[k] as number) < 0.1) hit++
      }
      return [hit, n]
    }
    let voiced: [number, number] = [0, 0]
    let voicedOver: [number, number] = [0, 0]
    if (echo) {
      const d = Math.round((echo.ms * RATE) / 1000)
      const own = new Float32Array(mic.length)
      for (let i = 0; i < mic.length; i++) own[i] = (mic[i] as number) - (i >= d ? (sys[i - d] as number) * dbfs(echo.db) : 0)
      const user = frameActive(own, -50)
      voiced = count(user, 'kept')
      voicedOver = count(AND(user, frameActive(echoOf(sys, echo.ms, echo.db, 0, 0), -60)), 'kept')
    }
    const selfOnly = count(AND(selfF, NOT(sysF)), 'kept')
    const echoOnly = count(AND(sysF, NOT(selfF)), 'gated')
    const both = count(AND(selfF, sysF), 'kept')
    const spansOf = (which: boolean[]): [number, number][] => which.flatMap((x, k) => (x ? [[(k * FRAME) / RATE, ((k + 1) * FRAME) / RATE] as [number, number]] : []))
    const echoSpans = spansOf(AND(sysF, NOT(selfF)))
    const selfSpans = spansOf(selfF)
    const before = segments(mic)
    const after = segments(out)
    const r = {
      segEchoBefore: segmentedIn(before, echoSpans),
      segEchoAfter: segmentedIn(after, echoSpans),
      segSelfBefore: segmentedIn(before, selfSpans),
      segSelfAfter: segmentedIn(after, selfSpans)
    }
    for (const [k, v] of [['self', selfOnly], ['echo', echoOnly], ['both', both], ['voiced', voiced], ['voicedOver', voicedOver]] as const) {
      sum[k][0] += v[0]
      sum[k][1] += v[1]
    }
    for (const k of Object.keys(r) as (keyof typeof r)[]) sum[k] += r[k]
    console.log(
      `${meeting.id}: self kept ${pct(selfOnly[0] / (selfOnly[1] || 1))}, both talking kept ${pct(both[0] / (both[1] || 1))} (${both[1]} frames), echo-only gated ${pct(echoOnly[0] / (echoOnly[1] || 1))}; ` +
        `segmenter over echo ${r.segEchoBefore.toFixed(1)} → ${r.segEchoAfter.toFixed(1)} s, over self ${r.segSelfBefore.toFixed(1)} → ${r.segSelfAfter.toFixed(1)} s; lag ${gate.stats.lagMs} ms, ρ ${gate.stats.rho.toFixed(2)}` +
        (echo ? `; user's voiced frames kept ${pct(voiced[0] / (voiced[1] || 1))}, ${pct(voicedOver[0] / (voicedOver[1] || 1))} of ${voicedOver[1]} over system speech` : '')
    )
  }
  console.log(
    `all: self kept ${pct(sum.self[0] / (sum.self[1] || 1))}, both talking kept ${pct(sum.both[0] / (sum.both[1] || 1))}, echo-only gated ${pct(sum.echo[0] / (sum.echo[1] || 1))}; ` +
      `segmenter over echo ${sum.segEchoBefore.toFixed(1)} → ${sum.segEchoAfter.toFixed(1)} s, over self ${sum.segSelfBefore.toFixed(1)} → ${sum.segSelfAfter.toFixed(1)} s` +
      (echo ? `; user's voiced frames kept ${pct(sum.voiced[0] / (sum.voiced[1] || 1))}, ${pct(sum.voicedOver[0] / (sum.voicedOver[1] || 1))} of ${sum.voicedOver[1]} over system speech` : '')
  )
}

const at = process.argv.indexOf('--manifest')
if (at > 0) {
  const only = process.argv.indexOf('--meeting')
  const e = process.argv.indexOf('--echo')
  const echo = e > 0 ? { ms: Number(process.argv[e + 1]), db: Number(process.argv[e + 2]) } : null
  manifestRun(process.argv[at + 1] as string, only > 0 ? (process.argv[only + 1] as string) : null, echo)
} else {
  synthetic()
  console.log(failed ? `\n${failed} check(s) failed` : '\nall checks passed')
  process.exit(failed ? 1 : 0)
}
