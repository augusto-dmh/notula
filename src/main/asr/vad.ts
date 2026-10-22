// SPDX-License-Identifier: Apache-2.0
// The local engine's voice-activity gate and segmenter. Pure: no Electron, no Node built-ins, so
// it runs inside notula-asr.
//
// A 512-sample hop (32 ms) is speech when its RMS reaches the source's speech threshold.
// A segment opens on speech with up to 8 hops of pre-roll and closes after 25 silent hops
// (800 ms) or at 25 s. Segments with fewer than 6 speech hops are discarded. While a
// segment is open, a partial is offered at most every 31 hops (about 1 s) once 6 speech
// hops are in.
//
// Noise floor: the threshold follows the source's noise floor instead of a fixed
// 0.01; a hop is speech at RMS ≥ clamp(3 × floor, 0.0005, 0.01). The floor is
// - zero while digital silence is recent (at least 6 of the last ~2 s of hops): clean
//   loopback audio often sits at exact zero between phrases, and its speech can peak
//   below 0.01 (measured: a lecture in Edge at peak 0.007, hop RMS ~0.002);
// - otherwise the 10th percentile of the last ~10 s of non-silent hop RMS.
// It never exceeds the old 0.01, so loud audio segments exactly as before. With no floor
// yet (under 1 s of audio and no digital silence), the old 0.01 applies. The worker
// normalizes each segment's gain before decoding (gain.ts); this file only gates.
//
// Quiet speech: the gate also follows the source's recent speech level. Quiet
// system audio (a lecture at player volume 0.25: non-silent hops at p50 -73, p90 -65 dBFS,
// measured) sat under the 0.0005 clamp, so only its loudest hops opened segments. The
// speech level is the 90th percentile of the same ~10 s of non-silent hops. The quiet floor
// is zero while digital silence is recent, else the lowest 5th percentile of the last
// ~30 s (dense speech lifts the 10 s window's 10th percentile into the speech). A source is quiet
// speech when its speech level is under the old 0.01 and at least 12 dB above the quiet
// floor, or, while digital silence is recent, 6 dB above the window's 10th percentile.
// Steady noise spreads ~1 dB, so it never qualifies. For quiet speech:
// - a hop opens or continues a segment at RMS >= max(speech level - 12 dB, 2 x quiet floor,
//   0.0001), capped by the noise-floor threshold (the gate only ever gets lower);
// - hysteresis: once open, a hop still counts as speech down to 6 dB under that, but never
//   below 1.6 x quiet floor or 0.00005, so phrase ends and soft syllables don't close it;
// - a segment past 20 s closes at its next hop under the opening threshold (a pause), so
//   the 25 s cap, which the hysteresis now reaches more often, rarely cuts a word.
// Anything else gates on the noise-floor threshold alone (loud audio, steady noise, the
// first second).

export const SAMPLE_RATE = 16_000
export const HOP_SAMPLES = 512
/** The highest speech threshold: the old fixed gate. */
export const SPEECH_RMS = 0.01
/** The lowest speech threshold, about -66 dBFS. */
export const MIN_SPEECH_RMS = 0.0005
/** Speech is this many times the noise floor (about +9.5 dB). */
export const FLOOR_RATIO = 3
export const FLOOR_PERCENTILE = 0.1
/** About 10 s of hops. */
export const FLOOR_WINDOW_HOPS = 313
/** About 1 s of non-silent hops before the floor is trusted. */
export const FLOOR_MIN_HOPS = 31
/** The speech level is this percentile of the same window. */
export const SPEECH_PERCENTILE = 0.9
/** Quiet speech sits at least this far (12 dB) above the quiet floor… */
export const SPEECH_SPREAD = 4
/** …or, while digital silence is recent, this far (6 dB) above the window's 10th percentile. */
export const SILENCE_SPEECH_SPREAD = 2
/** The quiet floor is the lowest 5th percentile of this many ~1 s samples (~30 s). */
export const QUIET_FLOOR_PERCENTILE = 0.05
export const QUIET_FLOOR_SAMPLES = 30
/** The quiet-speech threshold sits this far (12 dB) under the speech level… */
export const SPEECH_LEVEL_RATIO = 0.25
/** …at least this far above the floor (+6 dB)… */
export const QUIET_FLOOR_RATIO = 2
/** …and never under about -80 dBFS. */
export const QUIET_MIN_RMS = 0.0001
/** Hysteresis: an open segment keeps speech down to this share (-6 dB) of the threshold… */
export const HOLD_RATIO = 0.5
/** …but at least this far above the floor (+4 dB) and about -86 dBFS. */
export const HOLD_FLOOR_RATIO = 1.6
export const HOLD_MIN_RMS = 0.00005
/** About 2 s: the window in which digital silence counts as recent. */
export const RECENT_HOPS = 62
/** This many digitally silent hops in the recent window make the floor zero. */
export const RECENT_SILENT_HOPS = 6
/** Below one s16 step: digital silence, never part of the percentile. */
const DIGITAL_SILENCE_RMS = 1e-5
/** Floor histogram: 1 dB bins from -100 dBFS to 0 dBFS. */
const FLOOR_MIN_DB = -100
const FLOOR_BINS = 101
export const PRE_ROLL_HOPS = 8
export const CLOSE_SILENT_HOPS = 25
export const MAX_SEGMENT_SAMPLES = 25 * SAMPLE_RATE
/** Quiet speech only: past this length a segment closes at the next pause. */
export const SOFT_MAX_SEGMENT_SAMPLES = 20 * SAMPLE_RATE
export const MIN_SPEECH_HOPS = 6
export const PARTIAL_EVERY_HOPS = 31

export interface Segment {
  id: number
  /** Absolute sample index on the worker's clock (skips included). */
  startSample: number
  samples: Float32Array
}

interface Hop {
  start: number
  samples: Float32Array
}

interface OpenSegment {
  id: number
  start: number
  hops: Float32Array[]
  length: number
  speechHops: number
  silentRun: number
  hopsSincePartial: number
}

export interface SegmenterEvents {
  final(seg: Segment): void
  partial(seg: Segment): void
}

function rms(h: Float32Array): number {
  let sum = 0
  for (let i = 0; i < h.length; i++) {
    const v = h[i] as number
    sum += v * v
  }
  return Math.sqrt(sum / h.length)
}

/** The noise floor: zero after recent digital silence, else a low percentile of recent hop RMS (1 dB histogram). */
export class NoiseFloor {
  private readonly ring = new Uint8Array(FLOOR_WINDOW_HOPS)
  private readonly counts = new Uint32Array(FLOOR_BINS)
  private size = 0
  private at = 0
  private readonly recent = new Uint8Array(RECENT_HOPS)
  private recentAt = 0
  private recentSilent = 0
  /** The window's 5th percentile, sampled every ~1 s of non-silent hops, for ~30 s. */
  private readonly lows: number[] = new Array<number>(QUIET_FLOOR_SAMPLES).fill(0)
  private lowsAt = 0
  private lowsSize = 0
  private sinceLow = 0

  add(level: number): void {
    const silent = level >= DIGITAL_SILENCE_RMS ? 0 : 1
    this.recentSilent += silent - (this.recent[this.recentAt] as number)
    this.recent[this.recentAt] = silent
    this.recentAt = (this.recentAt + 1) % RECENT_HOPS
    if (silent) return
    const db = 20 * Math.log10(level)
    const bin = Math.min(FLOOR_BINS - 1, Math.max(0, Math.round(db - FLOOR_MIN_DB)))
    if (this.size === FLOOR_WINDOW_HOPS) (this.counts[this.ring[this.at] as number] as number)--
    else this.size++
    this.counts[bin] = (this.counts[bin] as number) + 1
    this.ring[this.at] = bin
    this.at = (this.at + 1) % FLOOR_WINDOW_HOPS
    if (++this.sinceLow < FLOOR_MIN_HOPS) return
    this.sinceLow = 0
    const low = this.percentile(QUIET_FLOOR_PERCENTILE)
    if (low === null) return
    this.lows[this.lowsAt] = low
    this.lowsAt = (this.lowsAt + 1) % QUIET_FLOOR_SAMPLES
    this.lowsSize = Math.min(QUIET_FLOOR_SAMPLES, this.lowsSize + 1)
  }

  /** A percentile of the window's non-silent hop RMS, or null under ~1 s of them. */
  private percentile(p: number): number | null {
    if (this.size < FLOOR_MIN_HOPS) return null
    const rank = Math.max(1, Math.ceil(this.size * p))
    let seen = 0
    for (let b = 0; b < FLOOR_BINS; b++) {
      seen += this.counts[b] as number
      if (seen >= rank) return 10 ** ((b + FLOOR_MIN_DB) / 20)
    }
    return null
  }

  /** The floor's RMS, or null while nothing is known yet. */
  floor(): number | null {
    if (this.recentSilent >= RECENT_SILENT_HOPS) return 0
    return this.percentile(FLOOR_PERCENTILE)
  }

  /** The recent speech level and the quiet floor when the source carries quiet speech, else null. */
  quietSpeech(): { speech: number; floor: number } | null {
    const speech = this.percentile(SPEECH_PERCENTILE)
    const low = this.percentile(FLOOR_PERCENTILE)
    if (speech === null || low === null || speech >= SPEECH_RMS) return null
    // Dense speech lifts the window's 10th percentile into the speech itself, so the quiet
    // floor is the lowest 5th percentile of the last ~30 s.
    const floor = this.recentSilent >= RECENT_SILENT_HOPS ? 0 : Math.min(this.percentile(QUIET_FLOOR_PERCENTILE) ?? low, ...this.lows.slice(0, this.lowsSize))
    if (floor === 0 ? speech < SILENCE_SPEECH_SPREAD * low : speech < SPEECH_SPREAD * floor) return null
    return { speech, floor }
  }

  /** The noise-floor threshold: clamp(3 × floor, 0.0005, 0.01), or 0.01 before the floor is known. */
  private noiseThreshold(): number {
    const f = this.floor()
    if (f === null) return SPEECH_RMS
    return Math.min(SPEECH_RMS, Math.max(MIN_SPEECH_RMS, FLOOR_RATIO * f))
  }

  /** The speech threshold: the noise-floor one, lowered toward the speech level for quiet speech. */
  threshold(): number {
    const base = this.noiseThreshold()
    const q = this.quietSpeech()
    if (!q) return base
    return Math.min(base, Math.max(SPEECH_LEVEL_RATIO * q.speech, QUIET_FLOOR_RATIO * q.floor, QUIET_MIN_RMS))
  }

  /** The threshold inside an open segment: 6 dB of hysteresis for quiet speech only. */
  holdThreshold(): number {
    const open = this.threshold()
    const q = this.quietSpeech()
    if (!q) return open
    return Math.min(open, Math.max(HOLD_RATIO * open, HOLD_FLOOR_RATIO * q.floor, HOLD_MIN_RMS))
  }
}

function concat(parts: Float32Array[], length: number): Float32Array {
  const out = new Float32Array(length)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export class Segmenter {
  /** Absolute index of the next sample to arrive. */
  private received = 0
  private carry = new Float32Array(0)
  private preRoll: Hop[] = []
  private open: OpenSegment | null = null
  /** End of the last closed segment: pre-roll never reaches back before it. */
  private lastEnd = 0
  private nextId = 0
  private readonly noise = new NoiseFloor()
  private readonly on: SegmenterEvents

  // A plain field rather than a parameter property, so scripts/dev/vad-check.ts runs under Node's type stripping.
  constructor(on: SegmenterEvents) {
    this.on = on
  }

  /** The clock: samples received plus samples skipped. */
  get position(): number {
    return this.received
  }

  push(samples: Float32Array): void {
    if (!samples.length) return
    const startOfBuffer = this.received - this.carry.length
    const buf = this.carry.length ? concat([this.carry, samples], this.carry.length + samples.length) : samples
    this.received += samples.length
    let at = 0
    while (buf.length - at >= HOP_SAMPLES) {
      this.hop({ start: startOfBuffer + at, samples: buf.slice(at, at + HOP_SAMPLES) })
      at += HOP_SAMPLES
    }
    this.carry = buf.slice(at)
  }

  /** A capture gap: the open segment closes and the clock moves on. */
  skip(samples: number): void {
    this.close(true)
    this.carry = new Float32Array(0)
    this.preRoll = []
    this.received += Math.max(0, Math.round(samples))
  }

  /** End of audio: the open segment closes with what it has. */
  flush(): void {
    this.close(true)
  }

  /** Audio before this index is closed: decoded, decoding, or silence. */
  committedSample(): number {
    if (this.open) return this.open.start
    const hopsEnd = this.received - this.carry.length
    return Math.max(this.lastEnd, hopsEnd - PRE_ROLL_HOPS * HOP_SAMPLES, 0)
  }

  isOpen(id: number): boolean {
    return this.open?.id === id
  }

  private hop(h: Hop): void {
    const level = rms(h.samples)
    const open = this.open
    const threshold = this.noise.threshold()
    const speech = level >= (open ? this.noise.holdThreshold() : threshold)
    const pause = !!open && level < threshold && open.length >= SOFT_MAX_SEGMENT_SAMPLES && this.noise.quietSpeech() !== null
    this.noise.add(level)
    if (!open) {
      if (!speech) {
        this.preRoll.push(h)
        if (this.preRoll.length > PRE_ROLL_HOPS) this.preRoll.shift()
        return
      }
      const pre = this.preRoll.filter((p) => p.start >= this.lastEnd)
      this.preRoll = []
      const hops = [...pre.map((p) => p.samples), h.samples]
      this.open = {
        id: this.nextId++,
        start: pre[0]?.start ?? h.start,
        hops,
        length: hops.length * HOP_SAMPLES,
        speechHops: 1,
        silentRun: 0,
        hopsSincePartial: 0
      }
      return
    }
    open.hops.push(h.samples)
    open.length += h.samples.length
    open.hopsSincePartial++
    if (speech) {
      open.speechHops++
      open.silentRun = 0
    } else {
      open.silentRun++
    }
    if (open.silentRun >= CLOSE_SILENT_HOPS || open.length >= MAX_SEGMENT_SAMPLES || pause) {
      this.close(false)
      return
    }
    if (open.speechHops >= MIN_SPEECH_HOPS && open.hopsSincePartial >= PARTIAL_EVERY_HOPS) {
      open.hopsSincePartial = 0
      this.on.partial({ id: open.id, startSample: open.start, samples: concat(open.hops, open.length) })
    }
  }

  private close(withCarry: boolean): void {
    const open = this.open
    if (!open) return
    this.open = null
    if (withCarry && this.carry.length) {
      open.hops.push(this.carry)
      open.length += this.carry.length
      this.carry = new Float32Array(0)
    }
    this.lastEnd = open.start + open.length
    this.preRoll = []
    if (open.speechHops < MIN_SPEECH_HOPS) return
    this.on.final({ id: open.id, startSample: open.start, samples: concat(open.hops, open.length) })
  }
}
