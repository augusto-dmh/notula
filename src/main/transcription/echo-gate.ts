// SPDX-License-Identifier: Apache-2.0
// The mic's echo gate. Without headphones, remote voices played by the speakers leak back
// into the microphone; the platform echo cancellation removes most of it, but not always all
// of it (a reverberant room, a fallback without system-wide cancellation, a device that drops
// it). The local engine's gate is built for quiet sources and normalizes gain, so even a
// −30 dB residue is transcribed again on the mic, as extra unnamed speakers. This gate turns
// mic frames down to the mic's noise floor while they hold nothing but that echo, before ASR
// and the diarization tee. Pure: no Electron, no Node built-ins, so scripts/dev/echo-gate-check.ts
// runs it.
//
// - Frames: 20 ms on each channel, analysed in 12 bands from 200 Hz to 6 kHz over a 32 ms
//   window.
// - Armed only on evidence: in 3 s blocks, over the frames where the system channel speaks,
//   the mic's speech-band level is correlated with the system's at each lag from −100 to
//   +600 ms. A block whose best lag reaches 0.7 is evidence. The gate arms when 2 of the
//   last 10 such blocks agree on the lag (±20 ms), and disarms when none of them is
//   evidence. Only a block in which system speech leaves the mic near its floor counts
//   against the echo; one where the mic is busy (the user talking) counts neither way, so a
//   long stretch of double talk doesn't disarm the gate. Headphones, or the user talking over
//   a video, give no evidence: the gate stays open.
// - The echo estimate per band: the system's level at that lag (±20 ms), with a 0.55 s decay
//   tail for the room, times a coupling learned as the running median of mic/estimate during
//   system speech.
// - A frame is the user's (near end) when what the estimate and the noise floor can't
//   explain, with a 10 dB margin on the estimate, is 6 dB over the noise floor. The 60 ms
//   before and the 200 ms after such a frame stay as they are.
// - Any other frame whose echo estimate is 3 dB over the noise floor is scaled down to the
//   mic's noise floor (never to digital silence, which would change the ASR gate's floor).
//
// The mic is held until the system channel has covered its time plus 100 ms (at most 300 ms),
// so system audio that arrives a batch late still counts. Batches come out in order, with
// their capture times, as many samples as went in.

const RATE = 16_000
const FRAME = 320
const FRAME_MS = 20
const WIN = 512
const BAND_EDGES_HZ = [200, 266, 353, 469, 623, 827, 1098, 1458, 1937, 2572, 3416, 4537, 6000]
const BANDS = BAND_EDGES_HZ.length - 1
/** Lags of the mic behind the system, in frames: −100 ms to +600 ms. */
const LAG_MIN = -5
const LAG_MAX = 30
const LOOKAHEAD_MS = 100
const MAX_HOLD_MS = 300
/** Frames of near-end decision kept before (lookahead) and after (hangover) a near-end frame. */
const KEEP_BEFORE = 3
const KEEP_AFTER = 10
/** The system speaks when its speech-band level is 12 dB over its floor and above −85 dBFS. */
const SYS_ACTIVE_DB = 12
const SYS_ABS_DB = -85
/** Floor trackers fall at once and rise 1 dB/s. */
const FLOOR_RISE_DB = 0.02
const FLOOR_MIN_DB = -110
/**
 * Evidence blocks: 3 s, a lag needing 60 frames of system speech. Shorter blocks hold too few
 * syllables (with headphones, chance alone passed 0.7); longer ones mix in the user's turns.
 */
const BLOCK = 150
const BLOCK_MIN_FRAMES = 60
const EVIDENCE_RHO = 0.7
const EVIDENCE_BLOCKS = 10
const ARM_SUPPORT = 2
const DISARM_SUPPORT = 1
/** A weak block counts against the echo when the mic stays within 10 dB of its floor in half its system-speech frames. */
const QUIET_OVER_FLOOR_DB = 10
const QUIET_SHARE = 0.5
/** The room's tail: −2.2 dB per frame (−60 dB in about 0.55 s). */
const TAIL = 10 ** (-2.2 / 10)
/** The coupling's running median moves 0.25 dB per system-speech frame. */
const COUPLING_STEP_DB = 0.25
const NEAR_MARGIN = 10
const NEAR_OVER_FLOOR = 10 ** (6 / 10)
const ECHO_OVER_FLOOR = 10 ** (3 / 10)
const RAMP = 80
/** Band powers are smoothed with this weight on the previous frame. */
const SMOOTH = 0.5

const db = (p: number): number => 10 * Math.log10(Math.max(p, 1e-14))

/** In-place radix-2 FFT of `re`/`im` (length a power of two). */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) {
      const tr = re[i] as number
      re[i] = re[j] as number
      re[j] = tr
      const ti = im[i] as number
      im[i] = im[j] as number
      im[j] = ti
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len
    const wr = Math.cos(ang)
    const wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1
      let ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k
        const b = a + len / 2
        const xr = (re[b] as number) * cr - (im[b] as number) * ci
        const xi = (re[b] as number) * ci + (im[b] as number) * cr
        re[b] = (re[a] as number) - xr
        im[b] = (im[a] as number) - xi
        re[a] = (re[a] as number) + xr
        im[a] = (im[a] as number) + xi
        const nr = cr * wr - ci * wi
        ci = cr * wi + ci * wr
        cr = nr
      }
    }
  }
}

const HANN = Float64Array.from({ length: WIN }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / WIN))
const BAND_BINS = BAND_EDGES_HZ.map((hz) => Math.round((hz * WIN) / RATE))

/** One channel's sample stream cut into 20 ms frames, each with its band powers. */
class Analyzer {
  private readonly ring = new Float64Array(WIN)
  /** Where the next sample goes; the oldest sample sits there too. */
  private at = 0
  private pending = 0
  private readonly re = new Float64Array(WIN)
  private readonly im = new Float64Array(WIN)

  /** Adds one sample; returns the band powers when it completes a frame. */
  push(v: number): Float64Array | null {
    this.ring[this.at] = v
    this.at = (this.at + 1) % WIN
    if (++this.pending < FRAME) return null
    this.pending = 0
    for (let i = 0; i < WIN; i++) {
      this.re[i] = (this.ring[(this.at + i) % WIN] as number) * (HANN[i] as number)
      this.im[i] = 0
    }
    fft(this.re, this.im)
    const bands = new Float64Array(BANDS)
    for (let b = 0; b < BANDS; b++) {
      let p = 0
      for (let k = BAND_BINS[b] as number; k < (BAND_BINS[b + 1] as number); k++) p += (this.re[k] as number) ** 2 + (this.im[k] as number) ** 2
      bands[b] = p / (WIN * WIN)
    }
    return bands
  }
}

/** Falls at once, rises 1 dB/s: the lowest recent level, in dB. */
class FloorTracker {
  value = FLOOR_MIN_DB
  private started = false

  update(levelDb: number): number {
    const x = Math.max(levelDb, FLOOR_MIN_DB)
    if (!this.started || x < this.value) {
      this.value = x
      this.started = true
    } else this.value += FLOOR_RISE_DB
    return this.value
  }
}

interface MicBatch {
  pcm: Buffer
  captureTimeMs: number
  /** Global index of its first sample. */
  first: number
  length: number
}

interface MicFrame {
  timeMs: number
  near: boolean
  echo: boolean
  /** The gain that brings the frame down to the noise floor (≤ 1). */
  floorGain: number
}

export interface EchoGateStats {
  frames: number
  armedFrames: number
  gatedFrames: number
  nearFrames: number
  /** The lag of the best correlation, in ms, while armed. */
  lagMs: number | null
  rho: number
}

export class EchoGate {
  private readonly sysAnalyzer = new Analyzer()
  private readonly micAnalyzer = new Analyzer()
  /** System frames by their 20 ms slot on the capture clock: band powers and speech-band total. */
  private readonly sys = new Map<number, { bands: Float64Array; total: number; active: boolean }>()
  /** The capture time the system channel has covered up to (−∞ before any). */
  private sysCoveredMs = -Infinity
  private readonly sysFloor = new FloorTracker()
  private readonly micFloor = new FloorTracker()
  private readonly micBandFloor = Array.from({ length: BANDS }, () => new FloorTracker())

  private readonly batches: MicBatch[] = []
  /** Mic samples received and analysed (global indices). */
  private micReceived = 0
  private micAnalysed = 0
  private readonly frames: MicFrame[] = []
  /** Global frame index of `frames[0]`. */
  private frameBase = 0
  /** Frames whose gain is final, from `frameBase`. */
  private readonly gains: number[] = []
  private lastNear = -Infinity
  /** The gain of frame `frameBase − 1`, where the next ramp starts. */
  private prevGain = 1
  /** Mic band powers, smoothed over ~60 ms. */
  private readonly smooth = new Float64Array(BANDS)

  /** The current block's correlation sums, per lag. */
  private readonly corr = Array.from({ length: LAG_MAX - LAG_MIN + 1 }, () => ({ w: 0, x: 0, y: 0, xx: 0, yy: 0, xy: 0 }))
  private blockFrames = 0
  /** The block's system-speech frames at the current lag, and those in which the mic stayed quiet. */
  private blockFar = 0
  private blockQuiet = 0
  /** The best lag of each recent block with enough system speech, and its correlation. */
  private readonly evidence: { lag: number; rho: number }[] = []
  private armed = false
  private lag = 0
  private rho = 0
  /** Coupling per band, in dB (null until the first system-speech frame while armed). */
  private readonly coupling: (number | null)[] = Array.from({ length: BANDS }, () => null)
  private readonly tail = new Float64Array(BANDS)
  readonly stats: EchoGateStats = { frames: 0, armedFrames: 0, gatedFrames: 0, nearFrames: 0, lagMs: null, rho: 0 }

  private readonly emit: (pcm: Buffer, captureTimeMs: number) => void

  // A plain field rather than a parameter property, so scripts/dev/echo-gate-check.ts runs under Node's type stripping.
  constructor(emit: (pcm: Buffer, captureTimeMs: number) => void) {
    this.emit = emit
  }

  system(pcm: Buffer, captureTimeMs: number): void {
    const n = pcm.byteLength >> 1
    for (let i = 0; i < n; i++) {
      const bands = this.sysAnalyzer.push(pcm.readInt16LE(i * 2) / 32768)
      if (!bands) continue
      const end = captureTimeMs + ((i + 1) * 1000) / RATE
      const total = bands.reduce((a, b) => a + b, 0)
      const level = db(total)
      const floor = this.sysFloor.update(level)
      this.sys.set(Math.round((end - FRAME_MS) / FRAME_MS), { bands, total, active: level > floor + SYS_ACTIVE_DB && level > SYS_ABS_DB })
    }
    this.sysCoveredMs = Math.max(this.sysCoveredMs, captureTimeMs + (n * 1000) / RATE)
    // Two seconds of system frames are enough for every lag.
    const oldest = Math.round(this.sysCoveredMs / FRAME_MS) - 100
    for (const k of this.sys.keys()) if (k < oldest) this.sys.delete(k)
    this.analyse(false)
  }

  mic(pcm: Buffer, captureTimeMs: number): void {
    const length = pcm.byteLength >> 1
    this.batches.push({ pcm, captureTimeMs, first: this.micReceived, length })
    this.micReceived += length
    this.analyse(false)
  }

  /** Releases every held batch (at a stop). */
  flush(): void {
    this.analyse(true)
    this.release(true)
  }

  /** The capture time of a held mic sample. */
  private timeOf(sample: number): number {
    for (let i = this.batches.length - 1; i >= 0; i--) {
      const b = this.batches[i] as MicBatch
      if (sample >= b.first) return b.captureTimeMs + ((sample - b.first) * 1000) / RATE
    }
    return 0
  }

  private sampleAt(sample: number): number {
    for (const b of this.batches) {
      if (sample < b.first + b.length) return b.pcm.readInt16LE((sample - b.first) * 2) / 32768
    }
    return 0
  }

  private analyse(force: boolean): void {
    const newest = this.micReceived ? this.timeOf(this.micReceived - 1) : 0
    while (this.micAnalysed + FRAME <= this.micReceived) {
      const start = this.timeOf(this.micAnalysed)
      const ready = this.sysCoveredMs >= start + FRAME_MS + LOOKAHEAD_MS || newest - start >= MAX_HOLD_MS || force
      if (!ready) break
      let bands: Float64Array | null = null
      let energy = 0
      for (let i = 0; i < FRAME; i++) {
        const v = this.sampleAt(this.micAnalysed + i)
        energy += v * v
        bands = this.micAnalyzer.push(v) ?? bands
      }
      this.micAnalysed += FRAME
      this.frames.push(this.decide(start, bands as Float64Array, energy / FRAME))
    }
    this.settle(force)
    this.release(false)
  }

  private decide(timeMs: number, bands: Float64Array, power: number): MicFrame {
    this.stats.frames++
    const slot = Math.round(timeMs / FRAME_MS)
    const total = bands.reduce((a, b) => a + b, 0)
    const levelDb = db(total)
    const floorDb = this.micFloor.update(db(power))
    for (let b = 0; b < BANDS; b++) this.smooth[b] = SMOOTH * (this.smooth[b] as number) + (1 - SMOOTH) * (bands[b] as number)
    const bandFloor = Array.from(this.smooth, (p, b) => 10 ** ((this.micBandFloor[b] as FloorTracker).update(db(p)) / 10))
    const floor = bandFloor.reduce((a, b) => a + b, 0)
    const floorGain = Math.min(1, Math.sqrt(10 ** (floorDb / 10) / Math.max(power, 1e-14)))

    // The correlation of mic level with the system's level, per lag, over system speech.
    for (let l = LAG_MIN; l <= LAG_MAX; l++) {
      const s = this.sys.get(slot - l)
      if (!s?.active) continue
      const c = this.corr[l - LAG_MIN] as { w: number; x: number; y: number; xx: number; yy: number; xy: number }
      const y = db(s.total)
      c.w++
      c.x += levelDb
      c.y += y
      c.xx += levelDb * levelDb
      c.yy += y * y
      c.xy += levelDb * y
    }
    if (this.sys.get(slot - this.lag)?.active) {
      this.blockFar++
      if (levelDb < db(floor) + QUIET_OVER_FLOOR_DB) this.blockQuiet++
    }
    if (++this.blockFrames >= BLOCK) this.closeBlock()

    // The echo estimate: the system at the lag (±1 frame), with the room's tail.
    let sysActive = false
    for (let b = 0; b < BANDS; b++) {
      let direct = 0
      for (let l = this.lag - 1; l <= this.lag + 1; l++) {
        const s = this.sys.get(slot - l)
        if (!s) continue
        direct = Math.max(direct, s.bands[b] as number)
        if (b === 0) sysActive ||= s.active
      }
      this.tail[b] = Math.max(direct, (this.tail[b] as number) * TAIL)
    }
    if (!this.armed) return { timeMs, near: false, echo: false, floorGain }
    this.stats.armedFrames++

    let echo = 0
    let unexplained = 0
    for (let b = 0; b < BANDS; b++) {
      const t = this.tail[b] as number
      const m = this.smooth[b] as number
      if (sysActive && t > 0) {
        const r = db(m) - db(t)
        const c = this.coupling[b] ?? null
        this.coupling[b] = c === null ? r : c + (r > c ? COUPLING_STEP_DB : -COUPLING_STEP_DB)
      }
      const c = this.coupling[b] ?? null
      const e = c === null ? 0 : t * 10 ** (c / 10)
      const f = bandFloor[b] as number
      echo += e
      unexplained += Math.max(0, m - NEAR_MARGIN * e - f)
    }
    const near = unexplained > NEAR_OVER_FLOOR * floor
    if (near) this.stats.nearFrames++
    return { timeMs, near, echo: echo > ECHO_OVER_FLOOR * floor, floorGain }
  }

  /** Ends a 1 s block: its best lag becomes evidence, and the gate arms or disarms on it. */
  private closeBlock(): void {
    let best = -Infinity
    let bestLag = 0
    for (let l = LAG_MIN; l <= LAG_MAX; l++) {
      const c = this.corr[l - LAG_MIN] as { w: number; x: number; y: number; xx: number; yy: number; xy: number }
      if (c.w >= BLOCK_MIN_FRAMES) {
        const vx = c.xx / c.w - (c.x / c.w) ** 2
        const vy = c.yy / c.w - (c.y / c.w) ** 2
        const rho = vx > 1e-6 && vy > 1e-6 ? (c.xy / c.w - (c.x / c.w) * (c.y / c.w)) / Math.sqrt(vx * vy) : 0
        if (rho > best) {
          best = rho
          bestLag = l
        }
      }
      c.w = c.x = c.y = c.xx = c.yy = c.xy = 0
    }
    const quiet = this.blockFar > 0 && this.blockQuiet >= QUIET_SHARE * this.blockFar
    this.blockFrames = this.blockFar = this.blockQuiet = 0
    // Too little system speech in this block to say anything, or a busy mic that hides the echo.
    if (best === -Infinity || (best < EVIDENCE_RHO && !quiet)) return
    this.evidence.push({ lag: bestLag, rho: best })
    if (this.evidence.length > EVIDENCE_BLOCKS) this.evidence.shift()
    // The lag most strong blocks agree on (±1 frame).
    const strong = this.evidence.filter((e) => e.rho >= EVIDENCE_RHO)
    let support = 0
    let lag = this.lag
    for (const e of strong) {
      const n = strong.filter((o) => Math.abs(o.lag - e.lag) <= 1).length
      if (n > support) {
        support = n
        lag = e.lag
      }
    }
    if (!this.armed && support >= ARM_SUPPORT) this.armed = true
    else if (this.armed && support < DISARM_SUPPORT) this.armed = false
    if (support >= DISARM_SUPPORT) this.lag = lag
    this.rho = Math.max(best, 0)
    this.stats.rho = this.rho
    this.stats.lagMs = this.armed ? this.lag * FRAME_MS : null
  }

  /** Fixes the gain of every frame whose lookahead is decided. */
  private settle(force: boolean): void {
    const decided = this.frameBase + this.frames.length
    let k = this.frameBase + this.gains.length
    for (; k < decided; k++) {
      if (!force && k + KEEP_BEFORE >= decided) break
      let nearSoon = false
      for (let j = k; j <= Math.min(k + KEEP_BEFORE, decided - 1); j++) nearSoon ||= (this.frames[j - this.frameBase] as MicFrame).near
      const f = this.frames[k - this.frameBase] as MicFrame
      if (f.near) this.lastNear = k
      const keep = nearSoon || k - this.lastNear <= KEEP_AFTER
      const gated = f.echo && !keep
      if (gated) this.stats.gatedFrames++
      this.gains.push(gated ? f.floorGain : 1)
    }
  }

  /** Emits every batch whose samples all have a gain. */
  private release(force: boolean): void {
    while (this.batches.length) {
      const b = this.batches[0] as MicBatch
      const settled = (this.frameBase + this.gains.length) * FRAME
      if (!force && b.first + b.length > settled) break
      this.batches.shift()
      let out: Buffer | null = null
      for (let i = 0; i < b.length; i++) {
        const k = Math.floor((b.first + i) / FRAME) - this.frameBase
        const gain = (j: number): number => (j < 0 ? this.prevGain : j < this.gains.length ? (this.gains[j] as number) : 1)
        // A 5 ms ramp from the previous frame's gain, so the gate never clicks.
        const pos = (b.first + i) % FRAME
        const from = gain(k - 1)
        const to = gain(k)
        const g = pos < RAMP ? from + ((to - from) * (pos + 1)) / RAMP : to
        if (g === 1 && !out) continue
        out ??= Buffer.from(b.pcm)
        out.writeInt16LE(Math.round(b.pcm.readInt16LE(i * 2) * g), i * 2)
      }
      this.emit(out ?? b.pcm, b.captureTimeMs)
      // Drop the frames no held batch needs any more.
      const keepFrom = this.batches.length ? Math.floor((this.batches[0] as MicBatch).first / FRAME) : Math.floor(this.micAnalysed / FRAME)
      const drop = Math.min(keepFrom - this.frameBase, this.gains.length)
      if (drop > 0) {
        this.prevGain = this.gains[drop - 1] as number
        this.frames.splice(0, drop)
        this.gains.splice(0, drop)
        this.frameBase += drop
      }
    }
  }
}
