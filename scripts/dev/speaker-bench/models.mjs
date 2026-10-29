// SPDX-License-Identifier: Apache-2.0
// The model comparison: ResNet-34, ResNet-34-LM and
// CAM++ zh-en advanced on the same data. Each model embeds the labelled speech of every
// (meeting, channel, person) — a cluster proxy built from the label spans, so all models see
// the same audio — then the open-set protocol runs on cosine scores: centroids from the
// enrollment meetings, attendee-filtered candidates, a logistic per channel, and the gate's
// two bounds on the `≥30s` proxies. The model with the highest gated coverage wins; ties go to
// the smaller file. sherpa-onnx-node (already a dependency) runs the ONNX files; `--dry` uses a
// spectral stand-in so the path runs without any model.

import { statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { readWav, RATE } from './fixtures.mjs'
import { clopperPearsonUpper, farAtFrr, fitLogistic, peopleBootstrap, round } from './stats.mjs'

const SPAN_MIN_MS = 1_500
const SPAN_MAX_MS = 10_000
const PROXY_MAX_MS = 120_000

function normalize(v) {
  let n = 0
  for (const x of v) n += x * x
  n = Math.sqrt(n) || 1
  return Float32Array.from(v, (x) => x / n)
}

function dot(a, b) {
  let s = 0
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += a[i] * b[i]
  return s
}

/** The `--dry` stand-in: mean log energies at 24 log-spaced frequencies (tones only, never a voice model). */
function spectralExtractor() {
  const freqs = Array.from({ length: 24 }, (_, i) => 80 * Math.pow(4000 / 80, i / 23))
  return {
    id: 'dry-spectral',
    bytes: 0,
    embed(samples) {
      const frame = 512
      const acc = new Float64Array(freqs.length)
      let frames = 0
      for (let at = 0; at + frame <= samples.length; at += frame) {
        freqs.forEach((f, k) => {
          let re = 0
          let im = 0
          for (let n = 0; n < frame; n++) {
            const w = (2 * Math.PI * f * n) / RATE
            re += samples[at + n] * Math.cos(w)
            im += samples[at + n] * Math.sin(w)
          }
          acc[k] += Math.log(1e-9 + re * re + im * im)
        })
        frames++
      }
      if (!frames) return null
      const mean = acc.reduce((a, b) => a + b, 0) / acc.length
      return normalize(Array.from(acc, (x) => x / frames - mean / frames))
    }
  }
}

function sherpaExtractor(model) {
  const require = createRequire(import.meta.url)
  const sherpa = require('sherpa-onnx-node')
  const ex = new sherpa.SpeakerEmbeddingExtractor({ model: model.path, numThreads: 2, debug: 0, provider: 'cpu' })
  return {
    id: model.id,
    bytes: statSync(model.path).size,
    embed(samples) {
      const stream = ex.createStream()
      stream.acceptWaveform({ samples, sampleRate: RATE })
      stream.inputFinished()
      if (!ex.isReady(stream)) return null
      return normalize(ex.compute(stream, false))
    }
  }
}

/** Cluster proxies: per meeting, channel and labelled person, the averaged embedding of its spans. */
function proxies(manifest, extractor) {
  const out = []
  for (const m of manifest.meetings) {
    const audio = new Map()
    for (const a of m.audio) audio.set(a.channel, { samples: readWav(a.path), offsetMs: a.offsetMs ?? 0 })
    const groups = new Map()
    for (const l of m.labels) {
      if (l.person === 'unknown' || l.person === 'other') continue
      const key = `${l.channel}|${l.person}`
      groups.set(key, [...(groups.get(key) ?? []), l])
    }
    for (const [key, spans] of groups) {
      const [channel, person] = key.split('|')
      const a = audio.get(channel)
      if (!a?.samples) continue
      const vecs = []
      let cleanMs = 0
      for (const s of spans) {
        const len = Math.min(SPAN_MAX_MS, s.endMs - s.startMs)
        if (len < SPAN_MIN_MS || cleanMs >= PROXY_MAX_MS) continue
        const from = Math.max(0, Math.round(((s.startMs - a.offsetMs) / 1000) * RATE))
        const piece = a.samples.subarray(from, from + Math.round((len / 1000) * RATE))
        if (piece.length < (SPAN_MIN_MS / 1000) * RATE) continue
        const v = extractor.embed(piece)
        if (!v) continue
        vecs.push({ v, w: len })
        cleanMs += len
      }
      if (!vecs.length) continue
      const dim = vecs[0].v.length
      const mean = new Float64Array(dim)
      for (const { v, w } of vecs) for (let i = 0; i < dim; i++) mean[i] += v[i] * w
      out.push({ meeting: m.id, channel, person, cleanMs, vector: normalize(Array.from(mean)) })
    }
  }
  return out
}

/** One model through the open-set protocol on its proxies. */
function protocolFor(manifest, list, { enrolledIn, heldOut, seed }) {
  const selfId = manifest.people.find((p) => p.self)?.id ?? null
  const isEnrollment = (p) => enrolledIn[p.person]?.includes(p.meeting)
  const centroids = new Map()
  for (const p of list.filter(isEnrollment)) {
    const key = `${p.person}|${p.channel}`
    const c = centroids.get(key) ?? { sum: new Float64Array(p.vector.length), n: 0 }
    for (let i = 0; i < p.vector.length; i++) c.sum[i] += p.vector[i]
    c.n++
    centroids.set(key, c)
  }
  const gallery = [...centroids].map(([key, c]) => {
    const [person, channel] = key.split('|')
    return { person, channel, vector: normalize(Array.from(c.sum, (x) => x / c.n)) }
  })
  const tests = list.filter((p) => !isEnrollment(p))
  const trials = []
  for (const t of tests) {
    const m = manifest.meetings.find((x) => x.id === t.meeting)
    const candidates = gallery.filter((g) => g.channel === t.channel && (m.attendees.includes(g.person) || (g.person === selfId && t.channel === 'mic')))
    trials.push({ ...t, known: candidates.some((g) => g.person === t.person), scores: candidates.map((g) => ({ person: g.person, cos: dot(t.vector, g.vector) })) })
  }
  const out = { proxies: list.length, tests: tests.length, heldOutTests: tests.filter((t) => heldOut.includes(t.person)).length, channels: {} }
  for (const ch of ['mic', 'system']) {
    const these = trials.filter((t) => t.channel === ch)
    const xs = []
    const ys = []
    for (const t of these) for (const s of t.scores) {
      xs.push(s.cos)
      ys.push(s.person === t.person ? 1 : 0)
    }
    const genuine = xs.filter((_, i) => ys[i])
    const impostor = xs.filter((_, i) => !ys[i])
    const logistic = genuine.length >= 5 && impostor.length >= 5 ? fitLogistic(xs, ys, { a: 12, b: -6 }) : { a: 12, b: -6 }
    const p = (cos) => 1 / (1 + Math.exp(-(logistic.a * cos + logistic.b)))
    const long = these.filter((t) => t.cleanMs >= 30_000)
    let gated = { tau: null, auto: 0, wrong: 0, correct: 0 }
    for (let tau = 0.8; tau < 0.9995; tau += 0.0025) {
      const groups = new Map()
      let n = 0
      let x = 0
      let correct = 0
      for (const t of long) {
        const ranked = t.scores.map((s) => ({ person: s.person, p: p(s.cos) })).sort((a, b) => b.p - a.p)
        const top = ranked[0]
        if (!top || top.p < tau || top.p - (ranked[1]?.p ?? 0) < 0.1) continue
        n++
        const wrong = top.person !== t.person
        if (wrong) x++
        else correct++
        const g = groups.get(t.person) ?? { x: 0, n: 0 }
        g.n++
        if (wrong) g.x++
        groups.set(t.person, g)
      }
      if (!n) break
      if (clopperPearsonUpper(x, n) <= 0.01 && peopleBootstrap(groups, { seed }) <= 0.01) {
        gated = { tau: round(tau, 4), auto: n, wrong: x, correct }
        break
      }
    }
    const knownLong = long.filter((t) => t.known).length
    const f = farAtFrr(genuine, impostor, 0.05)
    out.channels[ch] = {
      tests: these.length,
      longTests: long.length,
      farAtFrr5: f ? round(f.far) : null,
      gatedTau: gated.tau,
      gatedAuto: gated.auto,
      gatedCoverage: knownLong ? round(gated.correct / knownLong) : 0
    }
  }
  const knownLongAll = trials.filter((t) => t.cleanMs >= 30_000 && t.known).length
  const correctAll = Object.values(out.channels).reduce((n, c) => n + (c.gatedCoverage ?? 0) * c.longTests, 0)
  out.gatedCoverage = knownLongAll ? round(correctAll / knownLongAll) : 0
  return out
}

export function compareModels(manifest, { enrolledIn, heldOut, seed = 1, dry = false }) {
  const models = dry ? [{ dry: true }] : manifest.models
  if (!models.length) return { skipped: 'no models in the manifest (models: [{id, path}])', results: [] }
  const results = []
  for (const model of models) {
    let extractor
    try {
      extractor = model.dry ? spectralExtractor() : sherpaExtractor(model)
    } catch (err) {
      results.push({ id: model.id, error: err instanceof Error ? err.message : String(err) })
      continue
    }
    const list = proxies(manifest, extractor)
    results.push({ id: extractor.id, bytes: extractor.bytes, ...protocolFor(manifest, list, { enrolledIn, heldOut, seed }) })
    for (const p of list) p.vector.fill(0)
  }
  const ranked = results.filter((r) => !r.error).sort((a, b) => b.gatedCoverage - a.gatedCoverage || a.bytes - b.bytes)
  const anyPass = ranked.some((r) => r.gatedCoverage > 0)
  return {
    results,
    winner: ranked[0]?.id ?? null,
    note: anyPass ? 'highest gated coverage wins; ties go to the smaller model' : 'no model passes any condition: CAM++ ships suggest-only'
  }
}
