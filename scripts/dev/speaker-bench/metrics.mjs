// SPDX-License-Identifier: Apache-2.0
// The bench's metrics: per-cluster outcomes by condition,
// signal set and gallery scope; the voice gate (both one-sided 95 % bounds ≤ 1 %, `≥30s` only,
// real clusters only); the calibration fit; FAR @ FRR 5 %; DER; CPU; the T2 and T3 summaries.
// Reports hold aggregates only: nothing here returns a person id, a name or a per-cluster row.

import { truthOf } from './manifest.mjs'
import { clopperPearsonUpper, der, farAtFrr, fitLogistic, peopleBootstrap, round } from './stats.mjs'

export const GATE_MAX = 0.01
const BUCKETS = ['<10s', '10-30s', '>=30s']
const CHANNELS = ['mic', 'system']
const LANGUAGES = ['pt', 'en', 'other']

export function bucketOf(cleanMs) {
  const ms = cleanMs ?? 0
  return ms < 10_000 ? '<10s' : ms < 30_000 ? '10-30s' : '>=30s'
}

export function conditionKey(channel, language, bucket) {
  return `${channel}|${language}|${bucket}`
}

const sigmoid = (x) => 1 / (1 + Math.exp(-x))

/**
 * Every evaluated cluster as a row, joined with its labelled person. `known`: the person is
 * enrolled and an attendee of the meeting (or the user, on the mic); `knownAll`: enrolled.
 */
export function clusterRows(evaluation, ctx) {
  const rows = []
  for (const n of evaluation?.notes ?? []) {
    const m = ctx.meetingOfTag(n.tag)
    if (!m) continue
    for (const c of n.clusters ?? []) {
      const truth = truthOf(c.segments ?? [], c.channel, m.labels)
      const enrolled = !!truth && !!ctx.enrolledIn[truth]
      const isSelf = !!truth && ctx.selfId === truth
      rows.push({
        tag: n.tag,
        composed: !!n.composed || !!m.composed,
        set: m.set ?? 'meetings',
        channel: c.channel,
        language: n.language ?? 'other',
        bucket: bucketOf(c.cleanMs),
        cleanMs: c.cleanMs,
        truth,
        heldOut: !!truth && ctx.heldOut.includes(truth),
        known: enrolled && (isSelf ? c.channel === 'mic' : m.attendees.includes(truth)),
        knownAll: enrolled,
        decisions: c.decisions ?? {},
        scores: c.scores ?? []
      })
    }
  }
  return rows
}

/** Outcome counts of one decision variant over rows. */
function tally(rows, variant, scope) {
  const t = { clusters: 0, auto: 0, correct: 0, wrong: 0, suggest: 0, suggestRight: 0, missed: 0, correctUnknown: 0, known: 0 }
  for (const r of rows) {
    const d = r.decisions[variant]
    if (!d) continue
    const known = scope === 'everyone' ? r.knownAll : r.known
    t.clusters++
    if (known) t.known++
    if (d.band === 'auto') {
      t.auto++
      if (r.truth && d.person === r.truth) t.correct++
      else t.wrong++
    } else if (d.band === 'suggest' || d.band === 'tie') {
      t.suggest++
      if (r.truth && d.candidates.includes(r.truth)) t.suggestRight++
      if (known) t.missed++
      else t.correctUnknown++
    } else if (known) t.missed++
    else t.correctUnknown++
  }
  return {
    ...t,
    coverage: t.known ? round(t.correct / t.known) : null,
    wrongRate: t.auto ? round(t.wrong / t.auto) : null,
    suggestPrecision: t.suggest ? round(t.suggestRight / t.suggest) : null
  }
}

function groupsOf(rows, variant) {
  const g = new Map()
  for (const r of rows) {
    const d = r.decisions[variant]
    if (!d || d.band !== 'auto') continue
    const key = r.truth ?? `unlabelled:${r.tag}`
    const x = g.get(key) ?? { x: 0, n: 0 }
    x.n++
    if (!(r.truth && d.person === r.truth)) x.x++
    g.set(key, x)
  }
  return g
}

/** The gate of one condition: auto-named real clusters, wrong names, both bounds. */
export function gateOf(rows, variant, seed) {
  const real = rows.filter((r) => !r.composed)
  const groups = groupsOf(real, variant)
  let n = 0
  let x = 0
  for (const g of groups.values()) {
    n += g.n
    x += g.x
  }
  const cp = clopperPearsonUpper(x, n)
  const boot = peopleBootstrap(groups, { seed })
  const known = real.filter((r) => r.known).length
  const correct = real.filter((r) => r.decisions[variant]?.band === 'auto' && r.truth && r.decisions[variant].person === r.truth).length
  return {
    autoClusters: n,
    wrongNames: x,
    clopperPearsonUpper: round(cp, 5),
    bootstrapP95: round(boot, 5),
    people: groups.size,
    coverage: known ? round(correct / known) : null,
    pass: n > 0 && cp <= GATE_MAX && boot <= GATE_MAX
  }
}

/** Every condition × variant × scope table, and the gate per condition on the voice set. */
export function summarize(rows, { seed = 1, gateVariant = 'voice:attendees' } = {}) {
  const variants = [...new Set(rows.flatMap((r) => Object.keys(r.decisions)))].sort()
  const byCondition = {}
  for (const ch of CHANNELS)
    for (const lang of LANGUAGES)
      for (const b of BUCKETS) {
        const key = conditionKey(ch, lang, b)
        const these = rows.filter((r) => r.channel === ch && r.language === lang && r.bucket === b && !r.composed)
        if (!these.length) continue
        const entry = { clusters: these.length, variants: {} }
        for (const v of variants) entry.variants[v] = tally(these, v, v.includes(':everyone') ? 'everyone' : 'attendees')
        if (b === '>=30s') entry.gate = gateOf(these, gateVariant, seed)
        byCondition[key] = entry
      }
  const overall = {}
  for (const v of variants) overall[v] = tally(rows.filter((r) => !r.composed), v, v.includes(':everyone') ? 'everyone' : 'attendees')
  const composed = {}
  for (const tag of [...new Set(rows.filter((r) => r.composed).map((r) => r.tag))]) {
    const variant = tag.replace(/^t3-/, '').replace(/-(enroll|test)$/, '')
    composed[variant] ??= {}
    for (const v of ['voice:attendees', 'fused:attendees']) composed[variant][v] = tally(rows.filter((r) => r.tag === tag), v, 'attendees')
  }
  return { variants, overall, byCondition, composed }
}

/** FAR at FRR 5 % per channel, from the voice scores (same channel, enrolled people). */
export function verification(rows) {
  const out = {}
  for (const ch of CHANNELS) {
    const genuine = []
    const impostor = []
    for (const r of rows) {
      if (r.channel !== ch || r.composed) continue
      for (const s of r.scores) {
        if (s.channel !== ch) continue
        if (r.truth && s.person === r.truth) genuine.push(s.cos)
        else impostor.push(s.cos)
      }
    }
    const f = farAtFrr(genuine, impostor, 0.05)
    out[ch] = { genuine: genuine.length, impostor: impostor.length, farAtFrr5: f ? round(f.far) : null, threshold: f ? round(f.threshold) : null }
  }
  return out
}

/**
 * The fitted candidate: the logistic per condition (pooled per channel
 * when a condition is short of trials), `tauSuggest` (≥ 90 % right among suggestions), `tauAuto`
 * for `≥30s` (the lowest threshold whose simulated auto set passes both bounds), and `farCosine`.
 * `tieMargin`, `margin` and the fusion weights keep the shipped values. `autoEnabled` is set
 * true on every `≥30s` condition here only so the next launch can measure would-be autos;
 * the written file takes it from the production gate.
 */
export function fitCandidate(rows, shipped, { modelId, seed = 1, createdAt }) {
  const real = rows.filter((r) => !r.composed)
  const trials = (filter) => {
    const xs = []
    const ys = []
    for (const r of real) {
      if (!filter(r)) continue
      for (const s of r.scores) {
        if (s.channel !== r.channel) continue
        xs.push(s.cos)
        ys.push(r.truth && s.person === r.truth ? 1 : 0)
      }
    }
    return { xs, ys, genuine: ys.filter(Boolean).length, impostor: ys.filter((y) => !y).length }
  }
  const enough = (t) => t.genuine >= 20 && t.impostor >= 20
  const conditions = []
  const fitNotes = {}
  for (const c of shipped.conditions) {
    const mine = (r) => r.channel === c.channel && r.language === c.language && r.bucket === c.bucket
    let t = trials(mine)
    let source = 'condition'
    if (!enough(t)) {
      t = trials((r) => r.channel === c.channel)
      source = 'channel-pooled'
    }
    const logistic = enough(t) ? fitLogistic(t.xs, t.ys, c.logistic) : c.logistic
    if (!enough(t)) source = 'prior'
    const these = real.filter(mine)
    const pTop = (r) => {
      const cand = r.scores.filter((s) => s.channel === r.channel && (s.attendee || s.self)).map((s) => ({ person: s.person, p: sigmoid(logistic.a * s.cos + logistic.b) }))
      cand.sort((a, b) => b.p - a.p)
      return { top: cand[0] ?? null, second: cand[1] ?? null }
    }
    let tauSuggest = c.tauSuggest
    for (let tau = 0.5; tau <= 0.99; tau += 0.01) {
      const picked = these.map(pTop).map((x, i) => ({ ...x, r: these[i] })).filter((x) => x.top && x.top.p >= tau)
      if (picked.length < 10) break
      if (picked.filter((x) => x.r.truth === x.top.person).length / picked.length >= 0.9) {
        tauSuggest = round(tau, 2)
        break
      }
    }
    let tauAuto = c.tauAuto
    let sim = { autoClusters: 0, wrongNames: 0, upper: null, coverage: null }
    if (c.bucket === '>=30s') {
      for (let tau = 0.8; tau < 0.9995; tau += 0.0025) {
        const groups = new Map()
        let n = 0
        let x = 0
        let correct = 0
        for (const r of these) {
          const { top, second } = pTop(r)
          if (!top || top.p < tau || top.p - (second?.p ?? 0) < c.margin) continue
          n++
          const wrong = r.truth !== top.person
          if (wrong) x++
          else correct++
          const g = groups.get(r.truth ?? `unlabelled:${r.tag}`) ?? { x: 0, n: 0 }
          g.n++
          if (wrong) g.x++
          groups.set(r.truth ?? `unlabelled:${r.tag}`, g)
        }
        if (!n) break
        const cp = clopperPearsonUpper(x, n)
        if (cp <= GATE_MAX && peopleBootstrap(groups, { seed }) <= GATE_MAX) {
          tauAuto = round(tau, 4)
          const known = these.filter((r) => r.known).length
          sim = { autoClusters: n, wrongNames: x, upper: round(cp, 5), coverage: known ? round(correct / known) : null }
          break
        }
      }
    }
    fitNotes[conditionKey(c.channel, c.language, c.bucket)] = { logistic: source, trials: t.genuine + t.impostor }
    conditions.push({
      ...c,
      autoEnabled: c.bucket === '>=30s',
      tauAuto,
      tauSuggest,
      logistic,
      autoClusters: sim.autoClusters,
      wrongNames: sim.wrongNames,
      wrongNameUpper: sim.upper,
      coverage: sim.coverage
    })
  }
  const farCosine = { ...shipped.farCosine }
  for (const ch of CHANNELS) {
    const genuine = real.flatMap((r) => (r.channel === ch ? r.scores.filter((s) => s.channel === ch && s.person === r.truth).map((s) => s.cos) : [])).sort((a, b) => a - b)
    if (genuine.length >= 50) farCosine[ch] = round(Math.min(0.6, Math.max(0.1, genuine[Math.floor(genuine.length * 0.01)])), 3)
  }
  return {
    file: { ...shipped, modelSha: modelId ?? shipped.modelSha, createdAt, conditions, farCosine },
    notes: fitNotes
  }
}

/** The file to write: `autoEnabled` from the production gate (`≥30s` only), and its numbers. */
export function finalCalibration(candidate, summary, { reportHash, benchVersion }) {
  const conditions = candidate.conditions.map((c) => {
    const g = summary.byCondition[conditionKey(c.channel, c.language, c.bucket)]?.gate
    if (c.bucket !== '>=30s') return { ...c, autoEnabled: false }
    return {
      ...c,
      autoEnabled: !!g?.pass,
      autoClusters: g?.autoClusters ?? 0,
      wrongNames: g?.wrongNames ?? 0,
      wrongNameUpper: g ? Math.max(g.clopperPearsonUpper, g.bootstrapP95) : null,
      coverage: g?.coverage ?? null
    }
  })
  return { ...candidate, reportHash, benchVersion, conditions }
}

/** Coverage drops of more than 5 points against the previous file (each needs a reason in the commit). */
export function coverageDrops(previous, next) {
  const drops = []
  for (const c of next.conditions) {
    const p = previous.conditions.find((x) => x.channel === c.channel && x.language === c.language && x.bucket === c.bucket)
    if (p?.coverage != null && c.coverage != null && p.coverage - c.coverage > 0.05) drops.push({ condition: conditionKey(c.channel, c.language, c.bucket), from: p.coverage, to: c.coverage })
  }
  return drops
}

/** A1 on every dump: no two clusters of one note auto-named as the same person. */
export function a1(feeds) {
  let notes = 0
  let violations = 0
  for (const f of feeds) {
    const autos = f.clusters.filter((c) => c.band === 'auto' && c.auto && c.auto.person !== 'other').map((c) => c.auto.person)
    if (!f.clusters.length) continue
    notes++
    if (new Set(autos).size !== autos.length) violations++
  }
  return { id: 'A1', status: notes ? (violations ? 'fail' : 'pass') : 'n/a', detail: { notes, violations } }
}

/** DER per channel over the baseline feeds (frame level, word-timed hypotheses). */
export function derSummary(feeds, ctx) {
  const out = {}
  for (const ch of CHANNELS) {
    let ref = 0
    let weighted = 0
    let meetings = 0
    for (const f of feeds) {
      const m = ctx.meetingOfTag(f.tag)
      if (!m || m.composed || f.tag.startsWith('t2:')) continue
      const reference = m.labels.filter((l) => l.channel === ch)
      const hypothesis = f.clusters.filter((c) => c.channel === ch).flatMap((c) => c.segments.map(([s, e]) => ({ id: c.key, startMs: s, endMs: e })))
      const d = der(reference, hypothesis)
      if (!d) continue
      meetings++
      ref += d.refSeconds
      weighted += d.der * d.refSeconds
    }
    out[ch] = { meetings, refSeconds: round(ref, 1), der: ref ? round(weighted / ref) : null }
  }
  return out
}

/** CPU of the pass per hour of audio (cumulative CPU of each utility process, and the pass's wall time). */
export function cpuSummary(feeds) {
  let audioMs = 0
  let passMs = 0
  let passes = 0
  const cpu = {}
  for (const f of feeds) {
    audioMs += f.audioMs
    for (const [k, v] of Object.entries(f.cpuSeconds ?? {})) cpu[k] = (cpu[k] ?? 0) + v
    const t = f.job?.times ?? {}
    const start = t.diarizing ?? t.queued
    const end = Math.max(...['done', 'failed', 'deciding'].map((s) => t[s] ?? 0))
    if (start && end > start) {
      passMs += end - start
      passes++
    }
  }
  const hours = audioMs / 3_600_000
  const perHour = {}
  for (const [k, v] of Object.entries(cpu)) if (/diarize|asr|speech|storage/i.test(k)) perHour[k] = hours ? round(v / hours, 1) : null
  return { audioHours: round(hours, 3), passes, passWallSecondsPerAudioHour: hours && passes ? round(passMs / 1000 / hours, 1) : null, cpuSecondsPerAudioHour: perHour }
}

/** T2: the app rule's outcomes per platform variant (production bands of the replays). */
export function t2Summary(feeds, ctx) {
  const out = {}
  for (const f of feeds) {
    const m = /^t2:(.+):([^:]+)$/.exec(f.tag)
    if (!m) continue
    const meeting = ctx.meetingOfTag(f.tag)
    if (!meeting) continue
    const v = (out[m[2]] ??= { replays: 0, systemClusters: 0, appAuto: 0, appCorrect: 0, appWrong: 0, labelled: 0 })
    v.replays++
    for (const c of f.clusters) {
      if (c.channel !== 'system') continue
      v.systemClusters++
      const truth = truthOf(c.segments, c.channel, meeting.labels)
      if (truth) v.labelled++
      if (c.band === 'auto' && c.auto?.src?.includes('app')) {
        v.appAuto++
        if (truth && c.auto.person === truth) v.appCorrect++
        else v.appWrong++
      }
    }
  }
  for (const v of Object.values(out)) {
    v.precision = v.appAuto ? round(v.appCorrect / v.appAuto) : null
    v.coverage = v.labelled ? round(v.appCorrect / v.labelled) : null
  }
  return out
}
