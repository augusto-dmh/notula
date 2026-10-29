// SPDX-License-Identifier: Apache-2.0
// Fixtures composed per run: the `--dry` meetings (generated
// tones, no voice), the platform sweeps' transformed UIA streams (T2) and the stress mixtures
// (T3). Everything is written under the run's git-ignored folder and never committed.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { rng, shuffle } from './stats.mjs'

export const RATE = 16_000

// ---------- WAV ----------

export function writeWav(path, samples) {
  const data = Buffer.alloc(samples.length * 2)
  for (let i = 0; i < samples.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), i * 2)
  const h = Buffer.alloc(44)
  h.write('RIFF', 0, 'ascii')
  h.writeUInt32LE(36 + data.length, 4)
  h.write('WAVE', 8, 'ascii')
  h.write('fmt ', 12, 'ascii')
  h.writeUInt32LE(16, 16)
  h.writeUInt16LE(1, 20)
  h.writeUInt16LE(1, 22)
  h.writeUInt32LE(RATE, 24)
  h.writeUInt32LE(RATE * 2, 28)
  h.writeUInt16LE(2, 32)
  h.writeUInt16LE(16, 34)
  h.write('data', 36, 'ascii')
  h.writeUInt32LE(data.length, 40)
  writeFileSync(path, Buffer.concat([h, data]))
}

/** Float samples of a 16 kHz mono 16-bit WAV, or null when the file is another format. */
export function readWav(path) {
  const b = readFileSync(path)
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') return null
  let i = 12
  let ok = false
  while (i + 8 <= b.length) {
    const id = b.toString('ascii', i, i + 4)
    const size = b.readUInt32LE(i + 4)
    if (id === 'fmt ') ok = b.readUInt16LE(i + 10) === 1 && b.readUInt32LE(i + 12) === RATE && b.readUInt16LE(i + 22) === 16
    if (id === 'data') {
      if (!ok) return null
      const n = Math.floor(Math.min(size, b.length - i - 8) / 2)
      const out = new Float32Array(n)
      for (let k = 0; k < n; k++) out[k] = b.readInt16LE(i + 8 + k * 2) / 32768
      return out
    }
    i += 8 + size + (size % 2)
  }
  return null
}

export function wavMs(path) {
  const s = readWav(path)
  return s ? (s.length / RATE) * 1000 : 0
}

// ---------- ffmpeg (found at run time; never a dependency) ----------

export function findFfmpeg(explicit) {
  for (const c of [explicit, process.env.FFMPEG, 'ffmpeg'].filter(Boolean)) {
    try {
      execFileSync(c, ['-version'], { stdio: 'ignore' })
      return c
    } catch {
      // Next candidate.
    }
  }
  return null
}

/** Any audio file as 16 kHz mono float samples (ffmpeg for anything but such a WAV). */
export function loadAudio(path, ffmpeg, tmpDir) {
  const direct = path.toLowerCase().endsWith('.wav') ? readWav(path) : null
  if (direct) return direct
  if (!ffmpeg) throw new Error(`ffmpeg is needed to read ${basename(path)} (pass --ffmpeg)`)
  mkdirSync(tmpDir, { recursive: true })
  const out = join(tmpDir, `decode-${process.pid}-${Date.now()}.wav`)
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', path, '-ac', '1', '-ar', String(RATE), '-sample_fmt', 's16', out])
  const s = readWav(out)
  rmSync(out, { force: true })
  return s
}

/** An Opus round trip at `kbps` (T3). */
export function opusRoundTrip(samples, kbps, ffmpeg, tmpDir) {
  mkdirSync(tmpDir, { recursive: true })
  const stem = join(tmpDir, `opus-${process.pid}-${Date.now()}`)
  writeWav(`${stem}.wav`, samples)
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', `${stem}.wav`, '-c:a', 'libopus', '-b:a', `${kbps}k`, `${stem}.opus`])
  execFileSync(ffmpeg, ['-v', 'error', '-y', '-i', `${stem}.opus`, '-ac', '1', '-ar', String(RATE), '-sample_fmt', 's16', `${stem}.out.wav`])
  const s = readWav(`${stem}.out.wav`)
  for (const ext of ['.wav', '.opus', '.out.wav']) rmSync(`${stem}${ext}`, { force: true })
  return s
}

// ---------- synthetic "voices" (tones, never a real voice) ----------

/** A harmonic tone with a syllable-rate envelope: each person gets their own pitch and timbre. */
export function toneVoice(index) {
  return { f0: 95 + index * 37, bright: 0.35 + (index % 3) * 0.2, rate: 3.2 + (index % 4) * 0.4 }
}

export function renderTone(voice, ms, seed) {
  const n = Math.round((ms / 1000) * RATE)
  const out = new Float32Array(n)
  const rand = rng(seed)
  let phase = 0
  for (let i = 0; i < n; i++) {
    const t = i / RATE
    const vibrato = 1 + 0.01 * Math.sin(2 * Math.PI * 5 * t)
    phase += (2 * Math.PI * voice.f0 * vibrato) / RATE
    let s = 0
    for (let h = 1; h <= 8; h++) s += (voice.bright ** (h - 1) * Math.sin(h * phase)) / h
    const env = Math.max(0, Math.sin(Math.PI * voice.rate * t)) ** 0.6
    out[i] = 0.25 * s * env + 0.002 * (rand() * 2 - 1)
  }
  return out
}

function place(target, piece, atMs, gain = 1) {
  const at = Math.round((atMs / 1000) * RATE)
  for (let i = 0; i < piece.length && at + i < target.length; i++) if (at + i >= 0) target[at + i] += piece[i] * gain
}

// ---------- the dry fixture ----------

/**
 * Five synthetic people (the user and four others) and four short meetings, all tones: the
 * user on the mic, two others taking turns on the system channel with a Meet-shaped record
 * stream. Writes the WAVs, the streams, the labels and a manifest under `dir`.
 */
export function dryFixture(dir, { meetingMs = 6_000 } = {}) {
  mkdirSync(dir, { recursive: true })
  const people = [
    { id: 'p00', name: 'Bench Self', email: 'p00@bench.invalid', self: true },
    { id: 'p01', name: 'Alex Tone', email: 'p01@bench.invalid' },
    { id: 'p02', name: 'Bia Tone', email: 'p02@bench.invalid' },
    { id: 'p03', name: 'Caio Tone', email: 'p03@bench.invalid' },
    { id: 'p04', name: 'Duda Tone', email: 'p04@bench.invalid' }
  ]
  const pairs = [
    ['p01', 'p02'],
    ['p01', 'p03'],
    ['p02', 'p04'],
    ['p03', 'p04']
  ]
  const meetings = pairs.map((pair, k) => {
    const id = `m${k + 1}`
    const mic = new Float32Array(Math.round((meetingMs / 1000) * RATE))
    const sys = new Float32Array(mic.length)
    const labels = []
    const records = []
    const turn = 2_000
    for (let t = 0, i = 0; t + turn <= meetingMs; t += turn, i++) {
      const who = pair[i % 2]
      place(sys, renderTone(toneVoice(Number(who.slice(1))), turn - 200, k * 100 + i), t)
      labels.push({ channel: 'system', startMs: t, endMs: t + turn - 200, person: who })
      for (let r = t; r < t + turn; r += 300) {
        records.push({
          tMs: r,
          event: 'meet-roster',
          hasMeetingWindow: true,
          participantName: who,
          selfActive: false,
          participants: pair.map((p) => ({ name: p, active: p === who, isSelf: false }))
        })
      }
    }
    place(mic, renderTone(toneVoice(0), 2_000, 900 + k), 500)
    labels.push({ channel: 'mic', startMs: 500, endMs: 2_500, person: 'p00' })
    writeWav(join(dir, `${id}-mic.wav`), mic)
    writeWav(join(dir, `${id}-system.wav`), sys)
    writeFileSync(join(dir, `${id}-uia.jsonl`), records.map((r) => JSON.stringify(r)).join('\n'))
    return {
      id,
      set: 'dry',
      date: `2026-10-0${k + 1}`,
      language: 'en',
      title: `Dry bench meeting ${k + 1}`,
      audio: [
        { channel: 'mic', path: join(dir, `${id}-mic.wav`), offsetMs: 0 },
        { channel: 'system', path: join(dir, `${id}-system.wav`), offsetMs: 0 }
      ],
      attendees: [...pair],
      uia: { app: 'meet', path: join(dir, `${id}-uia.jsonl`) },
      labels
    }
  })
  const manifest = { version: 1, people, meetings, stress: { sources: people.slice(1, 4).map((p, i) => ({ corpus: 'dry-tone', speaker: p.id, tone: i + 1 })) }, models: [] }
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest, null, 1))
  return manifest
}

// ---------- T2: platform replay variants ----------

export const T2_LAGS_MS = [0, 500, 1_000, 1_500, 2_000, 3_000]

function readStream(path) {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l))
}

/**
 * The T2 variants of one stream: lag shifts, dropped records, a stuck speaker,
 * a room tile and blind stretches. Each variant is a new JSON-lines file.
 */
export function t2Variants(streamPath, outDir, { lags = T2_LAGS_MS, seed = 1 } = {}) {
  mkdirSync(outDir, { recursive: true })
  const base = readStream(streamPath)
  const end = Math.max(0, ...base.map((r) => r.tMs))
  const out = []
  const write = (name, records) => {
    const path = join(outDir, `${basename(streamPath, '.jsonl')}-${name}.jsonl`)
    writeFileSync(path, records.map((r) => JSON.stringify(r)).join('\n'))
    out.push({ variant: name, path })
  }
  for (const lag of lags) write(`lag${lag}`, base.map((r) => ({ ...r, tMs: r.tMs + lag })))
  const rand = rng(seed)
  write('drop30', base.filter(() => rand() >= 0.3))
  // A stuck speaker: from a third of the way in, the lit tile stays on whoever spoke then, for a third.
  const from = end / 3
  const until = (2 * end) / 3
  const stuckName = base.find((r) => r.tMs >= from)?.participantName ?? null
  write(
    'stuck',
    base.map((r) =>
      r.tMs >= from && r.tMs < until
        ? { ...r, participantName: stuckName, participants: (r.participants ?? []).map((p) => ({ ...p, active: p.name === stuckName })) }
        : r
    )
  )
  // A room tile: every named participant shows as one shared "Conference Room" tile.
  write(
    'room',
    base.map((r) => ({
      ...r,
      participantName: r.participantName ? 'Conference Room' : r.participantName,
      participants: [{ name: 'Conference Room', active: !!r.participantName, isSelf: false }]
    }))
  )
  // Blind stretches: the meeting window is gone for two stretches of a fifth each.
  write(
    'blind',
    base.map((r) => {
      const f = end ? r.tMs / end : 0
      return (f > 0.2 && f < 0.4) || (f > 0.6 && f < 0.8) ? { ...r, hasMeetingWindow: false, participants: [], participantName: null } : r
    })
  )
  return out
}

// ---------- T3: stress mixtures ----------

/** A cheap Schroeder reverb (four combs and two allpasses), O(n). */
function reverb(x, wet = 0.3) {
  const combs = [1557, 1617, 1491, 1422].map((d) => ({ d, buf: new Float32Array(d), i: 0, g: 0.78 }))
  const alls = [225, 556].map((d) => ({ d, buf: new Float32Array(d), i: 0, g: 0.5 }))
  const out = new Float32Array(x.length)
  for (let n = 0; n < x.length; n++) {
    let s = 0
    for (const c of combs) {
      const y = c.buf[c.i]
      c.buf[c.i] = x[n] + y * c.g
      c.i = (c.i + 1) % c.d
      s += y
    }
    s /= combs.length
    for (const a of alls) {
      const b = a.buf[a.i]
      const y = -s + b
      a.buf[a.i] = s + b * a.g
      a.i = (a.i + 1) % a.d
      s = y
    }
    out[n] = x[n] * (1 - wet) + s * wet
  }
  return out
}

function addNoise(x, snrDb, rand) {
  let p = 0
  for (const v of x) p += v * v
  p = p / Math.max(1, x.length)
  const sigma = Math.sqrt(p / 10 ** (snrDb / 10))
  return x.map((v) => v + sigma * (rand() * 2 - 1) * Math.sqrt(3))
}

export const T3_VARIANTS = [
  { name: 'overlap0', overlap: 0 },
  { name: 'overlap15', overlap: 0.15 },
  { name: 'overlap30', overlap: 0.3 },
  { name: 'turns-short', overlap: 0, turnMs: [500, 2_000] },
  { name: 'turns-long', overlap: 0, turnMs: [10_000, 30_000] },
  { name: 'noise10db', overlap: 0, noiseDb: 10 },
  { name: 'reverb', overlap: 0, reverb: true },
  { name: 'echo', overlap: 0, echo: true },
  { name: 'opus6-test', overlap: 0, opus: 6, on: 'test' },
  { name: 'opus12-both', overlap: 0, opus: 12, on: 'both' },
  { name: 'opus24-enroll', overlap: 0, opus: 24, on: 'enroll' }
]

/**
 * Stress meetings from the manifest's `stress.sources` (MLS PT, VoxConverse; tones in `--dry`):
 * per variant, one enrollment meeting and one test meeting, each two source speakers taking
 * turns on the system channel, with the variant's overlap, turn lengths, noise, reverberation,
 * mic echo and Opus. Their people are synthetic (`s<N>`); their notes never count toward the gate.
 */
export function composeStress(manifest, outDir, { ffmpeg, variants = T3_VARIANTS, meetingMs = 60_000, seed = 1, dry = false } = {}) {
  const sources = manifest.stress?.sources ?? []
  if (sources.length < 2) return { people: [], meetings: [], skipped: 'fewer than two stress sources' }
  mkdirSync(outDir, { recursive: true })
  const rand = rng(seed)
  const tmp = join(outDir, 'tmp')
  const people = []
  const audioOf = new Map()
  const speech = (p, ms, k) => {
    if (p.source.corpus === 'dry-tone') return renderTone(toneVoice(10 + (p.source.tone ?? 0)), ms, k)
    let all = audioOf.get(p.source.speaker)
    if (!all) {
      const parts = (p.source.files ?? []).map((f) => loadAudio(f, ffmpeg, tmp)).filter(Boolean)
      all = new Float32Array(parts.reduce((n, a) => n + a.length, 0))
      let at = 0
      for (const a of parts) {
        all.set(a, at)
        at += a.length
      }
      audioOf.set(p.source.speaker, all)
    }
    const n = Math.round((ms / 1000) * RATE)
    if (!all.length) return new Float32Array(n)
    const start = Math.floor(rand() * Math.max(1, all.length - n))
    return all.subarray(start, start + n)
  }
  const meetings = []
  const skipped = []
  for (const [vi, v] of variants.entries()) {
    if (v.opus && !ffmpeg) {
      skipped.push(`${v.name}: no ffmpeg`)
      continue
    }
    // Fresh people per variant, so one variant's enrollment never feeds another's test.
    const pair = shuffle(sources, rand)
      .slice(0, 2)
      .map((source, j) => ({ id: `t3${vi}${'ab'[j]}`, name: `Stress Speaker ${vi}${'AB'[j]}`, email: `t3${vi}${'ab'[j]}@bench.invalid`, source }))
    people.push(...pair)
    for (const role of ['enroll', 'test']) {
      const id = `t3-${v.name}-${role}`
      const sys = new Float32Array(Math.round((meetingMs / 1000) * RATE))
      const labels = []
      const [lo, hi] = v.turnMs ?? [2_000, 8_000]
      let t = 0
      let i = 0
      while (t < meetingMs - lo) {
        const len = Math.min(meetingMs - t, lo + rand() * (hi - lo))
        const who = pair[i % 2]
        place(sys, speech(who, len, i), t)
        labels.push({ channel: 'system', startMs: Math.round(t), endMs: Math.round(t + len), person: who.id })
        t += len * (1 - v.overlap)
        i++
      }
      let system = sys
      if (v.reverb) system = reverb(system)
      if (v.noiseDb) system = addNoise(system, v.noiseDb, rand)
      if (v.opus && (v.on === 'both' || v.on === role)) system = opusRoundTrip(system, v.opus, ffmpeg, tmp) ?? system
      const audio = [{ channel: 'system', path: join(outDir, `${id}-system.wav`), offsetMs: 0 }]
      writeWav(audio[0].path, system)
      if (v.echo) {
        // The mic hears the room's loudspeaker: the system channel 120 ms later, 20 dB down.
        const mic = new Float32Array(system.length)
        place(mic, system, 120, 0.1)
        audio.push({ channel: 'mic', path: join(outDir, `${id}-mic.wav`), offsetMs: 0 })
        writeWav(audio[1].path, mic)
      }
      meetings.push({
        id,
        set: 'stress',
        composed: true,
        variant: v.name,
        role,
        date: '2026-10-01',
        language: dry ? 'en' : (manifest.stress?.language ?? 'pt-BR'),
        title: `Stress ${v.name} ${role}`,
        audio,
        attendees: pair.map((p) => p.id),
        uia: null,
        labels
      })
    }
  }
  if (existsSync(tmp)) rmSync(tmp, { recursive: true, force: true })
  return { people: people.map(({ source: _s, ...p }) => p), meetings, skipped: skipped.join('; ') || null }
}
