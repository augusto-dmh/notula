// SPDX-License-Identifier: Apache-2.0
// The speaker bench's statistics: the one-sided Clopper–Pearson bound,
// the people bootstrap, FAR at a fixed FRR, a two-parameter logistic fit, the Hungarian
// assignment and a frame-level DER. Plain JavaScript, no dependency.

/** A seeded PRNG (mulberry32): the same seed gives the same bootstrap and the same split. */
export function rng(seed) {
  let a = seed >>> 0 || 1
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export function shuffle(list, rand) {
  const out = [...list]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[out[i], out[j]] = [out[j], out[i]]
  }
  return out
}

function lgamma(x) {
  // Lanczos, g = 7.
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
  x -= 1
  let a = c[0]
  const t = x + 7.5
  for (let i = 1; i < 9; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

function betacf(a, b, x) {
  const MAXIT = 300
  const EPS = 3e-14
  const FPMIN = 1e-300
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - (qab * x) / qap
  if (Math.abs(d) < FPMIN) d = FPMIN
  d = 1 / d
  let h = d
  for (let m = 1; m <= MAXIT; m++) {
    const m2 = 2 * m
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    h *= d * c
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2))
    d = 1 + aa * d
    if (Math.abs(d) < FPMIN) d = FPMIN
    c = 1 + aa / c
    if (Math.abs(c) < FPMIN) c = FPMIN
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < EPS) break
  }
  return h
}

/** The regularized incomplete beta I_x(a, b). */
export function ibeta(x, a, b) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(lgamma(a + b) - lgamma(a) - lgamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b
}

/** The q-quantile of Beta(a, b), by bisection. */
export function betaQuantile(q, a, b) {
  let lo = 0
  let hi = 1
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2
    if (ibeta(mid, a, b) < q) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * The one-sided upper bound of a binomial rate: `x` errors in `n` trials, at confidence `conf`
 * (Clopper–Pearson). n = 0 gives 1 (nothing is known); x = 0 gives 1 − (1 − conf)^(1/n).
 */
export function clopperPearsonUpper(x, n, conf = 0.95) {
  if (n <= 0) return 1
  if (x >= n) return 1
  return betaQuantile(conf, x + 1, n - x)
}

/**
 * The people bootstrap: people are resampled with replacement, and each replicate's
 * rate is the pooled errors over the pooled trials of the people drawn. Returns the `q`
 * quantile of the replicates (1 when no trial exists).
 */
export function peopleBootstrap(groups, { replicates = 2000, q = 0.95, seed = 1 } = {}) {
  const people = [...groups.values()].filter((g) => g.n > 0)
  if (!people.length) return 1
  const rand = rng(seed)
  const rates = []
  for (let r = 0; r < replicates; r++) {
    let x = 0
    let n = 0
    for (let i = 0; i < people.length; i++) {
      const g = people[Math.floor(rand() * people.length)]
      x += g.x
      n += g.n
    }
    rates.push(n ? x / n : 0)
  }
  rates.sort((a, b) => a - b)
  return rates[Math.min(rates.length - 1, Math.floor(q * rates.length))]
}

/** FAR at the threshold where FRR = `frr` (genuine scores below it are rejected). */
export function farAtFrr(genuine, impostor, frr = 0.05) {
  if (!genuine.length || !impostor.length) return null
  const g = [...genuine].sort((a, b) => a - b)
  const threshold = g[Math.min(g.length - 1, Math.floor(frr * g.length))]
  const far = impostor.filter((s) => s >= threshold).length / impostor.length
  return { threshold, far }
}

/**
 * Maximum-likelihood logistic P(y = 1 | x) = σ(a·x + b), by damped Newton steps (each step is
 * halved until the penalized log-likelihood rises) with a light ridge toward the prior.
 */
export function fitLogistic(xs, ys, prior = { a: 12, b: -6 }) {
  const ridge = 1e-3
  const ll = (a, b) => {
    let s = -0.5 * ridge * ((a - prior.a) ** 2 + (b - prior.b) ** 2)
    for (let i = 0; i < xs.length; i++) {
      const z = a * xs[i] + b
      // log σ(z) and log(1 − σ(z)), stable for large |z|.
      s += ys[i] ? -Math.log1p(Math.exp(-z)) : -Math.log1p(Math.exp(z))
    }
    return s
  }
  let a = 0
  let b = 0
  for (let it = 0; it < 100; it++) {
    let ga = -ridge * (a - prior.a)
    let gb = -ridge * (b - prior.b)
    let haa = -ridge
    let hab = 0
    let hbb = -ridge
    for (let i = 0; i < xs.length; i++) {
      const p = 1 / (1 + Math.exp(-(a * xs[i] + b)))
      const r = ys[i] - p
      ga += r * xs[i]
      gb += r
      const w = p * (1 - p)
      haa -= w * xs[i] * xs[i]
      hab -= w * xs[i]
      hbb -= w
    }
    const det = haa * hbb - hab * hab
    if (!Number.isFinite(det) || Math.abs(det) < 1e-12) break
    const da = (hbb * ga - hab * gb) / det
    const db = (haa * gb - hab * ga) / det
    const before = ll(a, b)
    let step = 1
    while (step > 1e-6 && ll(a - step * da, b - step * db) < before) step /= 2
    a -= step * da
    b -= step * db
    if (step * (Math.abs(da) + Math.abs(db)) < 1e-9) break
  }
  return { a: Math.round(a * 1000) / 1000, b: Math.round(b * 1000) / 1000 }
}

/** Min-cost assignment of a rectangular cost matrix (rows → columns, −1 when unassigned). */
export function hungarian(cost) {
  const rows = cost.length
  const cols = rows ? cost[0].length : 0
  const n = Math.max(rows, cols)
  if (!n) return []
  const big = Math.max(1, ...cost.flat().map(Math.abs)) * 10
  const a = Array.from({ length: n + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => (i && j && i <= rows && j <= cols ? cost[i - 1][j - 1] : i && j ? big : 0)))
  const u = new Array(n + 1).fill(0)
  const v = new Array(n + 1).fill(0)
  const p = new Array(n + 1).fill(0)
  const way = new Array(n + 1).fill(0)
  for (let i = 1; i <= n; i++) {
    p[0] = i
    let j0 = 0
    const minv = new Array(n + 1).fill(Infinity)
    const used = new Array(n + 1).fill(false)
    do {
      used[j0] = true
      const i0 = p[j0]
      let delta = Infinity
      let j1 = 0
      for (let j = 1; j <= n; j++) {
        if (used[j]) continue
        const cur = a[i0][j] - u[i0] - v[j]
        if (cur < minv[j]) {
          minv[j] = cur
          way[j] = j0
        }
        if (minv[j] < delta) {
          delta = minv[j]
          j1 = j
        }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) {
          u[p[j]] += delta
          v[j] -= delta
        } else minv[j] -= delta
      }
      j0 = j1
    } while (p[j0] !== 0)
    do {
      const j1 = way[j0]
      p[j0] = p[j1]
      j0 = j1
    } while (j0)
  }
  const out = new Array(rows).fill(-1)
  for (let j = 1; j <= n; j++) if (p[j] && p[j] <= rows && j <= cols) out[p[j] - 1] = j - 1
  return out
}

/**
 * Frame-level DER (10 ms frames) of one channel: reference spans by person against hypothesis
 * segments by cluster, with the cluster → person mapping that maximizes overlap. Word-timed
 * hypotheses miss inter-word gaps, so this reads as a word-level DER.
 */
export function der(reference, hypothesis, frameMs = 10) {
  const refPeople = [...new Set(reference.map((r) => r.person))]
  const hypIds = [...new Set(hypothesis.map((h) => h.id))]
  const end = Math.max(0, ...reference.map((r) => r.endMs), ...hypothesis.map((h) => h.endMs))
  const frames = Math.ceil(end / frameMs)
  if (!frames || !refPeople.length) return null
  const refAt = refPeople.map(() => new Uint8Array(frames))
  const hypAt = hypIds.map(() => new Uint8Array(frames))
  const mark = (arr, s, e) => {
    for (let f = Math.max(0, Math.floor(s / frameMs)); f < Math.min(frames, Math.ceil(e / frameMs)); f++) arr[f] = 1
  }
  for (const r of reference) mark(refAt[refPeople.indexOf(r.person)], r.startMs, r.endMs)
  for (const h of hypothesis) mark(hypAt[hypIds.indexOf(h.id)], h.startMs, h.endMs)
  const overlap = hypIds.map((_, i) => refPeople.map((_, j) => {
    let o = 0
    for (let f = 0; f < frames; f++) if (hypAt[i][f] && refAt[j][f]) o++
    return -o
  }))
  const map = hungarian(overlap)
  let total = 0
  let miss = 0
  let fa = 0
  let conf = 0
  for (let f = 0; f < frames; f++) {
    let nRef = 0
    let nHyp = 0
    let correct = 0
    for (let j = 0; j < refPeople.length; j++) nRef += refAt[j][f]
    for (let i = 0; i < hypIds.length; i++) {
      if (!hypAt[i][f]) continue
      nHyp++
      const j = map[i]
      if (j >= 0 && refAt[j][f]) correct++
    }
    total += nRef
    miss += Math.max(0, nRef - nHyp)
    fa += Math.max(0, nHyp - nRef)
    conf += Math.min(nRef, nHyp) - correct
  }
  return total ? { der: (miss + fa + conf) / total, miss: miss / total, falseAlarm: fa / total, confusion: conf / total, refSeconds: (total * frameMs) / 1000 } : null
}

export function round(x, digits = 4) {
  if (x === null || x === undefined || !Number.isFinite(x)) return x ?? null
  const f = 10 ** digits
  return Math.round(x * f) / f
}
